const { invoke } = window.__TAURI__.core;

// Variable global para mantener las secciones actuales en JS
let seccionesActuales = [];

// --- ÚNICO BLOQUE DOMContentLoaded ---
window.addEventListener('DOMContentLoaded', () => {
    const btnAddSection = document.getElementById('btnAddSection');
    const sectionList = document.getElementById('sectionList');
    const btnSaveGroup = document.getElementById('btnSaveGroup');
    const btnNewGroup = document.getElementById('btnNewGroup');
    
    // 1. Lógica del botón "Nuevo"
    if (btnNewGroup) {
        btnNewGroup.addEventListener('click', () => {
            const inputTitulo = document.getElementById('groupTitle');
            if (inputTitulo) inputTitulo.value = "Nuevo Grupo";
            seccionesActuales = []; 
            if (sectionList) renderizarSecciones([], sectionList);
            document.activeElement.blur();
        });
    }

    // 2. Lógica del botón "Agregar Sección"
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

    // 3. Lógica del botón "Guardar" (CON VALIDACIÓN)
    if (btnSaveGroup) {
        btnSaveGroup.addEventListener('click', async (event) => {
            event.preventDefault(); 

            const inputNombre = document.getElementById('groupTitle');
            const nombreGrupo = inputNombre.value.trim();
            
            // Validaciones
            if (!nombreGrupo) {
                alert("El nombre del grupo no puede estar vacío.");
                return; 
            }

            if (nombreGrupo.toLowerCase() === "nuevo grupo" || nombreGrupo.toLowerCase() === "nombre de grupo") {
                alert("Por favor, cambia el nombre por defecto antes de guardar.");
                return; 
            }

            // Guardado
            try {
                await invoke('guardar_grupo', {
                    nombreGrupo: nombreGrupo,
                    secciones: seccionesActuales
                });
                alert("Grupo guardado exitosamente.");
                await cargarGruposGuardados(); 
            } catch (error) {
                alert("Error al guardar el grupo: " + error);
            }
        });
    }

    // ¡Cargar los grupos al iniciar la app!
    cargarGruposGuardados();
});

function renderizarSecciones(secciones, contenedor) {
    // ... (tu función renderizarSecciones se queda EXACTAMENTE IGUAL) ...
    seccionesActuales = JSON.parse(JSON.stringify(secciones)); 
    contenedor.innerHTML = ''; 
    seccionesActuales.forEach(seccion => {
        const li = document.createElement('li');
        li.innerHTML = `
            <span class="section-name">${seccion.nombre}</span>
            <input class="input-alumnos" type="number" value="${seccion.alumnos}" min="0" data-id="${seccion.id}">
            <div class="proporcion-wrapper">
                <input class="input-proporcion" type="number" value="${seccion.proporcion}" min="0" max="100" data-id="${seccion.id}">
                <span class="proporcion-symbol">%</span>
            </div>
            <button class="btn-delete-section" data-id="${seccion.id}" title="Eliminar sección">
                <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg>
            </button>
        `;
        const inputAlumnos = li.querySelector('.input-alumnos');
        const inputProporcion = li.querySelector('.input-proporcion');
        inputAlumnos.addEventListener('input', (e) => {
            const id = parseInt(e.target.dataset.id);
            const sec = seccionesActuales.find(s => s.id === id);
            if (sec) sec.alumnos = parseInt(e.target.value) || 0;
        });
        inputProporcion.addEventListener('input', (e) => {
            const id = parseInt(e.target.dataset.id);
            const sec = seccionesActuales.find(s => s.id === id);
            if (sec) sec.proporcion = parseFloat(e.target.value) || 0.0;
        });
        contenedor.appendChild(li);
    });
}

async function cargarGruposGuardados() {
    // ... (tu función cargarGruposGuardados se queda EXACTAMENTE IGUAL) ...
    const savedList = document.getElementById('savedList');
    if (!savedList) return;

    try {
        const grupos = await invoke('obtener_grupos_guardados');
        savedList.innerHTML = '';

        grupos.forEach((grupo, index) => {
            const li = document.createElement('li');
            li.innerHTML = `
                <span class="saved-name">${grupo.nombre}</span>
                <button class="btn-use-group" data-index="${index}" type="button">Usar</button>
                <button class="btn-delete-saved" data-nombre="${grupo.nombre}" title="Eliminar grupo">
                    <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg>
                </button>
            `;
            savedList.appendChild(li);
        });

        document.querySelectorAll('.btn-use-group').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const button = e.target.closest('.btn-use-group');
                const index = parseInt(button.dataset.index);
                usarGrupoGuardado(grupos[index]); 
            });
        });

        document.querySelectorAll('.btn-delete-saved').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const button = e.target.closest('.btn-delete-saved');
                const nombre = button.dataset.nombre;
                if (confirm(`¿Estás seguro de que quieres eliminar el grupo "${nombre}"?`)) {
                    try {
                        await invoke('eliminar_grupo', { nombreGrupo: nombre });
                        await cargarGruposGuardados(); 
                    } catch (error) {
                        alert("Error al eliminar el grupo: " + error);
                    }
                }
            });
        });

    } catch (error) {
        console.error("Error al cargar grupos guardados:", error);
    }
}

function usarGrupoGuardado(grupo) {
    // ... (tu función usarGrupoGuardado se queda EXACTAMENTE IGUAL) ...
    const inputTitulo = document.getElementById('groupTitle');
    if (inputTitulo) inputTitulo.value = grupo.nombre;
    const sectionList = document.getElementById('sectionList');
    if (sectionList) renderizarSecciones(grupo.secciones, sectionList);
    console.log(`Grupo "${grupo.nombre}" cargado en el editor.`);
}