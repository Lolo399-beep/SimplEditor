// --- Constantes del editor ---
const PX_PER_SEC = 40;          // Escala de la línea de tiempo (px por segundo)
const THUMB_H = 58;             // Alto del filmstrip (alto de la fila - bordes)
const MAX_THUMB_W = 16000;      // Límite de ancho del canvas de miniaturas
const PREVIEW_W = 640;          // Resolución interna de la vista previa
const PREVIEW_H = 360;          // (bájala a 480x270 si va lento)
const DRIFT_TOLERANCE = 0.35;   // Segundos de desfase permitidos antes de re-sincronizar un video
const EPS = 0.001;
// Sincronía audio / imagen: segundos que se retrasa la IMAGEN para igualarla al audio
const AV_DELAY_PREVIEW = 0.2;   // al reproducir en el editor
const AV_DELAY_EXPORT = 0.2;    // en el video exportado
const FRAME_CAPTURE_MS = 30;    // cada cuánto se guarda un cuadro del retraso (~33 fps)

// Audios (oscilogramas)
const AUDIO_DEFAULT_COLOR = '#02f7c2';  // Color inicial del oscilograma (se cambia con clic derecho > Cambiar color)
const PEAKS_PER_SEC = PX_PER_SEC;       // Columnas del oscilograma por segundo de audio
const PEAKS_DECODE_RATE = 8000;         // Hz a los que se decodifica SOLO para dibujar la onda (ahorra RAM)
const AUDIO_EXT = /\.(mp3|wav|wave|ogg|oga|opus|m4a|aac|flac|aif|aiff|amr)$/i;

// Ajustes del chroma key
const CHROMA_MIN_DIFF = 20;    // Diferencia mínima entre el canal clave y los demás
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
const fsSeekCanvas = document.getElementById('fsSeekCanvas');
const fsSeekCtx = fsSeekCanvas ? fsSeekCanvas.getContext('2d') : null;
const fsSeekTipTime = document.getElementById('fsSeekTipTime');

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

// Modo recortes
let trimMode = false;       // true mientras el modo recortes está activo (la línea de tiempo queda inmóvil)
let trimBusy = false;       // true mientras se aplica un corte
let renderFrozen = false;   // true mientras se prepara un corte: la vista previa conserva su último cuadro

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
                type: el._clip.type || 'video',
                chroma: el._clip.chroma || 'none',
                color: el._clip.color,                // Color del oscilograma (solo audios)
                srcStart: el._clip.srcStart || 0,     // Dónde empieza este fragmento dentro del archivo
                duration: el._clip.duration,          // Cuánto dura (cambia al recortar)
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
    if (trimBusy || undoStack.length <= 1) return; // Mantener al menos el estado inicial

    const currentState = undoStack.pop();
    redoStack.push(currentState);

    applyState(JSON.parse(undoStack[undoStack.length - 1]));
}

function redo() {
    if (trimBusy || redoStack.length === 0) return;

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

    // Esc sale del modo recortes
    if (e.key === 'Escape' && trimMode) {
        e.preventDefault();
        exitTrimMode();
        return;
    }

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
    exitTrimMode();
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
        clips: {}          // Medios importados (videos e imágenes): id -> clip
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
            if (c.chroma != null) clip.chroma = c.chroma;
            if (c.color != null) clip.color = c.color;
            if (c.srcStart != null) clip.srcStart = c.srcStart;
            if (c.duration != null) clip.duration = c.duration;
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
    grip.addEventListener('mousedown', () => { if (trimMode) return; row.draggable = true; });
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
        if (trimMode) return; // En modo recortes la línea de tiempo no se mueve ni se estira
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
    if (!currentProjectId || trimMode) return; // En modo recortes el cabezal no se mueve
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
    <div class="context-menu-item" id="trimModeOption">Modo recortes</div>
    <div class="context-menu-item danger" id="deleteRowOption">Borrar</div>
`);

let rowTarget = null;

function showContextMenu(x, y, row) {
    if (trimBusy) return;
    rowTarget = row;

    const muted = row.classList.contains('muted');
    document.getElementById('muteRowOption').style.display = muted ? 'none' : 'block';
    document.getElementById('unmuteRowOption').style.display = muted ? 'block' : 'none';
    document.getElementById('lockRowOption').textContent =
        row.classList.contains('locked') ? 'Desbloquear' : 'Bloquear';
    document.getElementById('trimModeOption').textContent =
        trimMode ? 'Salir del modo recortes' : 'Modo recortes';

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

document.getElementById('trimModeOption').addEventListener('click', () => {
    toggleTrimMode();
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
    <div class="context-menu-item" data-action="trim-mode">Modo recortes</div>
    <div class="context-menu-separator"></div>
    <div class="context-menu-item" data-chroma="green">Quitar fondo verde</div>
    <div class="context-menu-item" data-chroma="blue">Quitar fondo azul</div>
    <div class="context-menu-item" data-chroma="checker">Quitar fondo a cuadros</div>
    <div class="context-menu-item" data-chroma="none">Quitar transparencia</div>
    <div class="context-menu-item" data-action="rethumb">Recargar fotogramas</div>
    <div class="context-menu-item danger" data-action="delete">Eliminar clip</div>
`);
let clipTarget = null;

// --- Menú de audios (en lugar del menú de video: sin opciones de pantalla verde) ---
const audioMenu = createMenu(`
    <div class="context-menu-item" data-action="toggle-mute">Silenciar</div>
    <div class="context-menu-item" data-action="toggle-lock">Bloquear</div>
    <div class="context-menu-item" data-action="trim-mode">Modo recortes</div>
    <div class="context-menu-item" data-action="color">Cambiar color<span class="menu-swatch"></span></div>
    <div class="context-menu-item danger" data-action="delete">Borrar</div>
`);

function showAudioContextMenu(x, y, clip) {
    audioMenu.querySelector('[data-action="toggle-mute"]').textContent = clip.muted ? 'Sonorizar' : 'Silenciar';
    const lockItem = audioMenu.querySelector('[data-action="toggle-lock"]');
    lockItem.textContent = clip.locked ? 'Desbloquear' : 'Bloquear';
    audioMenu.querySelector('[data-action="trim-mode"]').textContent =
        trimMode ? 'Salir del modo recortes' : 'Modo recortes';
    audioMenu.querySelector('.menu-swatch').style.backgroundColor = clip.color || AUDIO_DEFAULT_COLOR;

    // Con el audio bloqueado solo queda disponible "Desbloquear"
    audioMenu.querySelectorAll('.context-menu-item').forEach(item => {
        item.classList.toggle('disabled', !!clip.locked && item !== lockItem);
    });
    openMenu(audioMenu, x, y);
}

audioMenu.addEventListener('click', (e) => {
    const item = e.target.closest('.context-menu-item');
    if (!item || !clipTarget || item.classList.contains('disabled')) return;

    const action = item.dataset.action;
    if (action === 'toggle-mute') setClipMuted(clipTarget, !clipTarget.muted);
    else if (action === 'toggle-lock') setClipLocked(clipTarget, !clipTarget.locked);
    else if (action === 'trim-mode') toggleTrimMode();
    else if (action === 'color') openAudioColorPicker(clipTarget, item);
    else if (action === 'delete') deleteClip(clipTarget);
});

// Selector de color: un <input type="color"> invisible que se abre junto al menú.
// En Chrome / Edge muestra el selector clásico (cuadro de color, barra de matiz y campo HEX).
const audioColorInput = document.createElement('input');
audioColorInput.type = 'color';
audioColorInput.className = 'audio-color-input';
audioColorInput.tabIndex = -1;
document.body.appendChild(audioColorInput);

let colorTarget = null;   // Audio al que se le está cambiando el color
let colorBefore = null;   // Color que tenía al abrir el selector (para registrar un solo paso de historial)

function openAudioColorPicker(clip, anchorEl) {
    const r = anchorEl.getBoundingClientRect();
    colorTarget = clip;
    colorBefore = clip.color || AUDIO_DEFAULT_COLOR;
    audioColorInput.value = colorBefore;
    audioColorInput.style.left = `${Math.round(r.left)}px`;
    audioColorInput.style.top = `${Math.round(r.bottom)}px`;
    audioColorInput.click();
}

function setAudioColor(clip, color) {
    if (clip.type !== 'audio' || clip.locked) return;
    clip.color = color;
    if (clip.el) clip.el.style.setProperty('--audio-color', color);
    drawClipFilmstrip(clip); // Repinta el oscilograma con el color nuevo
}

audioColorInput.addEventListener('input', () => {
    if (colorTarget) setAudioColor(colorTarget, audioColorInput.value); // Se ve en vivo mientras eliges
});

audioColorInput.addEventListener('change', () => {
    if (!colorTarget) return;
    setAudioColor(colorTarget, audioColorInput.value);
    if (colorTarget.color !== colorBefore) commit(); // Ctrl+Z devuelve el color anterior
    colorBefore = colorTarget.color;
    audioColorInput.blur(); // Que la barra espaciadora vuelva a reproducir / pausar
});

function showClipContextMenu(x, y, clip) {
    if (trimBusy) return;
    clipTarget = clip;

    // Los audios tienen su propio menú (sin pantalla verde ni fotogramas)
    if (clip.type === 'audio') { showAudioContextMenu(x, y, clip); return; }

    const isImage = clip.type === 'image';
    clipMenu.querySelectorAll('[data-action="toggle-mute"], [data-action="toggle-lock"], [data-action="trim-mode"], [data-action="rethumb"]').forEach(item => item.style.display = isImage ? 'none' : 'block');
    const muteItem = clipMenu.querySelector('[data-action="toggle-mute"]');
    const lockItem = clipMenu.querySelector('[data-action="toggle-lock"]');
    muteItem.textContent = clip.muted ? 'Sonorizar' : 'Silenciar';
    lockItem.textContent = clip.locked ? 'Desbloquear' : 'Bloquear';
    clipMenu.querySelector('[data-action="trim-mode"]').textContent =
        trimMode ? 'Salir del modo recortes' : 'Modo recortes';

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
    } else if (item.dataset.action === 'trim-mode') {
        toggleTrimMode();
    } else if (item.dataset.action === 'rethumb') {
        queueThumbnails(clipTarget);
    } else if (item.dataset.action === 'delete') {
        deleteClip(clipTarget);
    }
});

// =====================================================================
//  Clips: importar, crear elemento, miniaturas
// =====================================================================
importBtn.addEventListener('click', () => {
    if (!currentProjectId || trimBusy) return;
    fileInput.click(); // Abre el explorador de archivos
});

fileInput.addEventListener('change', async () => {
    const files = Array.from(fileInput.files);
    fileInput.value = ''; // Permite volver a elegir el mismo archivo

    const failed = [];
    for (const file of files) {
        const ok = file.type.startsWith('image/') ? await importImageFile(file)
                 : isAudioFile(file) ? await importAudioFile(file)
                 : file.type.startsWith('video/') ? await importVideoFile(file) : false;
        if (!ok) failed.push(file.name);
    }
    if (failed.length) {
        alert(`No se pudieron cargar estos archivos. Comprueba que sean imágenes, videos o audios compatibles:\n\n${failed.join('\n')}`);
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

// Importa una imagen como un clip estático de la línea de tiempo (duración inicial: 3 s).
async function importImageFile(file) {
    const projectId = currentProjectId;
    if (!projectId || !file.type.startsWith('image/')) return false;
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.decoding = 'async';
    const loaded = await new Promise(resolve => {
        image.onload = () => resolve(true);
        image.onerror = () => resolve(false);
        image.src = url;
    });
    if (!loaded) { URL.revokeObjectURL(url); return false; }
    if (projectId !== currentProjectId) { URL.revokeObjectURL(url); return true; }

    const clip = {
        id: `image_${Date.now()}_${++clipSeq}`, type: 'image', name: file.name, url, image,
        video: null, duration: 3, aspect: image.naturalWidth / image.naturalHeight,
        source: null, srcStart: 0, start: 0, chroma: 'none', chromaManual: true,
        muted: true, locked: false, el: null, thumbs: null, thumbCtx: null,
        thumbKey: '', disposed: false, badge: null
    };
    currentProject().clips[clip.id] = clip;
    const row = findEmptyRow() || createRowElement(true);
    placeClip(row, clip);
    fitTimeline();
    commit();
    refreshPreview();
    return true;
}

// =====================================================================
//  Audios
//  - Se reproducen con su propio <audio> (clip.video guarda ese elemento, así el resto del editor
//    —volumen, silencio, exportación, recortes— lo trata igual que el sonido de un video).
//  - NUNCA se dibujan en la vista previa y la jerarquía de filas no los afecta: suenan siempre,
//    aunque haya imágenes o videos encima.
//  - El oscilograma se calcula UNA vez por archivo, en segundo plano, y lo comparten todos los
//    fragmentos (cortar no recalcula nada). Se decodifica a 8 kHz y el audio decodificado se descarta
//    al terminar: solo queda una lista de picos pequeña.
// =====================================================================
function isAudioFile(file) {
    return file.type.startsWith('audio/') || (!file.type && AUDIO_EXT.test(file.name));
}

async function importAudioFile(file) {
    const projectId = currentProjectId;
    if (!projectId) return false;

    const clip = await loadAudioClip(file);
    if (!clip) return false;

    // Si el usuario salió del proyecto mientras cargaba, se descarta
    if (projectId !== currentProjectId) {
        disposeClip(clip);
        return true;
    }

    currentProject().clips[clip.id] = clip;
    if (audioCtx) ensureAudioGraph(); // Si el audio ya está activo, conecta también el clip nuevo

    // Fila vacía si hay; si no, se crea una nueva ABAJO (los audios no tapan ni se tapan: no hay capa visual)
    const row = findEmptyRow() || createRowElement(false);
    clip.start = 0;
    placeClip(row, clip);
    fitTimeline();
    commit();

    queueAudioPeaks(clip.source);
    refreshPreview();
    return true;
}

// Carga el archivo en un <audio> y devuelve el objeto clip (o null si falla)
function loadAudioClip(file) {
    return new Promise((resolve) => {
        const url = URL.createObjectURL(file);
        const audio = document.createElement('audio');
        audio.preload = 'auto';

        let settled = false;
        let timer = 0;
        const cleanup = () => {
            clearTimeout(timer);
            audio.removeEventListener('loadedmetadata', onMeta);
            audio.removeEventListener('error', fail);
        };
        const fail = () => {
            if (settled) return;
            settled = true;
            cleanup();
            audio.removeAttribute('src');
            audio.load();
            URL.revokeObjectURL(url);
            resolve(null);
        };
        const onMeta = () => {
            if (settled) return;
            if (!isFinite(audio.duration) || audio.duration <= 0) { fail(); return; }
            settled = true;
            cleanup();

            const duration = audio.duration;
            // Fuente compartida: los picos del oscilograma del archivo COMPLETO
            const source = {
                url,
                name: file.name,
                duration,
                aspect: 1,
                peaks: null,          // Float32Array [min0, max0, min1, max1, ...] a PEAKS_PER_SEC por segundo
                peakGain: 1,          // Aumento para que el oscilograma se vea aunque el audio sea bajo
                peaksBusy: false,     // Calculando (o en cola para calcular)
                disposed: false,
                clips: new Set()      // Todos los fragmentos que usan este archivo
            };

            resolve({
                id: `audio_${Date.now()}_${++clipSeq}`,
                type: 'audio',
                name: file.name,
                url,
                video: audio,         // El <audio> ocupa el lugar del <video> para compartir toda la lógica de sonido
                duration,
                aspect: 1,
                source,
                srcStart: 0,
                start: 0,
                chroma: 'none',
                chromaManual: true,
                color: AUDIO_DEFAULT_COLOR,
                muted: false,
                locked: false,
                el: null,
                thumbs: null,
                thumbCtx: null,
                thumbKey: '',
                disposed: false,
                badge: null
            });
        };

        timer = setTimeout(fail, 15000);
        audio.addEventListener('loadedmetadata', onMeta);
        audio.addEventListener('error', fail);
        audio.src = url;
    });
}

// --- Oscilograma ---------------------------------------------------------
let peaksQueue = Promise.resolve();

function queueAudioPeaks(source) {
    if (source.peaksBusy || source.peaks) return;
    source.peaksBusy = true;
    peaksQueue = peaksQueue
        .then(() => buildAudioPeaks(source))
        .catch((err) => console.warn('No se pudo generar el oscilograma de', source.name, err))
        .finally(() => { source.peaksBusy = false; });
}

async function buildAudioPeaks(source) {
    if (source.disposed) return;
    await waitUntilIdle(source);                 // No compite con la reproducción ni con la exportación
    if (source.disposed) return;

    const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!Offline) return;

    let bytes = await (await fetch(source.url)).arrayBuffer();
    if (source.disposed) return;

    // Decodifica a baja frecuencia: para dibujar la onda sobra y gasta mucha menos RAM
    const decoder = new Offline(1, 1, PEAKS_DECODE_RATE);
    let buffer = await new Promise((resolve, reject) => {
        const p = decoder.decodeAudioData(bytes, resolve, reject);
        if (p && p.catch) p.catch(reject);
    });
    bytes = null;
    if (source.disposed) return;

    const channels = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
    const total = buffer.length;
    const perCol = buffer.sampleRate / PEAKS_PER_SEC;     // Muestras que resume cada columna
    const cols = Math.max(1, Math.ceil(total / perCol));
    const peaks = new Float32Array(cols * 2);
    let maxAbs = 0;

    for (let i = 0; i < cols; i++) {
        const a = Math.floor(i * perCol);
        const b = Math.min(total, Math.max(a + 1, Math.floor((i + 1) * perCol)));
        let mn = 0, mx = 0;
        for (let c = 0; c < channels.length; c++) {
            const d = channels[c];
            for (let j = a; j < b; j++) {
                const s = d[j];
                if (s < mn) mn = s;
                if (s > mx) mx = s;
            }
        }
        peaks[i * 2] = mn;
        peaks[i * 2 + 1] = mx;
        if (-mn > maxAbs) maxAbs = -mn;
        if (mx > maxAbs) maxAbs = mx;

        // Cada tanto se cede el control para no congelar la página con archivos largos
        if ((i & 4095) === 4095) {
            await sleep(0);
            if (source.disposed) return;
        }
    }

    buffer = null; // Se suelta el audio decodificado: solo quedan los picos
    source.peaks = peaks;
    source.peakGain = Math.min(8, 0.95 / Math.max(maxAbs, 0.0001));
    refreshFilmstrips(source); // Dibuja el oscilograma en todos los fragmentos de este audio
}

// Dibuja en el clip el tramo [srcStart, srcStart + duration] de los picos del archivo
function drawAudioWaveform(clip, force = false) {
    const cv = clip.thumbs;
    const ctx = clip.thumbCtx;
    const src = clip.source;
    if (!cv || !ctx || !src) return;

    const color = clip.color || AUDIO_DEFAULT_COLOR;
    const key = `${clip.srcStart.toFixed(3)}|${clip.duration.toFixed(3)}|${color}|${src.peaks ? src.peaks.length : 0}`;
    if (!force && clip.thumbKey === key) return;
    clip.thumbKey = key;

    const w = Math.min(MAX_THUMB_W, Math.max(1, Math.ceil(clip.duration * PX_PER_SEC)));
    if (cv.width !== w) cv.width = w;           // (cambiar el ancho limpia el canvas)
    if (cv.height !== THUMB_H) cv.height = THUMB_H;

    const H = cv.height;
    const mid = H / 2;
    ctx.fillStyle = '#0b0b0b';
    ctx.fillRect(0, 0, w, H);

    // Línea central (el silencio)
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.35;
    ctx.fillRect(0, Math.floor(mid), w, 1);
    ctx.globalAlpha = 1;

    const peaks = src.peaks;
    if (!peaks) return; // Todavía calculando: por ahora solo la línea central

    const n = peaks.length / 2;
    const amp = (mid - 2) * src.peakGain;
    const perCol = clip.duration / w;           // Segundos que abarca cada columna dibujada
    for (let x = 0; x < w; x++) {
        const t0 = clip.srcStart + x * perCol;
        const i0 = Math.floor(t0 * PEAKS_PER_SEC);
        if (i0 >= n) break;
        const i1 = Math.min(n, Math.max(i0 + 1, Math.ceil((t0 + perCol) * PEAKS_PER_SEC)));

        let mn = 0, mx = 0;
        for (let i = i0; i < i1; i++) {
            const lo = peaks[i * 2];
            const hi = peaks[i * 2 + 1];
            if (lo < mn) mn = lo;
            if (hi > mx) mx = hi;
        }
        const top = Math.round(mid - mx * amp);
        const bottom = Math.round(mid - mn * amp);
        ctx.fillRect(x, top, 1, Math.max(1, bottom - top));
    }
}

// Al terminar un salto en el tiempo, repinta la vista previa si está en pausa
function attachSeekedRender(video) {
    video.addEventListener('seeked', () => {
        if (!clock.playing && currentProjectId) requestRender();
    });
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

            attachSeekedRender(video);

            // Fuente compartida: guarda la tira de fotogramas del archivo COMPLETO.
            // Cada fragmento (clip) dibuja su parte desde aquí, así cortar no obliga a recalcular nada.
            const duration = video.duration;
            const aspect = video.videoWidth / video.videoHeight;
            const strip = document.createElement('canvas');
            strip.width = Math.min(MAX_THUMB_W, Math.max(1, Math.ceil(duration * PX_PER_SEC)));
            strip.height = THUMB_H;
            const stripCtx = strip.getContext('2d', { alpha: false });
            stripCtx.fillStyle = '#1a1a1a';
            stripCtx.fillRect(0, 0, strip.width, strip.height);
            const source = {
                url,
                duration,
                aspect,
                thumbs: strip,
                thumbCtx: stripCtx,
                thumbBusy: false,        // Generando (o en cola para generar) sus miniaturas
                disposed: false,         // true cuando se libera (detiene las miniaturas)
                clips: new Set()         // Todos los fragmentos que usan este archivo
            };

            resolve({
                id: `clip_${Date.now()}_${++clipSeq}`,
                name: file.name,
                url,
                video,
                duration,                // Duración de ESTE fragmento (cambia al recortar)
                aspect,
                source,
                srcStart: 0,             // Segundo del archivo donde empieza este fragmento
                start: 0,                // Segundo en que aparece en la línea de tiempo
                chroma: 'none',          // 'none' | 'green' | 'blue'
                chromaManual: false,
                muted: false,            // Silenciado individualmente
                locked: false,           // Bloqueado: no se puede configurar ni mover
                el: null,
                thumbs: null,
                thumbCtx: null,
                thumbKey: '',            // Qué tramo de la fuente tiene dibujado la tira
                disposed: false,         // true cuando se libera el clip
                badge: null
            });
        }, { once: true });

        video.src = url;
    });
}

function disposeClip(clip) {
    clip.disposed = true;
    if (clip.source) clip.source.disposed = true; // Corta la generación de miniaturas en curso
    if (clip.type === 'image') { if (clip.url) URL.revokeObjectURL(clip.url); return; }
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
    el._clip = clip;
    clip.el = el;
    if (clip.source && clip.source.clips) clip.source.clips.add(clip);

    // Las imágenes muestran su propia miniatura; los videos muestran su tira de fotogramas.
    // Canvas con los frames (filmstrip): copia el tramo de la fuente que le toca a este fragmento
    const thumbs = document.createElement('canvas');
    thumbs.width = 1;
    thumbs.height = THUMB_H;
    clip.thumbs = thumbs;
    clip.thumbCtx = thumbs.getContext('2d', { alpha: false });
    clip.thumbKey = '';

    const label = document.createElement('span');
    label.className = 'clip-label';
    label.textContent = clip.name;

    const badge = document.createElement('span');
    badge.className = 'clip-badge';
    clip.badge = badge;

    el.append(thumbs, label, badge);
    if (clip.type === 'image' && clip.image) {
        el.classList.add('image-clip');
        const tctx = thumbs.getContext('2d');
        tctx.clearRect(0, 0, thumbs.width, thumbs.height);
        thumbs.width = Math.max(1, Math.ceil(clip.duration * PX_PER_SEC));
        thumbs.height = THUMB_H;
        const tileW = Math.max(1, Math.round(THUMB_H * clip.aspect));
        for (let x = 0; x < thumbs.width; x += tileW) tctx.drawImage(clip.image, x, 0, Math.min(tileW, thumbs.width-x), THUMB_H);
    }
    updateClipBadge(clip);
    layoutClip(clip);

    setupClipDrag(clip);

    // En las imágenes, arrastrar el borde derecho cambia su duración exacta.
    if (clip.type === 'image') {
        const resize = document.createElement('div');
        resize.className = 'image-resize-handle';
        resize.title = 'Arrastra para alargar o acortar la imagen';
        el.appendChild(resize);
        resize.addEventListener('pointerdown', (e) => {
            if (e.button !== 0 || clip.locked || el.parentElement?.classList.contains('locked') || trimMode) return;
            e.preventDefault(); e.stopPropagation(); hideMenus();
            const startX = e.clientX, startDuration = clip.duration;
            const move = ev => {
                clip.duration = Math.max(0.1, startDuration + (ev.clientX - startX) / PX_PER_SEC);
                layoutClip(clip); fitTimeline(); requestRender();
            };
            const up = () => {
                window.removeEventListener('pointermove', move);
                window.removeEventListener('pointerup', up);
                commit(); refreshPreview();
            };
            window.addEventListener('pointermove', move);
            window.addEventListener('pointerup', up, { once: true });
        });
    }

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
    refreshClipLook(clip);
    layoutClip(clip);
    row.appendChild(clip.el);
}

// Aspecto del clip según sus datos: color/clase de los audios y etiqueta de estado.
// (Se llama al colocar el clip, también al Deshacer / Rehacer, así todo queda al día.)
function refreshClipLook(clip) {
    if (clip.type === 'audio') {
        clip.el.classList.add('audio-clip');
        clip.el.style.setProperty('--audio-color', clip.color || AUDIO_DEFAULT_COLOR);
    }
    updateClipBadge(clip);
}

// Posición y ancho del clip en la línea de tiempo (y su tira de fotogramas)
function layoutClip(clip) {
    clip.el.style.left = `${clip.start * PX_PER_SEC}px`;
    clip.el.style.width = `${clip.duration * PX_PER_SEC}px`;
    drawClipFilmstrip(clip);
}

// Dibuja en la tira del fragmento el tramo [srcStart, srcStart + duration] de la tira completa de la fuente
function drawClipFilmstrip(clip, force = false) {
    const cv = clip.thumbs;
    const ctx = clip.thumbCtx;
    if (!cv || !ctx) return;
    if (clip.type === 'audio') { drawAudioWaveform(clip, force); return; }
    if (clip.type === 'image') {
        const w = Math.min(MAX_THUMB_W, Math.max(1, Math.ceil(clip.duration * PX_PER_SEC)));
        if (cv.width !== w) cv.width = w;
        if (cv.height !== THUMB_H) cv.height = THUMB_H;
        ctx.fillStyle = '#202020'; ctx.fillRect(0, 0, cv.width, cv.height);
        if (clip.image && clip.image.complete) {
            const tileW = Math.max(1, Math.round(THUMB_H * clip.aspect));
            for (let x = 0; x < cv.width; x += tileW) ctx.drawImage(clip.image, x, 0, Math.min(tileW, cv.width - x), THUMB_H);
        }
        return;
    }
    const strip = clip.source && clip.source.thumbs;
    if (!strip) return;

    const key = `${clip.srcStart.toFixed(3)}|${clip.duration.toFixed(3)}`;
    if (!force && clip.thumbKey === key) return;
    clip.thumbKey = key;

    const w = Math.min(MAX_THUMB_W, Math.max(1, Math.ceil(clip.duration * PX_PER_SEC)));
    if (cv.width !== w) cv.width = w;          // (cambiar el ancho limpia el canvas)
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(0, 0, cv.width, cv.height);

    const k = strip.width / clip.source.duration;   // px de la tira por segundo de video
    const sx = Math.max(0, clip.srcStart * k);
    const sw = Math.min(strip.width - sx, clip.duration * k);
    if (sw > 0) ctx.drawImage(strip, sx, 0, sw, strip.height, 0, 0, cv.width, cv.height);
}

// Cuando la fuente tiene fotogramas nuevos, vuelve a dibujar todos sus fragmentos
function refreshFilmstrips(source) {
    for (const clip of source.clips) {
        if (clip.el && clip.el.isConnected) drawClipFilmstrip(clip, true);
        else clip.thumbKey = ''; // Se redibuja cuando vuelva a la línea de tiempo (Deshacer / Rehacer)
    }
}

function deleteClip(clip) {
    const row = clip.el.parentElement;
    if (clip.locked || (row && row.classList.contains('locked'))) return;
    if (clip.video) clip.video.pause();
    clip.el.remove(); // El clip sigue guardado, así Ctrl+Z puede recuperarlo
    commit();
    refreshPreview();
}

// Actualiza la etiqueta de la esquina del clip y su aspecto de bloqueado
function updateClipBadge(clip) {
    const parts = [];
    if (clip.chroma === 'green') parts.push('Pantalla verde');
    if (clip.chroma === 'blue') parts.push('Pantalla azul');
    if (clip.chroma === 'checker') parts.push('Fondo a cuadros');
    if (clip.muted) parts.push('Silenciado');
    if (clip.locked) parts.push('Bloqueado');

    clip.badge.textContent = parts.join(' · ');
    clip.el.classList.toggle('locked', !!clip.locked);
    clip.el.classList.toggle('is-muted', !!clip.muted);
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

// --- Miniaturas (fotogramas de la tira de cada clip) ---------------------
// Pensado para PCs con poca RAM / CPU lenta y videos HD largos:
//  - Solo hay UN decodificador extra a la vez, sin precarga, y se cierra al terminar
//    (también se cierra mientras el usuario reproduce o exporta, para no quitarle recursos)
//  - Cada salto tiene tiempo de espera y reintentos; si el decodificador se traba, se abre otro
//  - Se dibuja de grueso a fino (cada 8ª miniatura, luego 4ª, 2ª y todas): la tira se ve
//    completa desde el principio y se va afinando, así nunca queda en gris
//  - Lo que aún no se pudo capturar se rellena con la miniatura real más cercana
//  - Si al final faltan miniaturas se hacen hasta THUMB_ROUNDS vueltas más para completarlas
const THUMB_SEEK_TIMEOUT = 10000;  // ms que se espera un salto (se multiplica en cada reintento)
const THUMB_TRIES = 3;             // Intentos por miniatura antes de darla por fallida
const THUMB_ROUNDS = 3;            // Vueltas completas para completar las que falten
const THUMB_MAX_FAILS = 3;         // Fallos seguidos antes de pasar a la siguiente vuelta
const THUMB_MAX_REOPENS = 12;      // Veces máximas que se vuelve a abrir el decodificador por clip

let thumbQueue = Promise.resolve();

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function queueThumbnails(clip) {
    const source = clip.source;
    if (source.thumbBusy) return; // Ya se está generando (o está esperando su turno)
    source.thumbBusy = true;
    thumbQueue = thumbQueue
        .then(() => buildThumbnails(source))
        .catch((err) => console.warn('No se pudieron generar las miniaturas de', clip.name, err))
        .finally(() => { source.thumbBusy = false; });
}

// Abre un <video> aparte, sin sonido y sin precarga, solo para sacar fotogramas
function openThumbVideo(url) {
    return new Promise((resolve) => {
        const v = document.createElement('video');
        v.muted = true;
        v.preload = 'metadata';          // No guarda en memoria lo que no necesita
        v.playsInline = true;
        v.disablePictureInPicture = true;

        let done = false;
        const finish = (ok) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            v.removeEventListener('loadedmetadata', onMeta);
            v.removeEventListener('error', onError);
            if (ok) {
                resolve(v);
            } else {
                closeThumbVideo(v);
                resolve(null);
            }
        };
        const onMeta = () => finish(!!v.videoWidth);
        const onError = () => finish(false);
        const timer = setTimeout(() => finish(false), 15000);

        v.addEventListener('loadedmetadata', onMeta);
        v.addEventListener('error', onError);
        v.src = url;
    });
}

// Libera el decodificador y la memoria del <video> auxiliar
function closeThumbVideo(v) {
    if (!v) return;
    v.pause();
    v.removeAttribute('src');
    v.load();
}

// Salta a un segundo y espera a que ese fotograma esté realmente listo para dibujarse
function seekVideo(v, t, ms) {
    return new Promise((resolve) => {
        let done = false;
        const finish = (ok) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            v.removeEventListener('seeked', check);
            v.removeEventListener('canplay', check);
            v.removeEventListener('loadeddata', check);
            v.removeEventListener('error', onError);
            resolve(ok);
        };
        const ready = () => !v.seeking && v.readyState >= 2;
        const check = () => { if (ready()) finish(true); };
        const onError = () => finish(false);
        const timer = setTimeout(() => finish(ready()), ms);

        v.addEventListener('seeked', check);
        v.addEventListener('canplay', check);
        v.addEventListener('loadeddata', check);
        v.addEventListener('error', onError);

        if (Math.abs(v.currentTime - t) < 0.001) t += 0.02; // Si ya está ahí, 'seeked' podría no avisar
        v.currentTime = t;
    });
}

// Captura el fotograma de un segundo, con varios intentos (cada uno espera más que el anterior)
async function captureFrame(v, t, source) {
    for (let attempt = 0; attempt < THUMB_TRIES; attempt++) {
        if (v.error || source.disposed) return false;
        const target = Math.max(0.01, Math.min(source.duration - 0.05, t + attempt * 0.3));
        if (await seekVideo(v, target, THUMB_SEEK_TIMEOUT * (attempt + 1))) return true;
    }
    return false;
}

// La generación espera mientras se reproduce o se exporta
async function waitUntilIdle(source) {
    while ((clock.playing || exporting) && !source.disposed) await sleep(300);
}

async function buildThumbnails(source) {
    if (source.disposed) return;

    const canvas = source.thumbs;
    const ctx = source.thumbCtx || canvas.getContext('2d');
    const H = canvas.height;

    // Medidas "en pantalla": cada miniatura respeta la proporción del video. Si el clip es tan largo
    // que el canvas quedó limitado a MAX_THUMB_W, se dibuja comprimido (k < 1) y el navegador
    // lo estira de vuelta, así que no se deforma ni se pierde ninguna parte del clip.
    const screenW = source.duration * PX_PER_SEC;
    const tileW = Math.max(16, Math.round(H * source.aspect));
    const tiles = Math.max(1, Math.ceil(screenW / tileW));
    const k = canvas.width / screenW;

    const tileRect = (i) => {
        const x0 = Math.round(i * tileW * k);
        return { x: x0, w: Math.max(1, Math.round((i + 1) * tileW * k) - x0) };
    };
    const tileTime = (i) => {
        const frac = Math.min(0.999, (i * tileW + tileW / 2) / screenW);
        return Math.max(0.01, Math.min(source.duration - 0.05, frac * source.duration));
    };

    // Orden de trabajo: de grueso a fino
    const passes = [];
    const seen = new Uint8Array(tiles);
    for (const stride of [8, 4, 2, 1]) {
        const pass = [];
        for (let i = 0; i < tiles; i += stride) {
            if (!seen[i]) { seen[i] = 1; pass.push(i); }
        }
        passes.push(pass);
    }

    const real = new Uint8Array(tiles); // 1 = fotograma real ya dibujado

    // Rellena las miniaturas pendientes copiando la real más cercana hacia la izquierda
    const fillGaps = () => {
        let src = real.indexOf(1);
        if (src < 0) return;
        for (let i = 0; i < tiles; i++) {
            if (real[i]) { src = i; continue; }
            const s = tileRect(src);
            const d = tileRect(i);
            ctx.drawImage(canvas, s.x, 0, s.w, H, d.x, 0, d.w, H);
        }
    };

    let lastRefresh = 0;
    let tv = null;
    let retries = 0;
    const openVideo = async (isRetry) => {
        closeThumbVideo(tv);
        tv = null;
        if (isRetry && ++retries > THUMB_MAX_REOPENS) return false;
        tv = await openThumbVideo(source.url);
        return !!tv;
    };

    try {
        for (let round = 0; round < THUMB_ROUNDS && !source.disposed; round++) {
            if (real.indexOf(0) < 0) break;                      // Ya están todas
            if (round > 0) await sleep(2000 * round);            // Respira antes de reintentar
            if (!(await openVideo(round > 0))) continue;

            let fails = 0;
            outer:
            for (const pass of passes) {
                for (const i of pass) {
                    if (real[i]) continue;
                    if (source.disposed) return;

                    // Mientras el usuario reproduce o exporta, se libera el decodificador y se espera
                    if (clock.playing || exporting) {
                        closeThumbVideo(tv);
                        tv = null;
                        await waitUntilIdle(source);
                        if (source.disposed) return;
                        if (!(await openVideo(false))) break outer;
                    }

                    if (await captureFrame(tv, tileTime(i), source)) {
                        const r = tileRect(i);
                        ctx.drawImage(tv, r.x, 0, r.w, H);
                        real[i] = 1;
                        fails = 0;

                        // Con el primer fotograma se detecta si el video tiene pantalla verde o azul
                        if (i === 0) {
                            const mode = detectChromaBackground(tv);
                            if (mode !== 'none') applyDetectedChroma(source, mode);
                        }

                        // Cada tanto se refrescan las tiras de los fragmentos para verlas llenarse
                        if (performance.now() - lastRefresh > 800) {
                            lastRefresh = performance.now();
                            refreshFilmstrips(source);
                        }
                    } else {
                        // El decodificador quedó trabado: se descarta y se abre uno nuevo
                        if (++fails >= THUMB_MAX_FAILS) break outer;
                        if (!(await openVideo(true))) break outer;
                    }
                }
                fillGaps(); // Al terminar cada pasada la tira ya se ve completa
                refreshFilmstrips(source);
            }
            fillGaps();     // También si la vuelta se cortó por fallos seguidos
            refreshFilmstrips(source);
        }
    } finally {
        fillGaps();
        refreshFilmstrips(source);
        closeThumbVideo(tv);
    }
}

// Aplica el chroma detectado a todos los fragmentos de esa fuente (salvo los que el usuario ya configuró)
function applyDetectedChroma(source, mode) {
    for (const c of source.clips) {
        if (c.chromaManual || c.locked) continue;
        c.chroma = mode;
        if (c.badge) updateClipBadge(c);
    }
    requestRender();
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
        if (clip.type === 'image' || clip.type === 'audio') return;
        const v = clip.video;
        if (v.seeking || v.readyState < 2 || !v.videoWidth) unready = true;
    });
    return unready;
}

// Reemplaza la función render() por esta versión que soporta relaciones de aspecto dinámicas:
const frameDelay = { buf: [], pool: [], last: 0 };

// Cuánto hay que retrasar la imagen ahora mismo (0 = nada)
function currentAvDelay() {
    if (!audioCtx || !currentProjectId || !projects[currentProjectId]) return 0;
    const routed = Object.values(currentProject().clips).some(c => c.gainNode);
    if (!routed) return 0; // Sin Web Audio el navegador ya sincroniza solo
    return exporting ? AV_DELAY_EXPORT : AV_DELAY_PREVIEW;
}

function clearFrameDelay() {
    frameDelay.buf.length = 0;
    frameDelay.pool.length = 0;
}

// Dibuja en la vista previa el cuadro de hace "delay" segundos
function showDelayedFrame(now, delay) {
    const buf = frameDelay.buf;
    if (!buf.length) return;

    const limit = now - delay * 1000;
    let idx = 0;
    while (idx + 1 < buf.length && buf[idx + 1].t <= limit) idx++;

    // Los cuadros anteriores al mostrado ya no hacen falta: se reciclan
    for (let i = 0; i < idx; i++) frameDelay.pool.push(buf[i].canvas);
    buf.splice(0, idx);

    pctx.drawImage(buf[0].canvas, 0, 0, previewCanvas.width, previewCanvas.height);
}

function render() {
    renderQueued = false;
    if (renderFrozen) return; // Se está preparando un corte: la vista previa conserva su último cuadro

    const delay = clock.playing ? currentAvDelay() : 0;

    // En pausa (o sin Web Audio) se dibuja directo, sin retraso
    if (delay <= 0) {
        clearFrameDelay();
        renderComposite(pctx);
        return;
    }

    // Reproduciendo: se compone en un lienzo aparte y se muestra el de hace "delay" segundos
    const now = performance.now();
    if (!frameDelay.buf.length || now - frameDelay.last >= FRAME_CAPTURE_MS) {
        const w = previewCanvas.width;
        const h = previewCanvas.height;
        const frame = frameDelay.pool.pop() || document.createElement('canvas');
        if (frame.width !== w) frame.width = w;
        if (frame.height !== h) frame.height = h;
        renderComposite(frame.getContext('2d'));
        frameDelay.buf.push({ t: now, canvas: frame });
        frameDelay.last = now;
    }
    showDelayedFrame(now, delay);
}

// Composición de todas las capas en el contexto que se le pase
function renderComposite(ctx) {
    const canvasW = previewCanvas.width;
    const canvasH = previewCanvas.height;

    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, canvasW, canvasH);
    if (!currentProjectId) return;

    forEachClipBottomUp((clip) => {
        const local = clock.t - clip.start;
        if (local < 0 || local >= clip.duration) return;

        // Los audios no se dibujan en la vista previa (solo se oyen); su fila no influye en nada
        if (clip.type === 'audio') return;

        if (clip.type === 'image') {
            const img = clip.image;
            if (!img || !img.complete || !img.naturalWidth) return;
            const scale = Math.min(canvasW / img.naturalWidth, canvasH / img.naturalHeight);
            const w = Math.max(1, Math.round(img.naturalWidth * scale));
            const h = Math.max(1, Math.round(img.naturalHeight * scale));
            const x = Math.round((canvasW - w) / 2), y = Math.round((canvasH - h) / 2);
            if (clip.chroma === 'none') ctx.drawImage(img, x, y, w, h);
            else { sctx.clearRect(0, 0, canvasW, canvasH); sctx.drawImage(img, x, y, w, h); applyChromaKey(sctx, x, y, w, h, clip.chroma); ctx.drawImage(scratch, 0, 0); }
            return;
        }
        const v = clip.video;
        if (!v || v.readyState < 2 || !v.videoWidth) return;

        const s = Math.min(canvasW / v.videoWidth, canvasH / v.videoHeight);
        const w = Math.max(1, Math.round(v.videoWidth * s));
        const h = Math.max(1, Math.round(v.videoHeight * s));
        const x = Math.round((canvasW - w) / 2);
        const y = Math.round((canvasH - h) / 2);

        if (clip.chroma === 'none') {
            ctx.drawImage(v, x, y, w, h);
        } else {
            sctx.clearRect(0, 0, canvasW, canvasH);
            sctx.drawImage(v, x, y, w, h);
            applyChromaKey(sctx, x, y, w, h, clip.chroma);
            ctx.drawImage(scratch, 0, 0);
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

    if (mode === 'checker') {
        // Detecta y vuelve transparentes los cuadros grises claros y blancos del fondo falso
        for (let i = 0; i < d.length; i += 4) {
            const r = d[i], g = d[i + 1], b = d[i + 2];
            const max = Math.max(r, g, b);
            const min = Math.min(r, g, b);
            // Si el color es casi neutro (gris/blanco) y tiene alta luminosidad
            if ((max - min < 15) && (max > 160)) {
                d[i + 3] = 0; // Transparente
            }
        }
    } else {
        const kc = mode === 'green' ? 1 : 2;   
        const o1 = 0;                          
        const o2 = mode === 'green' ? 2 : 1;   

        for (let i = 0; i < d.length; i += 4) {
            const key = d[i + kc];
            const a = d[i + o1];
            const b = d[i + o2];
            const other = a > b ? a : b;
            const diff = key - other;

            if (diff > CHROMA_MIN_DIFF) {
                const k = diff / key;
                if (k >= CHROMA_K2) {
                    d[i + 3] = 0;                                         
                } else {
                    if (k > CHROMA_K1) {
                        d[i + 3] = d[i + 3] * (CHROMA_K2 - k) / (CHROMA_K2 - CHROMA_K1); 
                    }
                    d[i + kc] = other;                                    
                }
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
        if (clip.type === 'image') continue;
        const v = clip.video;

        if (!clip.el || !clip.el.isConnected) { // Clip eliminado o fuera de pantalla
            if (!v.paused) v.pause();
            continue;
        }

        const row = clip.el.parentElement;
        const local = clock.t - clip.start;
        const active = local >= 0 && local < clip.duration;
        const srcT = clip.srcStart + local; // Segundo del ARCHIVO que corresponde a este instante

        if (!active) {
            if (!v.paused) v.pause();
            // Deja listo el primer frame del fragmento para cuando llegue su momento
            if (local < 0 && Math.abs(v.currentTime - clip.srcStart) > 0.05 && !v.seeking) {
                v.currentTime = clip.srcStart;
            }
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
            if (Math.abs(v.currentTime - srcT) > tolerance) v.currentTime = srcT;
            if (v.paused) v.play().catch(() => {});
        } else {
            if (!v.paused) v.pause();
            if (Math.abs(v.currentTime - srcT) > 0.03) v.currentTime = srcT;
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
    if (!currentProjectId || trimMode) return;
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
    if (!currentProjectId || trimMode) return;
    pause();
    clock.t = 0;
    play();
}

function seek(t) {
    if (trimMode) return; // En modo recortes el cabezal no se mueve
    clock.t = Math.min(Math.max(0, t), timelineSeconds()); // Entre 0 y el final de la tabla
    if (clock.playing) clock.last = performance.now();
    refreshPreview();
}

// Detiene todo (al salir del proyecto)
function stopPlayback() {
    clock.playing = false;
    cancelAnimationFrame(clock.raf);
    if (currentProjectId && projects[currentProjectId]) {
        Object.values(projects[currentProjectId].clips).forEach(c => { if (c.video) c.video.pause(); });
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
    const targetT = frac * contentEnd();
    
    if (fsSeekTipTime) fsSeekTipTime.textContent = formatTime(targetT);
    renderPreviewAtTime(targetT);

    const half = fsSeekTip.offsetWidth / 2;
    const x = Math.min(rect.width - half, Math.max(half, frac * rect.width));
    fsSeekTip.style.left = `${x}px`;
}

fsSeek.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || trimMode) return;
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
        if (clip.type === 'image' || !clip.video) continue;
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

    const clips = Object.values(project.clips).filter(c => c.type !== 'image' && c.video && c.el && c.el.isConnected);
    clips.forEach(c => {
        c.video.pause();
        c.video.currentTime = c.srcStart || 0; // Primer frame del FRAGMENTO (no del archivo)
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

// =====================================================================
//  MP4 fragmentado (Chrome) -> MP4 normal con la duración exacta
//  El MediaRecorder de Chrome guarda el MP4 "en trozos" (fragmentado) y SIN la duración
//  en el encabezado. Muchos reproductores / editores entonces muestran una duración
//  equivocada (o solo la del primer trozo, de unos pocos segundos) y no dejan avanzar.
//  Esta función NO vuelve a codificar nada: lee la tabla de muestras de cada trozo y escribe
//  un MP4 normal (moov al inicio) con la duración correcta. Los datos de video y audio se
//  reutilizan tal cual (Blob.slice), así que casi no gasta memoria. Si algo falla, el
//  llamador guarda el archivo original sin tocarlo.
// =====================================================================
async function fragmentedMp4ToMp4(blob) {
    const ascii = (s) => Uint8Array.from(s, c => c.charCodeAt(0));
    const fourcc = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
    const readBytes = async (start, len) => new Uint8Array(await blob.slice(start, start + len).arrayBuffer());

    // Lista los "boxes" de un buffer entre start y end
    const parseBoxes = (buf, start, end) => {
        const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
        const list = [];
        let p = start;
        while (p + 8 <= end) {
            let size = dv.getUint32(p);
            let hdr = 8;
            if (size === 1) {
                if (p + 16 > end) break;
                size = Number(dv.getBigUint64(p + 8));
                hdr = 16;
            } else if (size === 0) {
                size = end - p;
            }
            if (size < hdr || p + size > end) break;
            list.push({ type: fourcc(buf, p + 4), start: p, end: p + size, hdr });
            p += size;
        }
        return list;
    };
    const kids = (buf, box, type) =>
        parseBoxes(buf, box.start + box.hdr, box.end).filter(b => !type || b.type === type);

    // --- 1. Leer el archivo: solo se cargan moov y los moof (son pequeños), nunca los datos ---
    const total = blob.size;
    let moov = null;
    const moofs = [];
    for (let pos = 0; pos + 8 <= total;) {
        const head = await readBytes(pos, 16);
        const hv = new DataView(head.buffer);
        let size = hv.getUint32(0);
        let hdr = 8;
        const type = fourcc(head, 4);
        if (size === 1 && head.length >= 16) { size = Number(hv.getBigUint64(8)); hdr = 16; }
        else if (size === 0) size = total - pos;
        if (size < hdr || pos + size > total) break;
        if (type === 'moov') moov = await readBytes(pos, size);
        else if (type === 'moof') moofs.push({ start: pos, buf: await readBytes(pos, size) });
        pos += size;
    }
    if (!moov || !moofs.length) return blob; // No está fragmentado: no hay nada que arreglar

    const mdv = new DataView(moov.buffer, moov.byteOffset, moov.byteLength);
    const moovBox = parseBoxes(moov, 0, moov.length)[0];
    const mvhd = kids(moov, moovBox, 'mvhd')[0];
    const mvhdV = moov[mvhd.start + mvhd.hdr];
    const movTs = mdv.getUint32(mvhd.start + mvhd.hdr + (mvhdV === 1 ? 20 : 12));

    // Valores por defecto de cada pista (trex)
    const trex = {};
    const mvex = kids(moov, moovBox, 'mvex')[0];
    if (mvex) {
        for (const b of kids(moov, mvex, 'trex')) {
            const o = b.start + b.hdr;
            trex[mdv.getUint32(o + 4)] = { dur: mdv.getUint32(o + 12), size: mdv.getUint32(o + 16), flags: mdv.getUint32(o + 20) };
        }
    }

    // Pistas (video, audio)
    const tracks = {};
    for (const trak of kids(moov, moovBox, 'trak')) {
        const tkhd = kids(moov, trak, 'tkhd')[0];
        const mdia = kids(moov, trak, 'mdia')[0];
        const mdhd = kids(moov, mdia, 'mdhd')[0];
        const hdlr = kids(moov, mdia, 'hdlr')[0];
        const minf = kids(moov, mdia, 'minf')[0];
        const stbl = kids(moov, minf, 'stbl')[0];
        const stsd = kids(moov, stbl, 'stsd')[0];
        const tv = moov[tkhd.start + tkhd.hdr];
        const mv = moov[mdhd.start + mdhd.hdr];
        const id = mdv.getUint32(tkhd.start + tkhd.hdr + (tv === 1 ? 20 : 12));
        tracks[id] = {
            id, trak, tkhd, mdia, mdhd, minf, stsd, tv, mv,
            timescale: mdv.getUint32(mdhd.start + mdhd.hdr + (mv === 1 ? 20 : 12)),
            handler: fourcc(moov, hdlr.start + hdlr.hdr + 8),
            dur: [], size: [], sync: [], cto: [], chunks: [],
            hasCto: false, negCto: false, startTime: null, cum: 0
        };
    }

    // --- 2. Leer las tablas de muestras de cada trozo (moof -> traf -> trun) ---
    const allChunks = []; // En el orden en que aparecen en el archivo original
    for (const mf of moofs) {
        const buf = mf.buf;
        const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
        const moofBox = parseBoxes(buf, 0, buf.length)[0];
        if (!moofBox) continue;

        for (const traf of kids(buf, moofBox, 'traf')) {
            const tfhd = kids(buf, traf, 'tfhd')[0];
            if (!tfhd) continue;
            let o = tfhd.start + tfhd.hdr;
            const tfFlags = dv.getUint32(o) & 0xFFFFFF;
            const t = tracks[dv.getUint32(o + 4)];
            o += 8;
            if (!t) continue;

            let base = mf.start; // Sin base explícita, los desplazamientos cuentan desde el inicio del moof
            if (tfFlags & 0x01) { base = Number(dv.getBigUint64(o)); o += 8; }
            if (tfFlags & 0x02) o += 4;
            const def = Object.assign({ dur: 0, size: 0, flags: 0 }, trex[t.id]);
            if (tfFlags & 0x08) { def.dur = dv.getUint32(o); o += 4; }
            if (tfFlags & 0x10) { def.size = dv.getUint32(o); o += 4; }
            if (tfFlags & 0x20) { def.flags = dv.getUint32(o); o += 4; }

            // Hora de inicio del trozo: la duración de la última muestra del trozo anterior no siempre
            // es exacta (el grabador no conoce la siguiente hora todavía), así que se ajusta para que
            // empalme justo con este trozo. Así audio y video nunca se desfasan.
            const tfdt = kids(buf, traf, 'tfdt')[0];
            if (tfdt) {
                const to = tfdt.start + tfdt.hdr;
                const bt = buf[to] === 1 ? Number(dv.getBigUint64(to + 4)) : dv.getUint32(to + 4);
                if (t.startTime === null) {
                    t.startTime = bt;
                } else if (t.dur.length) {
                    const delta = bt - (t.startTime + t.cum);
                    const fixedLast = t.dur[t.dur.length - 1] + delta;
                    if (delta !== 0 && fixedLast > 0) { t.dur[t.dur.length - 1] = fixedLast; t.cum += delta; }
                }
            }
            if (t.startTime === null) t.startTime = 0;

            let next = base;
            for (const trun of kids(buf, traf, 'trun')) {
                let p = trun.start + trun.hdr;
                const ver = buf[p];
                const fl = dv.getUint32(p) & 0xFFFFFF;
                const count = dv.getUint32(p + 4);
                p += 8;

                let dataOff = next;
                if (fl & 0x01) { dataOff = base + dv.getInt32(p); p += 4; }
                let firstFlags = null;
                if (fl & 0x04) { firstFlags = dv.getUint32(p); p += 4; }

                let runSize = 0;
                for (let i = 0; i < count; i++) {
                    let d = def.dur, s = def.size, f = (i === 0 && firstFlags !== null) ? firstFlags : def.flags, c = 0;
                    if (fl & 0x100) { d = dv.getUint32(p); p += 4; }
                    if (fl & 0x200) { s = dv.getUint32(p); p += 4; }
                    if (fl & 0x400) { f = dv.getUint32(p); p += 4; }
                    if (fl & 0x800) { c = ver === 1 ? dv.getInt32(p) : dv.getUint32(p); p += 4; }

                    t.dur.push(d);
                    t.size.push(s);
                    t.cto.push(c);
                    if (c) t.hasCto = true;
                    if (c < 0) t.negCto = true;
                    if (!(f & 0x10000)) t.sync.push(t.dur.length); // Fotograma clave (número de muestra, desde 1)
                    t.cum += d;
                    runSize += s;
                }
                const chunk = { t, src: dataOff, size: runSize, count, dst: 0 };
                if (chunk.src + chunk.size > total) throw new Error('El archivo grabado está incompleto');
                t.chunks.push(chunk);
                allChunks.push(chunk);
                next = dataOff + runSize;
            }
        }
    }

    const outTracks = Object.values(tracks).filter(t => t.dur.length);
    if (!outTracks.length) return blob;

    // --- 3. Duraciones (la del archivo = la de la pista más larga) ---
    const startSec = (t) => t.startTime / t.timescale;
    const minStart = Math.min(...outTracks.map(startSec));
    for (const t of outTracks) {
        t.mediaDur = t.cum; // En la escala de tiempo de la pista
        t.delay = Math.round((startSec(t) - minStart) * movTs); // Si una pista empieza más tarde (en la escala del archivo)
        if (t.delay * 1000 / movTs < 1) t.delay = 0;
        t.trackDur = t.delay + Math.round(t.mediaDur * movTs / t.timescale);
    }
    const movieDur = Math.max(...outTracks.map(t => t.trackDur));

    // --- 4. Escribir el MP4 normal ---
    const mk = (type, ...parts) => {
        const arrs = parts.map(p => p instanceof Uint8Array ? p : Uint8Array.from(p));
        let len = 8;
        for (const a of arrs) len += a.length;
        const out = new Uint8Array(len);
        new DataView(out.buffer).setUint32(0, len);
        out.set(ascii(type), 4);
        let o = 8;
        for (const a of arrs) { out.set(a, o); o += a.length; }
        return out;
    };
    // Box "completo" (con versión y banderas) cuyo contenido son números de 32 bits
    const full = (type, version, flags, words) => {
        const out = new Uint8Array(12 + words.length * 4);
        const dv = new DataView(out.buffer);
        dv.setUint32(0, out.length);
        out.set(ascii(type), 4);
        dv.setUint32(8, ((version << 24) | flags) >>> 0);
        for (let i = 0; i < words.length; i++) dv.setUint32(12 + i * 4, words[i] >>> 0);
        return out;
    };
    // [a,a,a,b] -> [3,a, 1,b]
    const rle = (arr) => {
        const out = [];
        for (let i = 0; i < arr.length;) {
            let j = i + 1;
            while (j < arr.length && arr[j] === arr[i]) j++;
            out.push(j - i, arr[i]);
            i = j;
        }
        return out;
    };
    const setDur = (box, hdr, v1Off, v0Off, version, value) => {
        const dv = new DataView(box.buffer, box.byteOffset, box.byteLength);
        if (version === 1) dv.setBigUint64(hdr + v1Off, BigInt(value)); else dv.setUint32(hdr + v0Off, value);
    };

    const buildMoov = () => {
        const traks = outTracks.map((t) => {
            // Tabla de muestras nueva
            const stts = rle(t.dur);
            const stscWords = [];
            let prevCount = -1;
            t.chunks.forEach((c, i) => {
                if (c.count !== prevCount) { stscWords.push(i + 1, c.count, 1); prevCount = c.count; }
            });
            const stbl = [
                t.stsd ? moov.slice(t.stsd.start, t.stsd.end) : new Uint8Array(0),
                full('stts', 0, 0, [stts.length / 2, ...stts]),
                full('stsc', 0, 0, [stscWords.length / 3, ...stscWords]),
                full('stsz', 0, 0, [0, t.size.length, ...t.size]),
                full('stco', 0, 0, [t.chunks.length, ...t.chunks.map(c => c.dst)])
            ];
            if (t.sync.length && t.sync.length < t.dur.length) stbl.push(full('stss', 0, 0, [t.sync.length, ...t.sync]));
            if (t.hasCto) {
                const ctts = rle(t.cto);
                stbl.push(full('ctts', t.negCto ? 1 : 0, 0, [ctts.length / 2, ...ctts]));
            }

            const minfParts = kids(moov, t.minf).map(b =>
                b.type === 'stbl' ? mk('stbl', ...stbl) : moov.slice(b.start, b.end));
            const mdiaParts = kids(moov, t.mdia).map(b => {
                if (b.type === 'minf') return mk('minf', ...minfParts);
                const copy = moov.slice(b.start, b.end);
                if (b.type === 'mdhd') setDur(copy, b.hdr, 24, 16, t.mv, t.mediaDur);
                return copy;
            });

            const trakParts = [];
            for (const b of kids(moov, t.trak)) {
                if (b.type === 'edts') continue;
                if (b.type === 'mdia') { trakParts.push(mk('mdia', ...mdiaParts)); continue; }
                const copy = moov.slice(b.start, b.end);
                if (b.type === 'tkhd') {
                    setDur(copy, b.hdr, 28, 20, t.tv, t.trackDur);
                    trakParts.push(copy);
                    // Si la pista empieza más tarde que las demás: un tramo vacío al inicio
                    if (t.delay > 0) {
                        const mediaMovDur = t.trackDur - t.delay;
                        trakParts.push(mk('edts', full('elst', 0, 0, [2, t.delay, 0xFFFFFFFF, 0x00010000, mediaMovDur, 0, 0x00010000])));
                    }
                } else {
                    trakParts.push(copy);
                }
            }
            return mk('trak', ...trakParts);
        });

        const mvhdCopy = moov.slice(mvhd.start, mvhd.end);
        setDur(mvhdCopy, mvhd.hdr, 24, 16, mvhdV, movieDur);
        return mk('moov', mvhdCopy, ...traks);
    };

    const ftyp = mk('ftyp', [...ascii('isom'), 0, 0, 2, 0, ...ascii('isom'), ...ascii('iso2'), ...ascii('avc1'), ...ascii('mp41')]);

    // El tamaño del moov no depende de los desplazamientos: se arma una vez para medirlo y otra con los valores finales
    const moovSize = buildMoov().length;
    let cursor = ftyp.length + moovSize + 8;
    for (const c of allChunks) { c.dst = cursor; cursor += c.size; }
    if (cursor > 0xFFFFFFF0) throw new Error('El archivo es demasiado grande para reescribirlo');
    const moovBytes = buildMoov();
    if (moovBytes.length !== moovSize) throw new Error('Error interno al reescribir el MP4');

    const dataSize = cursor - (ftyp.length + moovSize + 8);
    const mdatHead = new Uint8Array(8);
    new DataView(mdatHead.buffer).setUint32(0, 8 + dataSize);
    mdatHead.set(ascii('mdat'), 4);

    const parts = allChunks.map(c => blob.slice(c.src, c.src + c.size));
    return new Blob([ftyp, moovBytes, mdatHead, ...parts], { type: 'video/mp4' });
}

// --- Botón Exportar -----------------------------------------------------------
// La exportación graba la línea de tiempo EN TIEMPO REAL con MediaRecorder, así que el archivo dura
// lo que tarda la grabación. Para que dure EXACTAMENTE lo que dura el proyecto:
//  1. La duración (exportEnd) se fija UNA sola vez, al empezar.
//  2. El bucle de grabación tiene su propia bandera (running): ningún pause() externo puede cortarlo
//     antes de tiempo, y solo termina cuando el reloj llega a exportEnd.
//  3. Si la ventana se oculta o se minimiza, el navegador detiene requestAnimationFrame. Antes el reloj
//     "saltaba" al volver y la exportación terminaba de golpe (archivo cortado). Ahora la grabación y el
//     reloj se ponen en PAUSA juntos y se reanudan al volver.
//  4. Si el grabador se detiene solo o da error, se avisa: no se guarda un archivo corto en silencio.
exportBtn.addEventListener('click', async () => {
    if (!currentProjectId || exporting || trimBusy) return;

    const project = currentProject();
    const exportEnd = contentEnd(); // Duración EXACTA del proyecto (segundos), fijada una sola vez
    if (exportEnd <= 0) {
        alert('El proyecto está vacío o no tiene duración.');
        return;
    }

    if (!window.MediaRecorder || !previewCanvas.captureStream) {
        alert('Este navegador no permite exportar video. Usa una versión actual de Chrome o Edge.');
        return;
    }

    exitTrimMode();

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
    exportProgress.style.whiteSpace = 'pre-line';
    exportProgress.textContent = 'Preparando...';
    exportModal.classList.remove('hidden');

    let stream = null;
    let recordDest = null;
    let recorder = null;
    let running = false;   // Controla el bucle de grabación (no depende de clock.playing)
    let held = false;      // true mientras la ventana está oculta (grabación en pausa)
    let heldSince = 0;
    let heldMs = 0;        // Tiempo total que estuvo en pausa por ventana oculta
    let recError = null;   // Error del grabador (si lo hubo)

    const showProgress = () => {
        const t = Math.min(clock.t, exportEnd);
        const pct = Math.min(100, Math.round((t / exportEnd) * 100));
        exportProgress.textContent =
            `${formatTime(t)} / ${formatTime(exportEnd)}  (${pct}%)\nMantén esta ventana visible hasta que termine.`;
    };

    // Ventana oculta / minimizada: se pausa TODO junto (grabación, audio, reloj y videos)
    const onVisibility = () => {
        if (!running) return;

        if (document.hidden && !held) {
            held = true;
            heldSince = performance.now();
            clock.playing = false;          // syncClips() pausa los videos
            syncClips();
            try { if (recorder && recorder.state === 'recording') recorder.pause(); } catch (e) {}
            if (audioCtx) audioCtx.suspend().catch(() => {});
        } else if (!document.hidden && held) {
            held = false;
            heldMs += performance.now() - heldSince;
            if (audioCtx) audioCtx.resume().catch(() => {});
            try { if (recorder && recorder.state === 'paused') recorder.resume(); } catch (e) {}
            clock.last = performance.now(); // El tiempo oculto no cuenta
            clock.playing = true;
            syncClips();
        }
    };
    document.addEventListener('visibilitychange', onVisibility);

    const cleanup = () => {
        running = false;
        document.removeEventListener('visibilitychange', onVisibility);
        try { if (recorder && recorder.state !== 'inactive') recorder.stop(); } catch (e) {}
        if (stream) stream.getTracks().forEach(t => t.stop());
        if (recordDest) {
            Object.values(project.clips).forEach(c => {
                if (c.gainNode) { try { c.gainNode.disconnect(recordDest); } catch (e) {} }
            });
        }
        if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
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

        recorder = new MediaRecorder(stream, recorderOptions);
        const chunks = [];
        recorder.ondataavailable = (e) => {
            if (e.data && e.data.size > 0) chunks.push(e.data);
        };
        recorder.onerror = (e) => {
            recError = (e && e.error) || new Error('Error del grabador de video');
            running = false;
        };
        const stopped = new Promise((resolve) => { recorder.onstop = resolve; });

        // 5. Reproducir la línea de tiempo en tiempo real mientras se graba
        const loopStart = performance.now();
        // WebM: sin "timeslice" Chrome sí escribe la duración en el archivo. MP4: se arregla más abajo.
        if (format.ext === 'webm') recorder.start(); else recorder.start(1000);
        running = true;
        clock.t = 0;
        clock.playing = true;
        clock.last = loopStart;
        syncClips(); // Arranca los videos que empiezan en el segundo 0

        await new Promise((resolve) => {
            const exportTick = () => {
                if (!running) { resolve(); return; }
                const now = performance.now();

                // Ventana oculta: no se avanza el reloj (la grabación está en pausa)
                if (held) {
                    clock.last = now;
                    requestAnimationFrame(exportTick);
                    return;
                }

                // El grabador se detuvo por su cuenta: se avisa en vez de guardar un archivo corto
                if (recorder.state === 'inactive') {
                    recError = recError || new Error('El grabador se detuvo antes de terminar.');
                    running = false;
                    resolve();
                    return;
                }

                clock.t += Math.max(0, (now - clock.last) / 1000);
                clock.last = now;
                showProgress();

                // Termina SOLO cuando se alcanzó la duración total del proyecto
                if (clock.t >= exportEnd) {
                    running = false;
                    resolve();
                    return;
                }

                syncClips();
                render();
                requestAnimationFrame(exportTick);
            };
            requestAnimationFrame(exportTick);
        });
        clock.playing = false;
        const loopMs = performance.now() - loopStart - heldMs; // Tiempo realmente grabado
        if (recError) throw recError;

        // Margen final: entra el final del audio y se muestran los últimos cuadros retrasados
        const tailMs = Math.max(250, AV_DELAY_EXPORT * 1000 + 50);
        const tailEnd = performance.now() + tailMs;
        await new Promise((resolve) => {
            const timer = setTimeout(resolve, tailMs + 100); // Por si requestAnimationFrame se detiene
            const tailTick = () => {
                const now = performance.now();
                const d = currentAvDelay();
                if (d > 0) showDelayedFrame(now, d);
                if (now >= tailEnd) { clearTimeout(timer); resolve(); return; }
                requestAnimationFrame(tailTick);
            };
            requestAnimationFrame(tailTick);
        });

        if (recorder.state !== 'inactive') recorder.stop();
        await stopped;

        const blob = new Blob(chunks, { type: (recorder.mimeType || format.type).split(';')[0] });

        // El MP4 de Chrome no trae la duración en el encabezado: se reescribe como MP4 normal.
        // (Si algo falla se guarda el archivo original, igual que antes.)
        let finalBlob = blob;
        if (format.ext === 'mp4') {
            exportProgress.textContent = 'Ajustando la duración del archivo...';
            try {
                finalBlob = await fragmentedMp4ToMp4(blob);
            } catch (err) {
                console.warn('[Exportar] No se pudo reescribir el MP4; se guarda tal como lo entregó el navegador.', err);
            }
        }

        await saveBlob(finalBlob, fileHandle, fileName);
        console.log(
            `[Exportar] proyecto: ${exportEnd.toFixed(2)} s · grabado: ${(loopMs / 1000).toFixed(2)} s · ` +
            `${(finalBlob.size / 1048576).toFixed(1)} MB · ${recorder.mimeType || format.type}` +
            (finalBlob !== blob ? ' · duración corregida' : '')
        );
        ok = true;
    } catch (err) {
        console.error(err);
        alert('Hubo un error al exportar el video.' + (err && err.message ? `\n\n${err.message}` : ''));
    } finally {
        cleanup();
    }

    if (ok) alert(`¡Video exportado con éxito!\nDuración: ${formatTime(exportEnd)}`);
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
function renderPreviewAtTime(targetT) {
    if (!fsSeekCtx || !currentProjectId) return;

    const canvasW = fsSeekCanvas.width;
    const canvasH = fsSeekCanvas.height;

    fsSeekCtx.fillStyle = '#000000';
    fsSeekCtx.fillRect(0, 0, canvasW, canvasH);

    const rows = Array.from(rowsContainer.children);
    for (let i = rows.length - 1; i >= 0; i--) {
        for (const el of rows[i].children) {
            if (el._clip) {
                const clip = el._clip;
                const local = targetT - clip.start;
                if (local >= 0 && local < clip.duration && clip.thumbs && clip.type !== 'audio') {
                    const aspect = clip.aspect || (16 / 9);
                    const frameW = clip.thumbs.height * aspect;
                    const thumbX = (local / clip.duration) * Math.max(0, clip.thumbs.width - frameW);

                    try {
                        fsSeekCtx.drawImage(
                            clip.thumbs,
                            Math.max(0, thumbX), 0, Math.min(frameW, clip.thumbs.width - Math.max(0, thumbX)), clip.thumbs.height,
                            0, 0, canvasW, canvasH
                        );
                    } catch (e) {
                        // Fallback silencioso si ocurre algún desajuste de límites
                    }
                }
            }
        }
    }
}
// =====================================================================
//  Modo recortes
//  - Clic derecho → "Modo recortes". Esc para salir.
//  - Con el clic izquierdo se arrastra un cuadro sobre la línea de tiempo. Al soltar se
//    borra ese tramo en las filas que toca el cuadro, y lo que queda a la derecha se corre
//    hacia la izquierda hasta pegarse con lo anterior (se tapa el hueco).
//  - Mientras está activo, la línea de tiempo queda inmóvil: no se mueve el cabezal, no se
//    arrastran clips ni filas, no se reproduce. (La página sí se puede desplazar.)
//
//  Por qué no se traba ni se pone negro:
//   1. Cada fragmento tiene su PROPIO <video>, ya posicionado en su primer frame. Al empalmar
//      dos fragmentos no hay que "saltar" el mismo video, así que no hay tirones.
//   2. El corte se prepara completo ANTES de tocar nada (videos cargados y ubicados en el
//      frame que se verá bajo el cabezal) y la vista previa conserva su último cuadro mientras
//      tanto. Después los datos y la pantalla cambian juntos, de golpe.
//   3. Las miniaturas no se vuelven a generar: cada fragmento copia su tramo de la tira de la fuente.
// =====================================================================
const MIN_TRIM = 0.05;   // Segundos mínimos que debe abarcar el cuadro para contar como corte
const SNAP_PX = 6;       // Los bordes del cuadro se pegan a bordes de clips / cabezal a esta distancia
const TRIM_HINT = 'MODO RECORTES · arrastra un cuadro sobre la línea de tiempo para borrar ese tramo · Esc para salir';

const timelineEl = document.getElementById('timeline');

// Cuadro de selección (vive dentro de la línea de tiempo)
const trimSelection = document.createElement('div');
trimSelection.className = 'trim-selection';
const trimSelectionLabel = document.createElement('span');
trimSelectionLabel.className = 'trim-selection-label';
trimSelection.appendChild(trimSelectionLabel);
timelineEl.appendChild(trimSelection);

// Aviso fijo mientras el modo está activo
const trimBanner = document.createElement('div');
trimBanner.className = 'trim-banner hidden';
document.body.appendChild(trimBanner);

let trimDrag = null; // { x0, y0, lastX, lastY, t0, t1, rows } mientras se arrastra el cuadro

function enterTrimMode() {
    if (!currentProjectId || exporting || trimMode) return;
    pause();
    hideMenus();
    trimMode = true;
    document.body.classList.add('trim-mode');
    trimBanner.textContent = TRIM_HINT;
    trimBanner.classList.remove('hidden');
}

function exitTrimMode() {
    if (!trimMode) return;
    endTrimDrag();
    trimMode = false;
    document.body.classList.remove('trim-mode');
    trimBanner.classList.add('hidden');
}

function toggleTrimMode() {
    if (trimMode) exitTrimMode(); else enterTrimMode();
}

// --- Selección con el mouse ------------------------------------------------

// Filas que toca el rango vertical [y0, y1] (coordenadas relativas a la línea de tiempo)
function trimRowsBetween(y0, y1, timelineTop) {
    const lo = Math.min(y0, y1);
    const hi = Math.max(y0, y1);
    return Array.from(rowsContainer.children).filter(row => {
        const b = row.getBoundingClientRect();
        return b.bottom - timelineTop > lo && b.top - timelineTop < hi;
    });
}

// Pega el tiempo a bordes de clips, al inicio y al cabezal si están muy cerca
function snapTime(t) {
    const tol = SNAP_PX / PX_PER_SEC;
    let best = t;
    let bestD = tol;
    const consider = (c) => {
        const d = Math.abs(c - t);
        if (d < bestD) { bestD = d; best = c; }
    };
    consider(0);
    consider(clock.t);
    forEachClipBottomUp(clip => {
        consider(clip.start);
        consider(clip.start + clip.duration);
    });
    return best;
}

function updateTrimSelection() {
    const d = trimDrag;
    if (!d) return;

    const tl = timelineEl.getBoundingClientRect();
    const cx = d.lastX - tl.left;
    const cy = d.lastY - tl.top;
    const maxT = timelineSeconds();
    const toTime = (x) => snapTime(Math.min(maxT, Math.max(0, (x - 1) / PX_PER_SEC)));

    const a = toTime(Math.min(d.x0, cx));
    const b = toTime(Math.max(d.x0, cx));
    const rows = trimRowsBetween(d.y0, cy, tl.top);
    d.t0 = a;
    d.t1 = b;
    d.rows = rows;

    if (!rows.length) {
        trimSelection.style.display = 'none';
        return;
    }

    // El cuadro cubre las filas completas que se van a recortar
    const top = rows[0].getBoundingClientRect().top - tl.top;
    const bottom = rows[rows.length - 1].getBoundingClientRect().bottom - tl.top;
    trimSelection.style.display = 'block';
    trimSelection.style.left = `${a * PX_PER_SEC + 1}px`;
    trimSelection.style.width = `${Math.max(0, (b - a) * PX_PER_SEC)}px`;
    trimSelection.style.top = `${top}px`;
    trimSelection.style.height = `${bottom - top}px`;
    trimSelectionLabel.textContent = `${(b - a).toFixed(1)} s`;
}

function onTrimMove(ev) {
    if (!trimDrag) return;
    trimDrag.lastX = ev.clientX;
    trimDrag.lastY = ev.clientY;
    updateTrimSelection();
}

function onTrimScroll() {
    updateTrimSelection(); // Si la página se desplaza con el cuadro en curso, se recalcula
}

function onTrimUp(ev) {
    const d = trimDrag;
    if (!d) return;
    d.lastX = ev.clientX;
    d.lastY = ev.clientY;
    updateTrimSelection();

    const { t0, t1, rows } = d;
    endTrimDrag();
    if (t1 - t0 >= MIN_TRIM && rows.length) applyTrim(t0, t1, rows);
}

function endTrimDrag() {
    window.removeEventListener('pointermove', onTrimMove);
    window.removeEventListener('pointerup', onTrimUp);
    window.removeEventListener('pointercancel', endTrimDrag);
    window.removeEventListener('scroll', onTrimScroll, true);
    trimDrag = null;
    trimSelection.style.display = 'none';
}

timelineEl.addEventListener('pointerdown', (e) => {
    if (!trimMode || trimBusy || exporting || !currentProjectId || e.button !== 0) return;

    const tl = timelineEl.getBoundingClientRect();
    const y0 = e.clientY - tl.top;
    if (!trimRowsBetween(y0, y0, tl.top).length) return; // Solo se empieza a dibujar dentro de las filas

    e.preventDefault();
    hideMenus();
    endTrimDrag();
    trimDrag = { x0: e.clientX - tl.left, y0, lastX: e.clientX, lastY: e.clientY, t0: 0, t1: 0, rows: [] };

    window.addEventListener('pointermove', onTrimMove);
    window.addEventListener('pointerup', onTrimUp);
    window.addEventListener('pointercancel', endTrimDrag);
    window.addEventListener('scroll', onTrimScroll, true);
    updateTrimSelection();
});

// --- El corte ----------------------------------------------------------------

// Calcula (sin tocar nada) qué le pasa a cada clip de una fila al borrar el tramo [t0, t1].
// Cada entrada: { clip, kind, parts }  →  parts[0] es el nuevo estado del clip y, si es un
// 'split', parts[1] es el de la mitad derecha (que será un clip nuevo).
//   remove: el clip cae por completo dentro del tramo
//   trim:   se recorta por la izquierda o por la derecha
//   split:  el tramo cae en el medio: queda una mitad a cada lado
//   shift:  está a la derecha del tramo: se corre hacia la izquierda
function planRowCut(row, t0, t1) {
    const delta = t1 - t0;
    const plan = [];
    let touched = false;

    for (const el of Array.from(row.children)) {
        const clip = el._clip;
        if (!clip) continue;

        const s = clip.start;
        const e = clip.start + clip.duration;

        if (e <= t0 + EPS) continue; // Termina antes del corte: no cambia

        if (s >= t1 - EPS) {         // Empieza después del corte: se corre a la izquierda
            plan.push({
                clip,
                kind: 'shift',
                parts: [{ start: Math.max(0, s - delta), srcStart: clip.srcStart, duration: clip.duration }]
            });
            continue;
        }

        touched = true;
        const hasLeft = s < t0 - EPS;
        const hasRight = e > t1 + EPS;
        const left = { start: s, srcStart: clip.srcStart, duration: t0 - s };
        const right = { start: t0, srcStart: clip.srcStart + (t1 - s), duration: e - t1 };

        if (hasLeft && hasRight) plan.push({ clip, kind: 'split', parts: [left, right] });
        else if (hasLeft) plan.push({ clip, kind: 'trim', parts: [left] });
        else if (hasRight) plan.push({ clip, kind: 'trim', parts: [right] });
        else plan.push({ clip, kind: 'remove', parts: [] });
    }

    return touched ? plan : []; // Si el cuadro no tocó ningún video, la fila no cambia
}

function setClipSpan(clip, part) {
    clip.start = part.start;
    clip.srcStart = part.srcStart;
    clip.duration = part.duration;
}

// <video> nuevo para un fragmento: espera a que tenga datos antes de devolverlo
function openClipVideo(url, isAudio = false) {
    return new Promise((resolve) => {
        const v = document.createElement(isAudio ? 'audio' : 'video');
        v.preload = 'auto';
        v.playsInline = true;

        let done = false;
        const finish = (ok) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            v.removeEventListener('loadeddata', onLoad);
            v.removeEventListener('error', onError);
            if (ok) {
                attachSeekedRender(v);
                resolve(v);
            } else {
                v.removeAttribute('src');
                v.load();
                resolve(null);
            }
        };
        const onLoad = () => finish(isAudio || !!v.videoWidth); // Un audio no tiene videoWidth
        const onError = () => finish(false);
        const timer = setTimeout(() => finish(false), 20000);

        v.addEventListener('loadeddata', onLoad);
        v.addEventListener('error', onError);
        v.src = url;
    });
}

// Nuevo clip que comparte archivo (y tira de fotogramas) con el original
function createFragmentClip(parent, video) {
    return {
        id: `clip_${Date.now()}_${++clipSeq}`,
        name: parent.name,
        type: parent.type,       // 'audio' en los fragmentos de un audio
        color: parent.color,     // Color del oscilograma
        url: parent.url,
        video,
        duration: 0,
        aspect: parent.aspect,
        source: parent.source,
        srcStart: 0,
        start: 0,
        chroma: parent.chroma,
        chromaManual: parent.chromaManual,
        muted: parent.muted,
        locked: false,
        el: null,
        thumbs: null,
        thumbCtx: null,
        thumbKey: '',
        disposed: false,
        badge: null
    };
}

function discardFragment(clip) {
    clip.video.removeAttribute('src');
    clip.video.load();
}

// Deja el video en el segundo pedido y espera a que ese frame esté listo para dibujarse
async function prepareVideoAt(v, t) {
    if (!v.seeking && v.readyState >= 2 && Math.abs(v.currentTime - t) <= 0.03) return true;
    return seekVideo(v, t, 8000);
}

async function applyTrim(t0, t1, rows) {
    if (trimBusy || !currentProjectId) return;

    const projectId = currentProjectId;
    const project = currentProject();

    // 1) Qué le pasa a cada clip. Las filas bloqueadas (o con clips bloqueados) no se tocan.
    const plans = [];
    for (const row of rows) {
        if (row.classList.contains('locked')) continue;
        const plan = planRowCut(row, t0, t1);
        if (!plan.length) continue;
        if (plan.some(p => p.clip.locked)) continue;
        plans.push({ row, plan });
    }
    if (!plans.length) return;

    trimBusy = true;
    renderFrozen = true; // La vista previa conserva su último cuadro hasta que todo esté listo
    trimBanner.textContent = 'Recortando… un momento';

    const created = [];
    let applied = false;

    try {
        // 2) Un <video> nuevo por cada mitad derecha (cada fragmento tiene el suyo)
        for (const { plan } of plans) {
            for (const p of plan) {
                if (p.kind !== 'split') continue;
                const video = await openClipVideo(p.clip.url, p.clip.type === 'audio');
                if (!video) throw new Error('No se pudo abrir el video para el recorte');
                p.newClip = createFragmentClip(p.clip, video);
                created.push(p.newClip);
            }
        }
        if (projectId !== currentProjectId) throw new Error('cancelado'); // Salió del proyecto

        // 3) Deja listos los frames que se verán bajo el cabezal con la nueva disposición,
        //    y cada fragmento nuevo en su primer frame
        const at = clock.t;
        const jobs = [];
        for (const { plan } of plans) {
            for (const p of plan) {
                if (p.kind === 'remove') continue;

                const finals = [{ clip: p.clip, part: p.parts[0], isNew: false }];
                if (p.newClip) finals.push({ clip: p.newClip, part: p.parts[1], isNew: true });

                for (const { clip, part, isNew } of finals) {
                    const local = at - part.start;
                    const v = clip.video;
                    if (local >= 0 && local < part.duration) {
                        jobs.push(prepareVideoAt(v, part.srcStart + local));
                    } else if (isNew) {
                        jobs.push(prepareVideoAt(v, part.srcStart));
                    } else if (local < 0 && Math.abs(v.currentTime - part.srcStart) > 0.05) {
                        v.currentTime = part.srcStart; // Se va dejando listo, sin esperar
                    }
                }
            }
        }
        await Promise.all(jobs);
        if (projectId !== currentProjectId) throw new Error('cancelado');

        // 4) Aplica todo de una vez (sin esperas): datos y pantalla cambian juntos
        for (const { row, plan } of plans) {
            for (const p of plan) {
                if (p.kind === 'remove') {
                    p.clip.video.pause();
                    p.clip.el.remove(); // El clip sigue guardado: Ctrl+Z lo recupera
                    continue;
                }

                setClipSpan(p.clip, p.parts[0]);
                layoutClip(p.clip);

                if (p.newClip) {
                    project.clips[p.newClip.id] = p.newClip;
                    setClipSpan(p.newClip, p.parts[1]);
                    placeClip(row, p.newClip);
                    row.insertBefore(p.newClip.el, p.clip.el.nextSibling); // Queda justo después de su mitad izquierda
                }
            }
        }
        applied = true;

        if (audioCtx) ensureAudioGraph(); // Conecta el audio de los fragmentos nuevos
        commit();                         // Un solo paso de historial: Ctrl+Z deshace el corte completo
    } catch (err) {
        // Antes del paso 4 no se tocó nada: solo se descartan los <video> que se habían abierto
        if (!applied) created.forEach(discardFragment);
        if (err.message !== 'cancelado') {
            console.error(err);
            alert('No se pudo hacer el recorte. No se modificó nada.');
        }
    } finally {
        renderFrozen = false;
        trimBusy = false;
        if (trimMode) trimBanner.textContent = TRIM_HINT;
        if (currentProjectId) refreshPreview(); // Dibuja el resultado ya con todos los frames listos
    }
}

// --- Inicio ---
setTimelineWidth(500);
updatePlayhead();
