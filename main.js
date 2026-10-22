const grid = document.getElementById('projectGrid');
const addBtn = document.getElementById('addProjectBtn');

// Elementos de la vista y navegación
const mainView = document.getElementById('mainView');
const projectDetailView = document.getElementById('projectDetailView');
const currentProjectTitle = document.getElementById('currentProjectTitle');
const backBtn = document.getElementById('backBtn');

let projectCount = 0;

// Evento para volver al menú de proyectos
backBtn.addEventListener('click', () => {
    projectDetailView.classList.add('hidden');
    mainView.classList.remove('hidden');
});

addBtn.addEventListener('click', () => {
    projectCount++;
    
    // Crear el contenedor de la tarjeta del proyecto
    const card = document.createElement('div');
    card.className = 'project-card';

    // Crear el cuadro blanco con bordes redondeados
    const box = document.createElement('div');
    box.className = 'project-box';

    // Crear el campo de texto editable para el nombre
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'project-name';
    input.value = `Proyecto ${projectCount}`;

    // Evento para abrir el menú exclusivo al hacer clic en el cuadro (box)
    box.addEventListener('click', () => {
        // Asigna el texto actual del input como título del proyecto
        currentProjectTitle.textContent = input.value || 'Sin título';
        
        // Muestra la vista del proyecto y oculta el menú principal
        mainView.classList.add('hidden');
        projectDetailView.classList.remove('hidden');
    });

    // Detener la propagación en el input para que al hacer click para renombrar no abra el proyecto
    input.addEventListener('click', (e) => {
        e.stopPropagation();
    });

    // Ensamblar la tarjeta y añadirla a la cuadrícula
    card.appendChild(box);
    card.appendChild(input);
    grid.appendChild(card);
});