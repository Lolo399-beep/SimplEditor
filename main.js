const grid = document.getElementById('projectGrid');
const addBtn = document.getElementById('addProjectBtn');

let projectCount = 0;

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

    // Ensamblar la tarjeta y añadirla a la cuadrícula
    card.appendChild(box);
    card.appendChild(input);
    grid.appendChild(card);
});