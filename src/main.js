const { invoke } = window.__TAURI__.core;
//import { invoke } from '@tauri-apps/api/core';

window.addEventListener('DOMContentLoaded', () => {
    const btnAddSection = document.getElementById('btnAddSection');
    const sectionList = document.getElementById('sectionList');

    if (btnAddSection && sectionList) {
        btnAddSection.addEventListener('click', async () => {
            try {
                const seccionesActualizadas = await invoke('agregar_seccion');
                renderizarSecciones(seccionesActualizadas, sectionList);
            } catch (error) {
                console.error("Error al agregar sección:", error);
            }
        });
    }
});

function renderizarSecciones(secciones, contenedor) {
    contenedor.innerHTML = ''; 

    secciones.forEach(seccion => {
        const li = document.createElement('li');
        
        // Generamos la estructura EXACTA que espera tu styles.css
        li.innerHTML = `
            <span class="section-name">${seccion.nombre}</span>
            
            <input class="input-alumnos" type="number" value="${seccion.alumnos}" min="0">
            
            <div class="proporcion-wrapper">
                <input class="input-proporcion" type="number" value="${seccion.proporcion}" min="0" max="100">
                <span class="proporcion-symbol">%</span>
            </div>

            <button class="btn-delete-section" data-id="${seccion.id}" title="Eliminar sección">
                <svg class="icon" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M18 6L6 18M6 6l12 12"/>
                </svg>
            </button>
        `;
        
        contenedor.appendChild(li);
    });
}