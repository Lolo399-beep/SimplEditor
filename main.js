const grid = document.getElementById('projectGrid');
const addBtn = document.getElementById('addProjectBtn');

// Elementos de la vista y navegación
const mainView = document.getElementById('mainView');
const projectDetailView = document.getElementById('projectDetailView');
const currentProjectTitle = document.getElementById('currentProjectTitle');
const backBtn = document.getElementById('backBtn');
const addRowBtn = document.getElementById('addRowBtn');
const rowsContainer = document.getElementById('rowsContainer');

// Estructura de almacenamiento en memoria
let projects = {}; 
let currentProjectId = null;
let projectCount = 0;
let draggedRow = null;

// --- Funciones de Navegación ---
function showMainView(pushToHistory = true) {
    // Guardar filas del proyecto actual antes de salir
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
    
    // Cargar las filas exclusivas de este proyecto
    loadProjectRows(project);

    mainView.classList.add('hidden');
    projectDetailView.classList.remove('hidden');

    if (pushToHistory) {
        history.pushState({ view: 'project', id: projectId }, '', `#project-${projectId}`);
    }
}

// Botón Volver
backBtn.addEventListener('click', () => {
    showMainView(true);
});

// Soporte para botones Atrás/Adelante del navegador
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

    // Crear el registro del proyecto en memoria
    projects[id] = {
        id: id,
        name: `Proyecto ${projectCount}`,
        rowsWidth: '500px',
        rowsCount: 0
    };

    // Crear la tarjeta en la interfaz
    const card = document.createElement('div');
    card.className = 'project-card';

    const box = document.createElement('div');
    box.className = 'project-box';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'project-name';
    input.value = projects[id].name;

    // Actualizar nombre en memoria al editar
    input.addEventListener('input', () => {
        projects[id].name = input.value;
    });

    // Abrir proyecto
    box.addEventListener('click', () => {
        openProjectView(id, true);
    });

    input.addEventListener('click', (e) => {
        e.stopPropagation();
    });

    card.appendChild(box);
    card.appendChild(input);
    grid.appendChild(card);
});

// --- Gestión de Filas por Proyecto ---
function saveCurrentProjectRows() {
    if (!currentProjectId || !projects[currentProjectId]) return;
    
    projects[currentProjectId].rowsCount = rowsContainer.children.length;
    projects[currentProjectId].rowsWidth = rowsContainer.style.width || '500px';
}

function loadProjectRows(project) {
    // Limpiar el contenedor de filas previo
    rowsContainer.innerHTML = '';
    rowsContainer.style.width = project.rowsWidth || '500px';

    // Reconstruir la cantidad de filas guardadas para este proyecto
    for (let i = 0; i < project.rowsCount; i++) {
        createRowElement();
    }
}

addRowBtn.addEventListener('click', () => {
    if (!currentProjectId) return;
    createRowElement();
    saveCurrentProjectRows();
});

function createRowElement() {
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
}

// Redimensionamiento
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
            window.removeEventListener('mousemove', onMouseMove);
            window.removeEventListener('mouseup', onMouseUp);
        };

        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', onMouseUp);
    };

    leftHandle.addEventListener('mousedown', (e) => initResize(e, 'left'));
    rightHandle.addEventListener('mousedown', (e) => initResize(e, 'right'));
}

// Menú contextual flotante para eliminar filas
const contextMenu = document.createElement('div');
contextMenu.className = 'context-menu';
contextMenu.innerHTML = `<div class="context-menu-item" id="deleteRowOption">Borrar</div>`;
document.body.appendChild(contextMenu);

let rowToDelete = null;

function showContextMenu(x, y, row) {
    rowToDelete = row;
    contextMenu.style.left = `${x}px`;
    contextMenu.style.top = `${y}px`;
    contextMenu.style.display = 'block';
}

document.addEventListener('click', () => {
    contextMenu.style.display = 'none';
});

document.getElementById('deleteRowOption').addEventListener('click', () => {
    if (rowToDelete) {
        rowToDelete.remove();
        rowToDelete = null;
        saveCurrentProjectRows();
    }
});