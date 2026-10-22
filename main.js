const grid = document.getElementById('projectGrid');
const addBtn = document.getElementById('addProjectBtn');

// Elementos de la vista y navegación
const mainView = document.getElementById('mainView');
const projectDetailView = document.getElementById('projectDetailView');
const currentProjectTitle = document.getElementById('currentProjectTitle');
const backBtn = document.getElementById('backBtn');
const addRowBtn = document.getElementById('addRowBtn');
const rowsContainer = document.getElementById('rowsContainer');

const undoBtn = document.getElementById('undoBtn');
const redoBtn = document.getElementById('redoBtn');

// Estructura de almacenamiento en memoria
let projects = {}; 
let currentProjectId = null;
let projectCount = 0;
let draggedRow = null;

// --- Sistema Undo / Redo ---
let undoStack = [];
let redoStack = [];

function recordState() {
    if (!currentProjectId || !projects[currentProjectId]) return;

    // Captura el estado actual de las filas y del ancho
    const state = {
        rowsWidth: rowsContainer.style.width || '500px',
        rows: Array.from(rowsContainer.children).map(row => ({
            muted: row.classList.contains('muted'),
            locked: row.classList.contains('locked')
        }))
    };

    undoStack.push(JSON.stringify(state));
    redoStack = []; // Limpiar rehacer cuando se realiza una nueva acción
}

function undo() {
    if (undoStack.length <= 1) return; // Mantener al menos el estado inicial

    const currentState = undoStack.pop();
    redoStack.push(currentState);

    const previousState = JSON.parse(undoStack[undoStack.length - 1]);
    applyState(previousState);
}

function redo() {
    if (redoStack.length === 0) return;

    const nextState = redoStack.pop();
    undoStack.push(nextState);

    applyState(JSON.parse(nextState));
}

function applyState(state) {
    rowsContainer.style.width = state.rowsWidth;
    rowsContainer.innerHTML = '';

    state.rows.forEach(rowData => {
        const row = createRowElement(false);
        if (rowData.muted) row.classList.add('muted');
        if (rowData.locked) row.classList.add('locked');
    });

    saveCurrentProjectRows();
}

// Atajos de teclado (Ctrl + Z, Ctrl + Y, Ctrl + Shift + Z)
document.addEventListener('keydown', (e) => {
    if (!currentProjectId) return; // Solo actuar dentro de un proyecto

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        if (e.shiftKey) {
            redo();
        } else {
            undo();
        }
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        redo();
    }
});

undoBtn.addEventListener('click', undo);
redoBtn.addEventListener('click', redo);

// --- Funciones de Navegación ---
function showMainView(pushToHistory = true) {
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
    
    // Reiniciar historial para el proyecto actual
    undoStack = [];
    redoStack = [];

    loadProjectRows(project);
    recordState(); // Estado inicial

    mainView.classList.add('hidden');
    projectDetailView.classList.remove('hidden');

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

// --- Lógica de Proyectos ---
addBtn.addEventListener('click', () => {
    projectCount++;
    const id = `proj_${Date.now()}`;

    projects[id] = {
        id: id,
        name: `Proyecto ${projectCount}`,
        rowsWidth: '500px',
        rowsData: []
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

// --- Gestión de Filas por Proyecto ---
function saveCurrentProjectRows() {
    if (!currentProjectId || !projects[currentProjectId]) return;
    
    projects[currentProjectId].rowsWidth = rowsContainer.style.width || '500px';
    projects[currentProjectId].rowsData = Array.from(rowsContainer.children).map(row => ({
        muted: row.classList.contains('muted'),
        locked: row.classList.contains('locked')
    }));
}

function loadProjectRows(project) {
    rowsContainer.innerHTML = '';
    rowsContainer.style.width = project.rowsWidth || '500px';

    if (project.rowsData && project.rowsData.length > 0) {
        project.rowsData.forEach(data => {
            const row = createRowElement(false);
            if (data.muted) row.classList.add('muted');
            if (data.locked) row.classList.add('locked');
        });
    }
}

addRowBtn.addEventListener('click', () => {
    if (!currentProjectId) return;
    createRowElement(true);
});

function createRowElement(record = true) {
    const row = document.createElement('div');
    row.className = 'row-item';
    
    const handleLeft = document.createElement('div');
    handleLeft.className = 'row-handle left';
    
    const handleRight = document.createElement('div');
    handleRight.className = 'row-handle right';
    
    row.appendChild(handleLeft);
    row.appendChild(handleRight);
    
    row.draggable = true;
    
    row.addEventListener('dragstart', (e) => {
        draggedRow = row;
        e.dataTransfer.effectAllowed = 'move';
        setTimeout(() => row.classList.add('dragging'), 0);
    });
    
    row.addEventListener('dragend', () => {
        row.classList.remove('dragging');
        draggedRow = null;
        saveCurrentProjectRows();
        recordState();
    });
    
    row.addEventListener('dragover', (e) => {
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
    rowsContainer.appendChild(row);

    saveCurrentProjectRows();
    if (record) recordState();

    return row;
}

// Redimensionamiento (Estiramiento y Acortamiento)
function setupResizeHandlers(leftHandle, rightHandle) {
    const initResize = (e, direction) => {
        e.preventDefault();
        const startX = e.clientX;
        const startWidth = rowsContainer.offsetWidth;

        const onMouseMove = (moveEvent) => {
            const deltaX = moveEvent.clientX - startX;
            let newWidth = direction === 'right' ? startWidth + deltaX : startWidth - deltaX;

            if (newWidth > 100) {
                rowsContainer.style.width = `${newWidth}px`;
            }
        };

        const onMouseUp = () => {
            saveCurrentProjectRows();
            recordState(); // Registra el cambio de estiramiento/acortamiento en el historial
            window.removeEventListener('mousemove', onMouseMove);
            window.removeEventListener('mouseup', onMouseUp);
        };

        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', onMouseUp);
    };

    leftHandle.addEventListener('mousedown', (e) => initResize(e, 'left'));
    rightHandle.addEventListener('mousedown', (e) => initResize(e, 'right'));
}

// Menú contextual flotante para Filas
// --- Menú contextual flotante para Filas ---
const contextMenu = document.createElement('div');
contextMenu.className = 'context-menu';
contextMenu.innerHTML = `
    <div class="context-menu-item" id="muteRowOption">Silenciar</div>
    <div class="context-menu-item" id="unmuteRowOption">Sonorizar</div>
    <div class="context-menu-item" id="lockRowOption">Bloquear</div>
    <div class="context-menu-item danger" id="deleteRowOption">Borrar</div>
`;
document.body.appendChild(contextMenu);

let rowTarget = null;

function showContextMenu(x, y, row) {
    rowTarget = row;
    projectContextMenu.style.display = 'none';

    // Cambiar dinámicamente el texto y acción de Bloquear/Desbloquear según el estado
    const lockOption = document.getElementById('lockRowOption');
    if (row.classList.contains('locked')) {
        lockOption.textContent = 'Desbloquear';
    } else {
        lockOption.textContent = 'Bloquear';
    }

    contextMenu.style.left = `${x}px`;
    contextMenu.style.top = `${y}px`;
    contextMenu.style.display = 'block';
}

document.addEventListener('click', () => {
    contextMenu.style.display = 'none';
});

// Opciones del Menú Contextual de Filas
document.getElementById('muteRowOption').addEventListener('click', () => {
    if (rowTarget) {
        rowTarget.classList.add('muted');
        saveCurrentProjectRows();
        recordState();
    }
});

document.getElementById('unmuteRowOption').addEventListener('click', () => {
    if (rowTarget) {
        rowTarget.classList.remove('muted');
        saveCurrentProjectRows();
        recordState();
    }
});

document.getElementById('lockRowOption').addEventListener('click', () => {
    if (rowTarget) {
        // Alterna el estado de bloqueo
        rowTarget.classList.toggle('locked');
        saveCurrentProjectRows();
        recordState();
    }
});

document.getElementById('deleteRowOption').addEventListener('click', () => {
    if (rowTarget) {
        rowTarget.remove();
        rowTarget = null;
        saveCurrentProjectRows();
        recordState(); // Permite recuperar la fila eliminada con Ctrl+Z
    }
});

// --- Menú contextual flotante para Proyectos ---
const projectContextMenu = document.createElement('div');
projectContextMenu.className = 'context-menu';
projectContextMenu.innerHTML = `<div class="context-menu-item danger" id="deleteProjectOption">Borrar proyecto</div>`;
document.body.appendChild(projectContextMenu);

let projectToDeleteId = null;
let cardToDelete = null;

function showProjectContextMenu(x, y, projectId, cardElement) {
    projectToDeleteId = projectId;
    cardToDelete = cardElement;
    
    contextMenu.style.display = 'none';

    projectContextMenu.style.left = `${x}px`;
    projectContextMenu.style.top = `${y}px`;
    projectContextMenu.style.display = 'block';
}

document.addEventListener('click', (e) => {
    if (!projectContextMenu.contains(e.target)) {
        projectContextMenu.style.display = 'none';
    }
});

document.getElementById('deleteProjectOption').addEventListener('click', () => {
    if (projectToDeleteId && cardToDelete) {
        delete projects[projectToDeleteId];
        cardToDelete.remove();
        projectToDeleteId = null;
        cardToDelete = null;
        projectContextMenu.style.display = 'none';
    }
});