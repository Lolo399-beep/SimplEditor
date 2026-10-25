// =====================================================================
//  Editor de video por proyectos
//  - Importar videos (explorador de archivos)
//  - Frames visibles dentro de cada clip
//  - Reproducción compuesta en un canvas (fila superior = capa superior)
//  - Chroma key automático (verde / azul) con opción manual
//  - Clips arrastrables: arriba/abajo (jerarquía) e izquierda/derecha (tiempo)
// =====================================================================

// --- Constantes del editor ---
const PX_PER_SEC = 40;          // Escala de la línea de tiempo (px por segundo)
const THUMB_H = 58;             // Alto del filmstrip (alto de la fila - bordes)
const MAX_THUMB_W = 16000;      // Límite de ancho del canvas de miniaturas
const PREVIEW_W = 640;          // Resolución interna de la vista previa
const PREVIEW_H = 360;          // (bájala a 480x270 si va lento)
const DRIFT_TOLERANCE = 0.35;   // Segundos de desfase permitidos antes de re-sincronizar un video
const EPS = 0.001;

// Ajustes del chroma key
const CHROMA_MIN_DIFF = 20;     // Diferencia mínima entre el canal clave y los demás
const CHROMA_K1 = 0.22;         // Por debajo: opaco. Entre K1 y K2: semitransparente
const CHROMA_K2 = 0.5;          // Por encima: totalmente transparente

// --- Elementos del DOM ---
const grid = document.getElementById('projectGrid');
const addBtn = document.getElementById('addProjectBtn');

const mainView = document.getElementById('mainView');
const projectDetailView = document.getElementById('projectDetailView');
const currentProjectTitle = document.getElementById('currentProjectTitle');
const backBtn = document.getElementById('backBtn');
const addRowBtn = document.getElementById('addRowBtn');
const rowsContainer = document.getElementById('rowsContainer');
const ruler = document.getElementById('ruler');
const playhead = document.getElementById('playhead');
const timeDisplay = document.getElementById('timeDisplay');

const importBtn = document.getElementById('importBtn');
const fileInput = document.getElementById('fileInput');

const undoBtn = document.getElementById('undoBtn');
const redoBtn = document.getElementById('redoBtn');

const previewCanvas = document.getElementById('previewCanvas');
const videoPlayerContainer = document.getElementById('videoPlayerContainer');
const playBtn = document.getElementById('playBtn');
const pauseBtn = document.getElementById('pauseBtn');
const replayBtn = document.getElementById('replayBtn');
const volumeBtn = document.getElementById('volumeBtn');
const volumeSlider = document.getElementById('volumeSlider');
const fullscreenBtn = document.getElementById('fullscreenBtn');

// Controles extra que solo se ven en pantalla completa
const fsPlayBtn = document.getElementById('fsPlayBtn');
const fsTime = document.getElementById('fsTime');
const fsSeek = document.getElementById('fsSeek');
const fsSeekFill = document.getElementById('fsSeekFill');
const fsSeekThumb = document.getElementById('fsSeekThumb');
const fsSeekTip = document.getElementById('fsSeekTip');

// --- Estado ---
let projects = {};
let currentProjectId = null;
let projectCount = 0;
let draggedRow = null;
let clipSeq = 0;

const currentProject = () => projects[currentProjectId];

// Reloj de la línea de tiempo
const clock = { t: 0, playing: false, last: 0, raf: 0 };
let masterVolume = 1;
let masterMuted = false;
let renderQueued = false;

// Exportación y audio (Web Audio permite mezclar el sonido de los clips dentro del archivo exportado)
let exporting = false;     // true mientras se graba el video
let audioCtx = null;       // Contexto de audio (se crea al exportar, dentro de un clic del usuario)
let speakerGain = null;    // Salida a los parlantes (volumen general; en 0 mientras se exporta)

// =====================================================================
//  Sistema Undo / Redo
// =====================================================================
let undoStack = [];
let redoStack = [];

// Serializa las filas y los clips que contienen
function serializeRows() {
    return Array.from(rowsContainer.children).map(row => ({
        muted: row.classList.contains('muted'),
        locked: row.classList.contains('locked'),
        clips: Array.from(row.children)
            .filter(el => el._clip)
            .map(el => ({
                id: el._clip.id,
                start: el._clip.start,
                muted: !!el._clip.muted,
                locked: !!el._clip.locked
            }))
    }));
}

function recordState() {
    if (!currentProjectId || !projects[currentProjectId]) return;

    const state = {
        rowsWidth: rowsContainer.style.width || '500px',
        rows: serializeRows()
    };

    undoStack.push(JSON.stringify(state));
    redoStack = []; // Limpiar rehacer cuando se realiza una nueva acción
}

function undo() {
    if (undoStack.length <= 1) return; // Mantener al menos el estado inicial

    const currentState = undoStack.pop();
    redoStack.push(currentState);

    applyState(JSON.parse(undoStack[undoStack.length - 1]));
}

function redo() {
    if (redoStack.length === 0) return;

    const nextState = redoStack.pop();
    undoStack.push(nextState);

    applyState(JSON.parse(nextState));
}

function applyState(state) {
    setTimelineWidth(parseInt(state.rowsWidth, 10) || 500);
    rowsContainer.innerHTML = '';
    buildRows(state.rows, currentProject());
    saveCurrentProjectRows();
    refreshPreview();
}

// Guarda en el proyecto y registra un paso de historial
function commit() {
    saveCurrentProjectRows();
    recordState();
}

// Atajos de teclado
document.addEventListener('keydown', (e) => {
    if (!currentProjectId || exporting) return; // Solo dentro de un proyecto (y no mientras se exporta)

    const key = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && key === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo(); else undo();
    } else if ((e.ctrlKey || e.metaKey) && key === 'y') {
        e.preventDefault();
        redo();
    } else if (e.code === 'Space' && !/INPUT|TEXTAREA|BUTTON/.test(e.target.tagName)) {
        e.preventDefault();
        if (clock.playing) pause(); else play();
    }
});

undoBtn.addEventListener('click', undo);
redoBtn.addEventListener('click', redo);

// =====================================================================
//  Navegación
// =====================================================================
function showMainView(pushToHistory = true) {
    stopPlayback();
    saveCurrentProjectRows();

    currentProjectId = null;
    projectDetailView.classList.add('hidden');
    mainView.classList.remove('hidden');

    if (pushToHistory && location.hash !== '') {
        history.pushState({ view: 'main' }, '', window.location.pathname);
    }
}

function openProjectView(projectId, pushToHistory = true) {
    currentProjectId = projectId;
    const project = projects[projectId];

    currentProjectTitle.textContent = project.name || 'Sin título';

    // Reiniciar historial y reloj para el proyecto actual
    undoStack = [];
    redoStack = [];
    clock.t = 0;
    clock.playing = false;

    loadProjectRows(project);
    recordState(); // Estado inicial

    mainView.classList.add('hidden');
    projectDetailView.classList.remove('hidden');

    refreshPreview();

    if (pushToHistory) {
        history.pushState({ view: 'project', id: projectId }, `#project-${projectId}`);
    }
}

backBtn.addEventListener('click', () => {
    showMainView(true);
});

window.addEventListener('popstate', (e) => {
    if (e.state && e.state.view === 'project') {
        openProjectView(e.state.id, false);
    } else {
        showMainView(false);
    }
});

// =====================================================================
//  Proyectos
// =====================================================================
addBtn.addEventListener('click', () => {
    projectCount++;
    const id = `proj_${Date.now()}`;

    projects[id] = {
        id: id,
        name: `Proyecto ${projectCount}`,
        rowsWidth: '500px',
        rowsData: [],
        clips: {}          // Videos importados: id -> clip
    };

    const card = document.createElement('div');
    card.className = 'project-card';

    const box = document.createElement('div');
    box.className = 'project-box';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'project-name';
    input.value = projects[id].name;

    input.addEventListener('input', () => {
        projects[id].name = input.value;
    });

    box.addEventListener('click', () => {
        openProjectView(id, true);
    });

    input.addEventListener('click', (e) => {
        e.stopPropagation();
    });

    box.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showProjectContextMenu(e.clientX, e.clientY, id, card);
    });

    card.appendChild(box);
    card.appendChild(input);
    grid.appendChild(card);
});

// =====================================================================
//  Filas por proyecto
// =====================================================================
function saveCurrentProjectRows() {
    if (!currentProjectId || !projects[currentProjectId]) return;

    projects[currentProjectId].rowsWidth = rowsContainer.style.width || '500px';
    projects[currentProjectId].rowsData = serializeRows();
}

function loadProjectRows(project) {
    rowsContainer.innerHTML = '';
    setTimelineWidth(parseInt(project.rowsWidth, 10) || 500);
    buildRows(project.rowsData, project);
}

// Reconstruye filas y clips a partir de datos guardados
function buildRows(rowsData, project) {
    (rowsData || []).forEach(data => {
        const row = createRowElement();
        if (data.muted) row.classList.add('muted');
        if (data.locked) row.classList.add('locked');

        (data.clips || []).forEach(c => {
            const clip = project.clips[c.id];
            if (!clip) return;
            clip.start = c.start;
            clip.muted = !!c.muted;
            clip.locked = !!c.locked;
            placeClip(row, clip);
        });
    });
}

addRowBtn.addEventListener('click', () => {
    if (!currentProjectId) return;
    createRowElement();
    commit();
});

function createRowElement(atTop = false) {
    const row = document.createElement('div');
    row.className = 'row-item';

    // Agarradera para reordenar la fila (cambia la jerarquía de capas)
    const grip = document.createElement('div');
    grip.className = 'row-grip';
    grip.title = 'Arrastra para cambiar la jerarquía (arriba = por encima)';
    grip.textContent = '⋮⋮';
    grip.addEventListener('mousedown', () => { row.draggable = true; });
    grip.addEventListener('mouseup', () => { row.draggable = false; });

    const handleLeft = document.createElement('div');
    handleLeft.className = 'row-handle left';

    const handleRight = document.createElement('div');
    handleRight.className = 'row-handle right';

    row.appendChild(grip);
    row.appendChild(handleLeft);
    row.appendChild(handleRight);

    row.addEventListener('dragstart', (e) => {
        draggedRow = row;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', 'row');
        setTimeout(() => row.classList.add('dragging'), 0);
    });

    row.addEventListener('dragend', () => {
        row.draggable = false;
        row.classList.remove('dragging');
        draggedRow = null;
        commit();
        refreshPreview();
    });

    row.addEventListener('dragover', (e) => {
        if (!draggedRow) return;
        e.preventDefault();
        const targetRow = e.target.closest('.row-item');
        if (targetRow && targetRow !== draggedRow) {
            const rect = targetRow.getBoundingClientRect();
            const midpoint = rect.top + rect.height / 2;
            if (e.clientY < midpoint) {
                rowsContainer.insertBefore(draggedRow, targetRow);
            } else {
                rowsContainer.insertBefore(draggedRow, targetRow.nextSibling);
            }
        }
    });

    row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showContextMenu(e.clientX, e.clientY, row);
    });

    setupResizeHandlers(handleLeft, handleRight);

    if (atTop) {
        rowsContainer.insertBefore(row, rowsContainer.firstChild);
    } else {
        rowsContainer.appendChild(row);
    }
    return row;
}

// Redimensionamiento de la línea de tiempo (Estiramiento y Acortamiento)
function setupResizeHandlers(leftHandle, rightHandle) {
    const initResize = (e, direction) => {
        e.preventDefault();
        const startX = e.clientX;
        const startWidth = rowsContainer.offsetWidth;

        const onMouseMove = (moveEvent) => {
            const deltaX = moveEvent.clientX - startX;
            const newWidth = direction === 'right' ? startWidth + deltaX : startWidth - deltaX;
            const minWidth = Math.ceil(contentEnd() * PX_PER_SEC) + 20; // No cortar clips

            if (newWidth > 100) {
                setTimelineWidth(Math.max(newWidth, minWidth));
            }
        };

        const onMouseUp = () => {
            commit(); // Registra el cambio de estiramiento/acortamiento en el historial
            window.removeEventListener('mousemove', onMouseMove);
            window.removeEventListener('mouseup', onMouseUp);
        };

        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', onMouseUp);
    };

    leftHandle.addEventListener('mousedown', (e) => initResize(e, 'left'));
    rightHandle.addEventListener('mousedown', (e) => initResize(e, 'right'));
}

// =====================================================================
//  Ancho de la línea de tiempo y regla
// =====================================================================
let timelineWidthPx = 500; // Ancho actual de la tabla (el cabezal nunca pasa de aquí)

// Segundo máximo al que puede llegar el cabezal = final de la tabla
function timelineSeconds() {
    return timelineWidthPx / PX_PER_SEC;
}

function setTimelineWidth(px) {
    px = Math.max(100, Math.round(px));
    timelineWidthPx = px;
    rowsContainer.style.width = `${px}px`;
    ruler.style.width = `${px}px`;
    renderRuler(px);

    // Si se acortó la tabla y el cabezal quedó afuera, lo trae hasta el nuevo final
    if (clock.t > timelineSeconds()) {
        clock.t = timelineSeconds();
        if (clock.playing) clock.last = performance.now();
        refreshPreview();
    }
}

function renderRuler(px) {
    const secs = Math.ceil(px / PX_PER_SEC);
    let html = '';
    for (let s = 0; s <= secs; s++) {
        const major = s % 5 === 0;
        const label = major ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : '';
        html += `<span class="tick${major ? ' major' : ''}" data-label="${label}" style="left:${s * PX_PER_SEC + 1}px"></span>`;
    }
    ruler.innerHTML = html;
}

// Amplía la línea de tiempo si algún clip se sale por la derecha
function fitTimeline() {
    const needed = Math.ceil(contentEnd() * PX_PER_SEC) + 20;
    if (needed > rowsContainer.offsetWidth) setTimelineWidth(needed);
}

// Click / arrastre sobre la regla para moverse en el tiempo
ruler.addEventListener('pointerdown', (e) => {
    if (!currentProjectId) return;
    e.preventDefault();

    const seekTo = (ev) => {
        const rect = ruler.getBoundingClientRect();
        seek((ev.clientX - rect.left - 1) / PX_PER_SEC);
    };
    const onUp = () => {
        window.removeEventListener('pointermove', seekTo);
        window.removeEventListener('pointerup', onUp);
    };

    seekTo(e);
    window.addEventListener('pointermove', seekTo);
    window.addEventListener('pointerup', onUp);
});

// =====================================================================
//  Menús contextuales
// =====================================================================
const menus = [];

function createMenu(html) {
    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.innerHTML = html;
    document.body.appendChild(menu);
    menus.push(menu);
    return menu;
}

function hideMenus() {
    menus.forEach(m => { m.style.display = 'none'; });
}

function openMenu(menu, x, y) {
    hideMenus();
    menu.style.display = 'block';
    const w = menu.offsetWidth;
    const h = menu.offsetHeight;
    menu.style.left = `${Math.max(0, Math.min(x, window.innerWidth - w - 4))}px`;
    menu.style.top = `${Math.max(0, Math.min(y, window.innerHeight - h - 4))}px`;
}

document.addEventListener('click', hideMenus);

// --- Menú de filas ---
const contextMenu = createMenu(`
    <div class="context-menu-item" id="muteRowOption">Silenciar</div>
    <div class="context-menu-item" id="unmuteRowOption">Sonorizar</div>
    <div class="context-menu-item" id="lockRowOption">Bloquear</div>
    <div class="context-menu-item danger" id="deleteRowOption">Borrar</div>
`);

let rowTarget = null;

function showContextMenu(x, y, row) {
    rowTarget = row;

    const muted = row.classList.contains('muted');
    document.getElementById('muteRowOption').style.display = muted ? 'none' : 'block';
    document.getElementById('unmuteRowOption').style.display = muted ? 'block' : 'none';
    document.getElementById('lockRowOption').textContent =
        row.classList.contains('locked') ? 'Desbloquear' : 'Bloquear';

    openMenu(contextMenu, x, y);
}

document.getElementById('muteRowOption').addEventListener('click', () => {
    if (rowTarget) {
        rowTarget.classList.add('muted');
        commit();
        refreshPreview();
    }
});

document.getElementById('unmuteRowOption').addEventListener('click', () => {
    if (rowTarget) {
        rowTarget.classList.remove('muted');
        commit();
        refreshPreview();
    }
});

document.getElementById('lockRowOption').addEventListener('click', () => {
    if (rowTarget) {
        rowTarget.classList.toggle('locked');
        commit();
    }
});

document.getElementById('deleteRowOption').addEventListener('click', () => {
    if (rowTarget) {
        rowTarget.remove();
        rowTarget = null;
        commit(); // Permite recuperar la fila eliminada con Ctrl+Z
        refreshPreview();
    }
});

// --- Menú de proyectos ---
const projectContextMenu = createMenu(
    `<div class="context-menu-item danger" id="deleteProjectOption">Borrar proyecto</div>`
);

let projectToDeleteId = null;
let cardToDelete = null;

function showProjectContextMenu(x, y, projectId, cardElement) {
    projectToDeleteId = projectId;
    cardToDelete = cardElement;
    openMenu(projectContextMenu, x, y);
}

document.getElementById('deleteProjectOption').addEventListener('click', () => {
    if (projectToDeleteId && cardToDelete) {
        Object.values(projects[projectToDeleteId].clips).forEach(disposeClip);
        delete projects[projectToDeleteId];
        cardToDelete.remove();
        projectToDeleteId = null;
        cardToDelete = null;
    }
});

// --- Menú de clips ---
const clipMenu = createMenu(`
    <div class="context-menu-item" data-action="toggle-mute">Silenciar</div>
    <div class="context-menu-item" data-action="toggle-lock">Bloquear</div>
    <div class="context-menu-separator"></div>
    <div class="context-menu-item" data-chroma="green">Quitar fondo verde</div>
    <div class="context-menu-item" data-chroma="blue">Quitar fondo azul</div>
    <div class="context-menu-item" data-chroma="none">No quitar fondo</div>
    <div class="context-menu-item danger" data-action="delete">Eliminar clip</div>
`);

let clipTarget = null;

function showClipContextMenu(x, y, clip) {
    clipTarget = clip;

    const muteItem = clipMenu.querySelector('[data-action="toggle-mute"]');
    const lockItem = clipMenu.querySelector('[data-action="toggle-lock"]');
    muteItem.textContent = clip.muted ? 'Sonorizar' : 'Silenciar';
    lockItem.textContent = clip.locked ? 'Desbloquear' : 'Bloquear';

    // Con el clip bloqueado solo queda disponible "Desbloquear"
    clipMenu.querySelectorAll('.context-menu-item').forEach(item => {
        item.classList.toggle('disabled', !!clip.locked && item !== lockItem);
    });

    clipMenu.querySelectorAll('[data-chroma]').forEach(item => {
        item.classList.toggle('checked', item.dataset.chroma === clip.chroma);
    });
    openMenu(clipMenu, x, y);
}

clipMenu.addEventListener('click', (e) => {
    const item = e.target.closest('.context-menu-item');
    if (!item || !clipTarget || item.classList.contains('disabled')) return;

    if (item.dataset.chroma) {
        setClipChroma(clipTarget, item.dataset.chroma);
    } else if (item.dataset.action === 'toggle-mute') {
        setClipMuted(clipTarget, !clipTarget.muted);
    } else if (item.dataset.action === 'toggle-lock') {
        setClipLocked(clipTarget, !clipTarget.locked);
    } else if (item.dataset.action === 'delete') {
        deleteClip(clipTarget);
    }
});

// =====================================================================
//  Clips: importar, crear elemento, miniaturas
// =====================================================================
importBtn.addEventListener('click', () => {
    if (!currentProjectId) return;
    fileInput.click(); // Abre el explorador de archivos
});

fileInput.addEventListener('change', async () => {
    const files = Array.from(fileInput.files);
    fileInput.value = ''; // Permite volver a elegir el mismo archivo

    const failed = [];
    for (const file of files) {
        const ok = await importVideoFile(file);
        if (!ok) failed.push(file.name);
    }
    if (failed.length) {
        alert(`El navegador no pudo cargar estos archivos (formato o códec no compatible):\n\n${failed.join('\n')}`);
    }
});

// Primera fila vacía (de arriba hacia abajo) que no esté bloqueada
function findEmptyRow() {
    return Array.from(rowsContainer.children).find(row =>
        !row.classList.contains('locked') &&
        !Array.from(row.children).some(el => el._clip)
    );
}

async function importVideoFile(file) {
    const projectId = currentProjectId;
    if (!projectId) return false;

    const clip = await loadClip(file);
    if (!clip) return false;

    // Si el usuario salió del proyecto mientras cargaba, se descarta
    if (projectId !== currentProjectId) {
        disposeClip(clip);
        return true;
    }

    currentProject().clips[clip.id] = clip;
    if (audioCtx) ensureAudioGraph(); // Si el audio ya está activo, conecta también el clip nuevo

    // Fila vacía si hay; si no, se crea una nueva ARRIBA (queda por encima de las demás)
    const row = findEmptyRow() || createRowElement(true);
    clip.start = 0;
    placeClip(row, clip);
    fitTimeline();
    commit();

    queueThumbnails(clip);
    refreshPreview();
    return true;
}

// Carga el archivo en un <video> y devuelve el objeto clip (o null si falla)
function loadClip(file) {
    return new Promise((resolve) => {
        const url = URL.createObjectURL(file);
        const video = document.createElement('video');
        video.preload = 'auto';
        video.playsInline = true;

        const fail = () => {
            video.removeAttribute('src');
            URL.revokeObjectURL(url);
            resolve(null);
        };

        video.addEventListener('error', fail, { once: true });
        video.addEventListener('loadeddata', () => {
            if (!isFinite(video.duration) || video.duration <= 0 || !video.videoWidth) {
                fail();
                return;
            }

            // Al terminar un salto en el tiempo, repinta la vista previa si está en pausa
            video.addEventListener('seeked', () => {
                if (!clock.playing && currentProjectId) requestRender();
            });

            resolve({
                id: `clip_${Date.now()}_${++clipSeq}`,
                name: file.name,
                url,
                video,
                duration: video.duration,
                aspect: video.videoWidth / video.videoHeight,
                start: 0,                // Segundo en que aparece en la línea de tiempo
                chroma: 'none',          // 'none' | 'green' | 'blue'
                chromaManual: false,
                muted: false,            // Silenciado individualmente
                locked: false,           // Bloqueado: no se puede configurar ni mover
                el: null,
                thumbs: null,
                badge: null
            });
        }, { once: true });

        video.src = url;
    });
}

function disposeClip(clip) {
    if (clip.gainNode) { try { clip.gainNode.disconnect(); } catch (e) {} }
    if (clip.audioSource) { try { clip.audioSource.disconnect(); } catch (e) {} }
    clip.video.pause();
    clip.video.removeAttribute('src');
    clip.video.load();
    URL.revokeObjectURL(clip.url);
}

function createClipElement(clip) {
    const el = document.createElement('div');
    el.className = 'clip';
    el.title = clip.name;
    el.style.width = `${clip.duration * PX_PER_SEC}px`;
    el._clip = clip;
    clip.el = el;

    // Canvas donde se dibujan los frames (filmstrip)
    const thumbs = document.createElement('canvas');
    thumbs.width = Math.min(MAX_THUMB_W, Math.max(1, Math.ceil(clip.duration * PX_PER_SEC)));
    thumbs.height = THUMB_H;
    const tctx = thumbs.getContext('2d');
    tctx.fillStyle = '#1a1a1a';
    tctx.fillRect(0, 0, thumbs.width, thumbs.height);
    clip.thumbs = thumbs;

    const label = document.createElement('span');
    label.className = 'clip-label';
    label.textContent = clip.name;

    const badge = document.createElement('span');
    badge.className = 'clip-badge';
    clip.badge = badge;

    el.append(thumbs, label, badge);
    updateClipBadge(clip);

    setupClipDrag(clip);

    el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation(); // Evita que se abra el menú de la fila
        showClipContextMenu(e.clientX, e.clientY, clip);
    });

    return el;
}

// Coloca el clip dentro de una fila en su posición de tiempo
function placeClip(row, clip) {
    if (!clip.el) createClipElement(clip);
    clip.el.style.left = `${clip.start * PX_PER_SEC}px`;
    row.appendChild(clip.el);
}

function deleteClip(clip) {
    const row = clip.el.parentElement;
    if (clip.locked || (row && row.classList.contains('locked'))) return;
    clip.video.pause();
    clip.el.remove(); // El clip sigue guardado, así Ctrl+Z puede recuperarlo
    commit();
    refreshPreview();
}

// Actualiza la etiqueta de la esquina del clip y su aspecto de bloqueado
function updateClipBadge(clip) {
    const parts = [];
    if (clip.chroma === 'green') parts.push('Pantalla verde');
    if (clip.chroma === 'blue') parts.push('Pantalla azul');
    if (clip.muted) parts.push('Silenciado');
    if (clip.locked) parts.push('Bloqueado');

    clip.badge.textContent = parts.join(' · ');
    clip.el.classList.toggle('locked', !!clip.locked);
}

function setClipMuted(clip, muted) {
    if (clip.locked) return; // Un clip bloqueado no se puede configurar
    clip.muted = muted;
    updateClipBadge(clip);
    commit();
    syncClips();
}

function setClipLocked(clip, locked) {
    clip.locked = locked;
    updateClipBadge(clip);
    commit();
}

function setClipChroma(clip, mode) {
    if (clip.locked) return; // Un clip bloqueado no se puede configurar
    clip.chroma = mode;
    clip.chromaManual = true; // Desactiva la detección automática
    updateClipBadge(clip);
    requestRender();
}

// --- Miniaturas (se generan de a un video a la vez) ---
let thumbQueue = Promise.resolve();

function queueThumbnails(clip) {
    thumbQueue = thumbQueue.then(() => buildThumbnails(clip)).catch(() => {});
}

// --- Solución: Aumentar el tiempo de espera y manejar reintentos en el seek ---
function waitFor(target, eventName, ms = 10000) {
    return new Promise((resolve) => {
        let settled = false;
        const done = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            target.removeEventListener(eventName, done);
            target.removeEventListener('error', done);
            resolve();
        };
        const timer = setTimeout(done, ms);
        target.addEventListener(eventName, done, { once: true });
        target.addEventListener('error', done, { once: true });
    });
}

async function buildThumbnails(clip) {
    // Se usa un video aparte para no interferir con la reproducción
    const tv = document.createElement('video');
    tv.muted = true;
    tv.preload = 'auto';
    tv.src = clip.url;
    await waitFor(tv, 'loadeddata');

    const canvas = clip.thumbs;
    const ctx = canvas.getContext('2d');
    const tileW = Math.max(16, Math.round(canvas.height * clip.aspect));
    const tiles = Math.ceil(canvas.width / tileW);

    for (let i = 0; i < tiles; i++) {
        if (tv.readyState < 2) break;

        const frac = Math.min(0.999, (i * tileW + tileW / 2) / canvas.width);
        tv.currentTime = Math.max(0.01, Math.min(clip.duration - 0.05, frac * clip.duration));
        await waitFor(tv, 'seeked');

        ctx.drawImage(tv, i * tileW, 0, tileW, canvas.height);

        // Con el primer frame se detecta si el video tiene pantalla verde o azul
        if (i === 0 && !clip.chromaManual && !clip.locked) {
            const mode = detectChromaBackground(tv);
            if (mode !== 'none') {
                clip.chroma = mode;
                updateClipBadge(clip);
                requestRender();
            }
        }
    }

    tv.removeAttribute('src');
    tv.load();
}

// Mira el borde del frame: si es mayormente verde o azul intenso, es una pantalla de chroma
function detectChromaBackground(video) {
    const W = 64, H = 36;
    const probe = document.createElement('canvas');
    probe.width = W;
    probe.height = H;
    const ctx = probe.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(video, 0, 0, W, H);
    const d = ctx.getImageData(0, 0, W, H).data;

    let green = 0, blue = 0, total = 0;
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            if (!(x < 4 || x >= W - 4 || y < 3 || y >= H - 3)) continue;
            const i = (y * W + x) * 4;
            const r = d[i], g = d[i + 1], b = d[i + 2];
            total++;
            if (g > 80 && g > r * 1.35 && g > b * 1.35) green++;
            else if (b > 80 && b > r * 1.4 && b > g * 1.25) blue++;
        }
    }

    if (green / total > 0.6) return 'green';
    if (blue / total > 0.6) return 'blue';
    return 'none';
}

// =====================================================================
//  Arrastrar clips (vertical = jerarquía, horizontal = tiempo)
// =====================================================================
function clipsInRow(row, except) {
    return Array.from(row.children)
        .filter(el => el._clip && el._clip !== except)
        .map(el => el._clip);
}

function overlapsAny(row, clip, start) {
    const end = start + clip.duration;
    return clipsInRow(row, clip).some(o =>
        start < o.start + o.duration - EPS && end > o.start + EPS
    );
}

// Posición libre más cercana a la deseada (los clips de una misma fila no se pisan)
function findFreeStart(row, clip, desired) {
    desired = Math.max(0, desired);
    if (!overlapsAny(row, clip, desired)) return desired;

    const candidates = [0];
    clipsInRow(row, clip).forEach(o => {
        candidates.push(o.start + o.duration, o.start - clip.duration);
    });

    let best = null;
    for (const c of candidates) {
        if (c < 0 || overlapsAny(row, clip, c)) continue;
        if (best === null || Math.abs(c - desired) < Math.abs(best - desired)) best = c;
    }
    return best === null ? desired : best;
}

function rowFromPoint(y) {
    const rows = Array.from(rowsContainer.children);
    if (!rows.length) return null;
    for (const r of rows) {
        const b = r.getBoundingClientRect();
        if (y >= b.top && y < b.bottom) return r;
    }
    return y < rows[0].getBoundingClientRect().top ? rows[0] : rows[rows.length - 1];
}

function setupClipDrag(clip) {
    const el = clip.el;

    el.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        const homeRow = el.parentElement;
        if (!homeRow || homeRow.classList.contains('locked') || clip.locked) return;

        e.preventDefault();
        hideMenus();

        const startX = e.clientX;
        const startY = e.clientY;
        const originStart = clip.start;
        let moved = false;

        const onMove = (ev) => {
            if (!moved) {
                if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 3) return;
                moved = true;
                el.classList.add('dragging');
            }

            // Vertical: cambia de fila (y por lo tanto de capa)
            const target = rowFromPoint(ev.clientY);
            if (target && target !== el.parentElement && !target.classList.contains('locked')) {
                target.appendChild(el);
            }

            // Horizontal: cambia el segundo en el que aparece
            clip.start = Math.max(0, originStart + (ev.clientX - startX) / PX_PER_SEC);
            el.style.left = `${clip.start * PX_PER_SEC}px`;
            el.classList.toggle('invalid', overlapsAny(el.parentElement, clip, clip.start));
        };

        const onUp = () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            window.removeEventListener('pointercancel', onUp);
            el.classList.remove('dragging', 'invalid');
            if (!moved) return;

            const row = el.parentElement;
            clip.start = findFreeStart(row, clip, clip.start);
            el.style.left = `${clip.start * PX_PER_SEC}px`;

            if (row === homeRow && Math.abs(clip.start - originStart) < EPS) return;

            fitTimeline();
            commit();
            refreshPreview();
        };

        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onUp);
    });
}

// =====================================================================
//  Reproducción y composición
// =====================================================================
const pctx = previewCanvas.getContext('2d');
const scratch = document.createElement('canvas');
scratch.width = PREVIEW_W;
scratch.height = PREVIEW_H;
const sctx = scratch.getContext('2d', { willReadFrequently: true });

// Recorre los clips de abajo hacia arriba (la fila superior es la última = queda encima)
function forEachClipBottomUp(callback) {
    const rows = Array.from(rowsContainer.children);
    for (let i = rows.length - 1; i >= 0; i--) {
        for (const el of rows[i].children) {
            if (el._clip) callback(el._clip, rows[i]);
        }
    }
}

// Segundo en el que termina el último clip
function contentEnd() {
    let end = 0;
    forEachClipBottomUp(clip => { end = Math.max(end, clip.start + clip.duration); });
    return end;
}

// ¿Hay algún clip activo cuyo video todavía no tiene un frame listo? (está buscando / cargando)
function hasUnreadyActiveClip() {
    let unready = false;
    forEachClipBottomUp((clip) => {
        const local = clock.t - clip.start;
        if (local < 0 || local >= clip.duration) return;
        const v = clip.video;
        if (v.seeking || v.readyState < 2 || !v.videoWidth) unready = true;
    });
    return unready;
}

// Reemplaza la función render() por esta versión que soporta relaciones de aspecto dinámicas:
function render() {
    renderQueued = false;

    const canvasW = previewCanvas.width;
    const canvasH = previewCanvas.height;

    pctx.fillStyle = '#000000';
    pctx.fillRect(0, 0, canvasW, canvasH);
    if (!currentProjectId) return;

    forEachClipBottomUp((clip) => {
        const local = clock.t - clip.start;
        if (local < 0 || local >= clip.duration) return;

        const v = clip.video;
        if (v.readyState < 2 || !v.videoWidth) return;

        // Ajuste "contain" proporcional a la nueva dimensión del canvas
        const s = Math.min(canvasW / v.videoWidth, canvasH / v.videoHeight);
        const w = Math.max(1, Math.round(v.videoWidth * s));
        const h = Math.max(1, Math.round(v.videoHeight * s));
        const x = Math.round((canvasW - w) / 2);
        const y = Math.round((canvasH - h) / 2);

        if (clip.chroma === 'none') {
            pctx.drawImage(v, x, y, w, h);
        } else {
            sctx.clearRect(0, 0, canvasW, canvasH);
            sctx.drawImage(v, x, y, w, h);
            applyChromaKey(sctx, x, y, w, h, clip.chroma);
            pctx.drawImage(scratch, 0, 0);
        }
    });
}

function requestRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(render);
}

// Quita el fondo verde o azul volviendo transparentes los píxeles dominados por ese canal
function applyChromaKey(ctx, x, y, w, h, mode) {
    const img = ctx.getImageData(x, y, w, h);
    const d = img.data;

    const kc = mode === 'green' ? 1 : 2;   // Canal clave
    const o1 = 0;                          // Rojo siempre es "otro" canal
    const o2 = mode === 'green' ? 2 : 1;   // El restante

    for (let i = 0; i < d.length; i += 4) {
        const key = d[i + kc];
        const a = d[i + o1];
        const b = d[i + o2];
        const other = a > b ? a : b;
        const diff = key - other;

        if (diff > CHROMA_MIN_DIFF) {
            const k = diff / key;
            if (k >= CHROMA_K2) {
                d[i + 3] = 0;                                         // Fondo
            } else {
                if (k > CHROMA_K1) {
                    d[i + 3] = d[i + 3] * (CHROMA_K2 - k) / (CHROMA_K2 - CHROMA_K1); // Borde suave
                }
                d[i + kc] = other;                                    // Quita el reflejo verde/azul
            }
        }
    }

    ctx.putImageData(img, x, y);
}

// Pone cada video en el punto correcto: reproduce los activos, pausa el resto
function syncClips() {
    if (!currentProjectId) return;

    // Volumen general: solo afecta a los parlantes, nunca a lo que se graba al exportar
    if (speakerGain) speakerGain.gain.value = exporting ? 0 : (masterMuted ? 0 : masterVolume);
    const tolerance = exporting ? 0.6 : DRIFT_TOLERANCE; // Al exportar se evitan saltos innecesarios

    for (const clip of Object.values(currentProject().clips)) {
        const v = clip.video;

        if (!clip.el || !clip.el.isConnected) { // Clip eliminado o fuera de pantalla
            if (!v.paused) v.pause();
            continue;
        }

        const row = clip.el.parentElement;
        const local = clock.t - clip.start;
        const active = local >= 0 && local < clip.duration;

        if (!active) {
            if (!v.paused) v.pause();
            // Deja listo el primer frame para cuando llegue su momento
            if (local < 0 && v.currentTime > 0.05 && !v.seeking) v.currentTime = 0;
            continue;
        }

        const silent = clip.muted || row.classList.contains('muted');
        if (clip.gainNode) {
            // Con el audio mezclado por Web Audio, el silencio se controla con la ganancia del clip
            const g = silent ? 0 : 1;
            if (clip.gainNode.gain.value !== g) clip.gainNode.gain.value = g;
            if (v.muted) v.muted = false;
            if (v.volume !== 1) v.volume = 1;
        } else {
            const wantMuted = masterMuted || silent;
            if (v.muted !== wantMuted) v.muted = wantMuted;
            if (v.volume !== masterVolume) v.volume = masterVolume;
        }

        if (clock.playing) {
            if (Math.abs(v.currentTime - local) > tolerance) v.currentTime = local;
            if (v.paused) v.play().catch(() => {});
        } else {
            if (!v.paused) v.pause();
            if (Math.abs(v.currentTime - local) > 0.03) v.currentTime = local;
        }
    }
}

function formatTime(t) {
    const tenths = Math.round(Math.max(0, t) * 10);
    const m = Math.floor(tenths / 600);
    const s = Math.floor((tenths % 600) / 10);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${tenths % 10}`;
}

function updatePlayhead() {
    // La línea roja (2px de ancho) nunca se sale del borde derecho de la tabla
    const x = Math.min(clock.t * PX_PER_SEC + 1, timelineWidthPx - 1);
    playhead.style.left = `${x}px`;
    timeDisplay.textContent = `${formatTime(clock.t)} / ${formatTime(contentEnd())}`;
    updateFullscreenUI();
}

function refreshPreview() {
    syncClips();
    render();
    updatePlayhead();
}

function tick(ts) {
    if (!clock.playing) return;

    clock.t += Math.max(0, (ts - clock.last) / 1000);
    clock.last = ts;

    const end = contentEnd();
    if (clock.t >= end) {
        clock.t = Math.max(0, end - 0.001); // Se queda en el último frame
        pause();
        return;
    }

    syncClips();
    render();
    updatePlayhead();
    clock.raf = requestAnimationFrame(tick);
}

function play() {
    if (!currentProjectId) return;
    const end = contentEnd();
    if (end <= 0 || clock.playing) return;

    if (clock.t >= end - 0.01) clock.t = 0; // Si estaba al final, empieza de nuevo

    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();

    clock.playing = true;
    clock.last = performance.now();
    syncClips();
    clock.raf = requestAnimationFrame(tick);
    updateFullscreenUI();
    showFsControls(); // Inicia el conteo para ocultar los controles en pantalla completa
}

function pause() {
    clock.playing = false;
    cancelAnimationFrame(clock.raf);
    videoPlayerContainer.classList.remove('idle'); // En pausa los controles siempre se ven
    refreshPreview();
}

function replay() {
    if (!currentProjectId) return;
    pause();
    clock.t = 0;
    play();
}

function seek(t) {
    clock.t = Math.min(Math.max(0, t), timelineSeconds()); // Entre 0 y el final de la tabla
    if (clock.playing) clock.last = performance.now();
    refreshPreview();
}

// Detiene todo (al salir del proyecto)
function stopPlayback() {
    clock.playing = false;
    cancelAnimationFrame(clock.raf);
    if (currentProjectId && projects[currentProjectId]) {
        Object.values(projects[currentProjectId].clips).forEach(c => c.video.pause());
    }
}

playBtn.addEventListener('click', play);
pauseBtn.addEventListener('click', pause);
replayBtn.addEventListener('click', replay);

// --- Volumen ---
volumeSlider.addEventListener('input', (e) => {
    masterVolume = parseFloat(e.target.value);
    masterMuted = masterVolume === 0;
    syncClips();
});

volumeBtn.addEventListener('click', () => {
    masterMuted = !masterMuted;
    if (!masterMuted && masterVolume === 0) masterVolume = 1;
    volumeSlider.value = masterMuted ? 0 : masterVolume;
    syncClips();
});

// --- Pantalla completa ---
fullscreenBtn.addEventListener('click', () => {
    if (!document.fullscreenElement && !document.webkitFullscreenElement) {
        if (videoPlayerContainer.requestFullscreen) {
            videoPlayerContainer.requestFullscreen();
        } else if (videoPlayerContainer.webkitRequestFullscreen) { /* Safari */
            videoPlayerContainer.webkitRequestFullscreen();
        } else if (videoPlayerContainer.msRequestFullscreen) { /* IE11 */
            videoPlayerContainer.msRequestFullscreen();
        }
    } else if (document.exitFullscreen) {
        document.exitFullscreen();
    } else if (document.webkitExitFullscreen) {
        document.webkitExitFullscreen();
    }
});

// Marca el contenedor cuando entra / sale de pantalla completa (el CSS usa esta clase)
function onFullscreenChange() {
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    videoPlayerContainer.classList.toggle('is-fullscreen', fsEl === videoPlayerContainer);
    showFsControls();
    updateFullscreenUI();
}
document.addEventListener('fullscreenchange', onFullscreenChange);
document.addEventListener('webkitfullscreenchange', onFullscreenChange);

// =====================================================================
//  Controles de pantalla completa (estilo YouTube)
//  - Botón play / pausa
//  - Barra para ir a un momento exacto (click o arrastre)
//  - Se ocultan solos tras 2,5 s sin mover el mouse (solo mientras se reproduce)
// =====================================================================
const FS_HIDE_MS = 2500;
let scrubbing = false;
let scrubResume = false;
let idleTimer = 0;

// Refresca barra de progreso, tiempo y el icono de play / pausa
function updateFullscreenUI() {
    const end = contentEnd();
    const frac = end > 0 ? Math.min(1, clock.t / end) : 0;
    fsSeekFill.style.width = `${frac * 100}%`;
    fsSeekThumb.style.left = `${frac * 100}%`;
    fsTime.textContent = `${formatTime(clock.t)} / ${formatTime(end)}`;
    fsPlayBtn.textContent = clock.playing ? '❚❚' : '▶';
}

function showFsControls() {
    videoPlayerContainer.classList.remove('idle');
    clearTimeout(idleTimer);
    if (!videoPlayerContainer.classList.contains('is-fullscreen')) return;

    idleTimer = setTimeout(() => {
        if (clock.playing && !scrubbing) videoPlayerContainer.classList.add('idle');
    }, FS_HIDE_MS);
}

videoPlayerContainer.addEventListener('mousemove', showFsControls);
videoPlayerContainer.addEventListener('pointerdown', showFsControls);

fsPlayBtn.addEventListener('click', () => {
    if (clock.playing) pause(); else play();
});

// Evita que los botones queden con el foco (si no, la barra espaciadora los "vuelve a pulsar")
document.querySelectorAll('.video-btn').forEach(btn => {
    btn.addEventListener('mousedown', (e) => e.preventDefault());
});

// Fracción (0..1) de la barra donde está el puntero
function fsFracFromEvent(ev) {
    const rect = fsSeek.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    return Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width));
}

// Etiqueta con el tiempo exacto sobre el puntero
function showSeekTip(ev) {
    const rect = fsSeek.getBoundingClientRect();
    const frac = fsFracFromEvent(ev);
    fsSeekTip.textContent = formatTime(frac * contentEnd());
    const half = fsSeekTip.offsetWidth / 2;
    const x = Math.min(rect.width - half, Math.max(half, frac * rect.width));
    fsSeekTip.style.left = `${x}px`;
}

fsSeek.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    fsSeek.setPointerCapture(e.pointerId);

    scrubbing = true;
    scrubResume = clock.playing;
    if (scrubResume) pause();          // Se pausa mientras arrastras y luego continúa

    fsSeek.classList.add('dragging');
    seek(fsFracFromEvent(e) * contentEnd());
    showSeekTip(e);
});

fsSeek.addEventListener('pointermove', (e) => {
    showSeekTip(e);
    if (scrubbing) seek(fsFracFromEvent(e) * contentEnd());
});

function endScrub() {
    if (!scrubbing) return;
    scrubbing = false;
    fsSeek.classList.remove('dragging');
    if (scrubResume && clock.t < contentEnd() - 0.05) play();
    scrubResume = false;
}
fsSeek.addEventListener('pointerup', endScrub);
fsSeek.addEventListener('pointercancel', endScrub);

// =====================================================================
//  La cabecera + vista previa siguen al usuario al desplazarse en horizontal
//  (el CSS usa --view-w como ancho de la ventana visible)
// =====================================================================
function updateViewWidth() {
    const cs = getComputedStyle(document.body);
    const pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    document.documentElement.style.setProperty('--view-w', `${document.documentElement.clientWidth - pad}px`);
}
window.addEventListener('resize', updateViewWidth);
if (window.ResizeObserver) new ResizeObserver(updateViewWidth).observe(document.documentElement);
updateViewWidth();
// =====================================================================
//  Sistema de Exportación (video + audio)
//  - Antes de grabar, deja todos los videos listos en el segundo 0 (sin parpadeo)
//  - Mezcla el audio de los clips con Web Audio y lo graba junto con el video
//  - Guarda con el formato real que produce el navegador (MP4 si puede, si no WebM)
// =====================================================================

const exportBtn = document.getElementById('exportBtn');
const exportModal = document.getElementById('exportModal');
const exportProgress = document.getElementById('exportProgress');

// --- Audio -----------------------------------------------------------
// Cada <video> pasa por un nodo de ganancia y de ahí a los parlantes.
// Al exportar, esos mismos nodos se conectan además al destino que se graba.
function ensureAudioGraph() {
    if (!currentProjectId) return;

    if (!audioCtx) {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        audioCtx = new Ctx();
        speakerGain = audioCtx.createGain();
        speakerGain.connect(audioCtx.destination);
    }

    for (const clip of Object.values(currentProject().clips)) {
        if (clip.audioSource) continue; // createMediaElementSource solo se puede llamar una vez por <video>
        try {
            clip.audioSource = audioCtx.createMediaElementSource(clip.video);
            clip.gainNode = audioCtx.createGain();
            clip.audioSource.connect(clip.gainNode);
            clip.gainNode.connect(speakerGain);
        } catch (err) {
            console.warn('No se pudo conectar el audio de', clip.name, err);
        }
    }
}

// --- Preparación de los videos ------------------------------------------
// Espera a que un video termine de buscar (seek) y tenga un frame listo para dibujar
function waitVideoReady(v, ms = 4000) {
    return new Promise((resolve) => {
        const ready = () => !v.seeking && v.readyState >= 2;
        if (ready()) { resolve(); return; }

        const finish = () => {
            clearTimeout(timer);
            v.removeEventListener('seeked', check);
            v.removeEventListener('canplay', check);
            resolve();
        };
        const check = () => { if (ready()) finish(); };
        const timer = setTimeout(finish, ms); // Por si algún video nunca avisa

        v.addEventListener('seeked', check);
        v.addEventListener('canplay', check);
    });
}

// Pone todos los videos en su primer frame y espera a que estén listos.
// Sin esto, al empezar a grabar los videos "saltaban" al inicio y se veían frames negros.
async function prepareClipsAtStart(project) {
    clock.t = 0;

    const clips = Object.values(project.clips).filter(c => c.el && c.el.isConnected);
    clips.forEach(c => {
        c.video.pause();
        c.video.currentTime = 0;
    });
    await Promise.all(clips.map(c => waitVideoReady(c.video)));

    render(); // Pinta el primer frame antes de empezar a grabar
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
}

// --- Formato de salida ----------------------------------------------------
function pickRecorderFormat() {
    const options = [
        { mime: 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', type: 'video/mp4', ext: 'mp4' },
        { mime: 'video/mp4;codecs=avc1,mp4a.40.2',        type: 'video/mp4', ext: 'mp4' },
        { mime: 'video/mp4',                              type: 'video/mp4', ext: 'mp4' },
        { mime: 'video/webm;codecs=vp9,opus',             type: 'video/webm', ext: 'webm' },
        { mime: 'video/webm;codecs=vp8,opus',             type: 'video/webm', ext: 'webm' },
        { mime: 'video/webm',                             type: 'video/webm', ext: 'webm' }
    ];
    return options.find(o => MediaRecorder.isTypeSupported(o.mime))
        || { mime: '', type: 'video/webm', ext: 'webm' };
}

// --- Guardado --------------------------------------------------------------
function downloadBlob(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.style.display = 'none';
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }, 100);
}

async function saveBlob(blob, fileHandle, fileName) {
    if (fileHandle) {
        try {
            const writable = await fileHandle.createWritable();
            await writable.write(blob);
            await writable.close();
            return;
        } catch (err) {
            console.error('Error al guardar con File System Access API:', err);
        }
    }
    downloadBlob(blob, fileName);
}

// --- Botón Exportar -----------------------------------------------------------
exportBtn.addEventListener('click', async () => {
    if (!currentProjectId || exporting) return;

    const project = currentProject();
    const end = contentEnd();
    if (end <= 0) {
        alert('El proyecto está vacío o no tiene duración.');
        return;
    }

    if (!window.MediaRecorder || !previewCanvas.captureStream) {
        alert('Este navegador no permite exportar video. Usa una versión actual de Chrome o Edge.');
        return;
    }

    // 1. El audio se prepara DENTRO del clic (gesto del usuario); si no, el navegador lo deja en silencio
    ensureAudioGraph();
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();

    const format = pickRecorderFormat();
    const baseName = (project.name || 'video_editado').replace(/[\\/:*?"<>|]+/g, '_');
    const fileName = `${baseName}.${format.ext}`;

    // 2. Elegir nombre y ubicación (si el navegador lo soporta)
    let fileHandle = null;
    if (window.showSaveFilePicker) {
        try {
            fileHandle = await window.showSaveFilePicker({
                suggestedName: fileName,
                types: [{
                    description: format.ext === 'mp4' ? 'Video MP4' : 'Video WebM',
                    accept: { [format.type]: [`.${format.ext}`] }
                }]
            });
        } catch (err) {
            if (err.name === 'AbortError') return; // El usuario canceló
        }
    }

    // 3. Mostrar el progreso y bloquear la edición mientras se graba
    exporting = true;
    exportProgress.textContent = 'Preparando...';
    exportModal.classList.remove('hidden');

    let stream = null;
    let recordDest = null;

    const cleanup = () => {
        if (stream) stream.getTracks().forEach(t => t.stop());
        if (recordDest) {
            Object.values(project.clips).forEach(c => {
                if (c.gainNode) { try { c.gainNode.disconnect(recordDest); } catch (e) {} }
            });
        }
        exporting = false;
        clock.playing = false;
        cancelAnimationFrame(clock.raf);
        clock.t = 0;
        exportModal.classList.add('hidden');
        if (currentProjectId) refreshPreview(); // Pausa los videos y devuelve el volumen a los parlantes
    };

    let ok = false;
    try {
        pause();
        await prepareClipsAtStart(project);
        if (audioCtx && audioCtx.state === 'suspended') await audioCtx.resume();

        // 4. Flujo grabado = imagen del canvas + audio mezclado de todos los clips
        const tracks = previewCanvas.captureStream(30).getVideoTracks();
        if (audioCtx) {
            recordDest = audioCtx.createMediaStreamDestination();
            Object.values(project.clips).forEach(c => {
                if (c.gainNode) c.gainNode.connect(recordDest);
            });
            tracks.push(...recordDest.stream.getAudioTracks());
        }
        stream = new MediaStream(tracks);

        const recorderOptions = { videoBitsPerSecond: 8000000, audioBitsPerSecond: 192000 };
        if (format.mime) recorderOptions.mimeType = format.mime;

        const recorder = new MediaRecorder(stream, recorderOptions);
        const chunks = [];
        recorder.ondataavailable = (e) => {
            if (e.data && e.data.size > 0) chunks.push(e.data);
        };
        const stopped = new Promise((resolve) => { recorder.onstop = resolve; });

        recorder.start(1000);

        // 5. Reproducir la línea de tiempo en tiempo real mientras se graba
        clock.t = 0;
        clock.playing = true;
        clock.last = performance.now();
        syncClips(); // Arranca los videos que empiezan en el segundo 0

        await new Promise((resolve) => {
            const exportTick = (ts) => {
                if (!clock.playing) { resolve(); return; }

                clock.t += Math.max(0, (ts - clock.last) / 1000);
                clock.last = ts;
                exportProgress.textContent = `${Math.min(100, Math.round((clock.t / end) * 100))}%`;

                if (clock.t >= end) {
                    clock.playing = false;
                    resolve();
                    return;
                }

                syncClips();
                render();
                requestAnimationFrame(exportTick);
            };
            requestAnimationFrame(exportTick);
        });

        // Pequeño margen para que se grabe el final del audio (los videos van un poco por detrás del reloj)
        await new Promise(r => setTimeout(r, 300));
        recorder.stop();
        await stopped;

        const blob = new Blob(chunks, { type: (recorder.mimeType || format.type).split(';')[0] });
        await saveBlob(blob, fileHandle, fileName);
        ok = true;
    } catch (err) {
        console.error(err);
        alert('Hubo un error al exportar el video.');
    } finally {
        cleanup();
    }

    if (ok) alert('¡Video exportado con éxito!');
});
// --- Control del Menú de Relación de Aspecto ---
const aspectMenuBtn = document.getElementById('aspectMenuBtn');
let currentAspectW = 16;
let currentAspectH = 9;

// Crear el menú usando el sistema global de menús flotantes
const aspectMenu = createMenu(`
    <div class="context-menu-item" style="font-weight:bold; border-bottom:1px solid #444; pointer-events:none; color: #cccccc;">Formato</div>
    <div class="context-menu-item aspect-option checked" data-w="16" data-h="9">Horizontal 16:9</div>
    <div class="context-menu-item aspect-option" data-w="1" data-h="1">Cuadrado 1:1</div>
    <div class="context-menu-item aspect-option" data-w="9" data-h="16">Vertical 9:16</div>
    <div class="context-menu-item aspect-option" data-w="4" data-h="3">Televisión 4:3</div>
    <div class="context-menu-item aspect-option" data-w="21" data-h="9">Panorámico 21:9</div>
    <div class="context-menu-item aspect-option" data-w="2" data-h="1">Cine intermedio 2.0:1</div>
`);

// Abrir menú al hacer clic en los tres puntos
aspectMenuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const rect = aspectMenuBtn.getBoundingClientRect();
    openMenu(aspectMenu, rect.left, rect.bottom + 4);
});

// Selección de formato
aspectMenu.addEventListener('click', (e) => {
    const item = e.target.closest('.aspect-option');
    if (!item) return;

    const w = parseFloat(item.dataset.w);
    const h = parseFloat(item.dataset.h);

    currentAspectW = w;
    currentAspectH = h;

    // Marcar la opción activa
    aspectMenu.querySelectorAll('.aspect-option').forEach(opt => opt.classList.remove('checked'));
    item.classList.add('checked');

    // Ajustar resolución interna del canvas (manteniendo la altura base de 360px)
    const baseH = 360;
    const newW = Math.round(baseH * (w / h));

    previewCanvas.width = newW;
    previewCanvas.height = baseH;

    scratch.width = newW;
    scratch.height = baseH;

    // Ajustar proporciones del contenedor de previsualización
    videoPlayerContainer.style.aspectRatio = `${w} / ${h}`;
    if (w < h) { // Si es vertical (p. ej. 9:16)
        videoPlayerContainer.style.height = '280px';
        videoPlayerContainer.style.width = 'auto';
    } else {
        videoPlayerContainer.style.width = '320px';
        videoPlayerContainer.style.height = 'auto';
    }

    requestRender();
    hideMenus();
});
// --- Inicio ---
setTimelineWidth(500);
updatePlayhead();
