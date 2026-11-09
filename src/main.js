const { invoke } = window.__TAURI__.core;

// Variable global para mantener las secciones actuales en JS
let seccionesActuales = [];
let ingredientesConsolidados = []; 

// --- ÚNICO BLOQUE DOMContentLoaded ---
window.addEventListener('DOMContentLoaded', () => {
    const btnAddSection = document.getElementById('btnAddSection');
    const sectionList = document.getElementById('sectionList');
    const btnSaveGroup = document.getElementById('btnSaveGroup');
    const btnNewGroup = document.getElementById('btnNewGroup');
    const btnAdjust = document.getElementById('btnAdjust');
    const btnAddExcel = document.getElementById('btnAddExcel');
    const btnProcesarSeleccionadas = document.getElementById('btnProcesarSeleccionadas');
    const btnCalcularTotal = document.getElementById('btnCalcularTotal');

    if (btnCalcularTotal) {
        btnCalcularTotal.addEventListener('click', async () => {
            if (ingredientesConsolidados.length === 0) {
                alert('Primero procesa algunas hojas para obtener ingredientes.');
                return;
            }

            if (seccionesActuales.length === 0) {
                alert('Agrega al menos una sección antes de calcular el total.');
                return;
            }

            try {
                const conTotales = await invoke('calcular_total', {
                    ingredientes: ingredientesConsolidados,
                    secciones: seccionesActuales
                });

                pintarTablaConsolidadaConTotal(conTotales);
            } catch (error) {
                console.error('Error al calcular total:', error);
                alert('Error al calcular total: ' + error);
            }
        });
    }

    if (btnAddExcel) {
        btnAddExcel.addEventListener('click', async () => {
            try {
                const selected = await window.__TAURI__.dialog.open({
                    multiple: true,
                    filters: [{ name: 'Archivos Excel', extensions: ['xlsx', 'xls'] }]
                });

                if (selected && selected.length > 0) {
                    await invoke('guardar_archivos_recientes', { rutas: selected });
                    await cargarArchivosRecientes();
                }
            } catch (error) {
                console.error("Error al agregar Excel:", error);
            }
        });
    }

    // --- NUEVO: Procesar todas las hojas seleccionadas ---
    if (btnProcesarSeleccionadas) {
        btnProcesarSeleccionadas.addEventListener('click', async () => {
            const hojasMarcadas = document.querySelectorAll('.chk-sheet:checked');

            if (hojasMarcadas.length === 0) {
                alert('No hay hojas seleccionadas.');
                return;
            }

            const tbody = document.getElementById('tablaConsolidadaBody');
            if (!tbody) return;

            tbody.innerHTML = `<tr><td colspan="4">Procesando...</td></tr>`;

            // Agrupamos las hojas por archivo (ruta)
            const hojasPorArchivo = {};
            hojasMarcadas.forEach(chk => {
                const detalles = chk.closest('details');
                const ruta = detalles.dataset.ruta;
                if (!hojasPorArchivo[ruta]) hojasPorArchivo[ruta] = [];
                hojasPorArchivo[ruta].push(chk.dataset.hoja);
            });

            let todosLosDatos = [];

            // Procesamos archivo por archivo
            for (const [ruta, hojas] of Object.entries(hojasPorArchivo)) {
                try {
                    const datos = await invoke('procesar_hojas_excel', {
                        ruta: ruta,
                        nombresHojas: hojas // Enviamos el array de hojas de este archivo
                    });
                    todosLosDatos = todosLosDatos.concat(datos);
                } catch (error) {
                    console.error(`Error procesando archivo ${ruta}:`, error);
                }
            }

            if (todosLosDatos.length > 0) {
                ingredientesConsolidados = todosLosDatos;
                pintarTablaConsolidada(todosLosDatos);
            } else {
                tbody.innerHTML = '<tr><td colspan="4">No se obtuvieron datos.</td></tr>';
            }
        });
    }

    if (btnAdjust && sectionList) {
        btnAdjust.addEventListener('click', async () => {
            try {
                const seccionesAjustadas = await invoke('auto_ajustar_proporciones', {
                    secciones: seccionesActuales
                });
                renderizarSecciones(seccionesAjustadas, sectionList);
            } catch (error) {
                console.error("Error al auto ajustar:", error);
                alert("Error al calcular las proporciones: " + error);
            }
        });
    }

    if (btnNewGroup) {
        btnNewGroup.addEventListener('click', () => {
            const inputTitulo = document.getElementById('groupTitle');
            if (inputTitulo) inputTitulo.value = "Nuevo Grupo";
            seccionesActuales = [];
            if (sectionList) renderizarSecciones([], sectionList);
            document.activeElement.blur();
        });
    }

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

    if (btnSaveGroup) {
        btnSaveGroup.addEventListener('click', async (event) => {
            event.preventDefault();

            const inputNombre = document.getElementById('groupTitle');
            const nombreGrupo = inputNombre.value.trim();

            if (!nombreGrupo) {
                alert("El nombre del grupo no puede estar vacío.");
                return;
            }

            if (nombreGrupo.toLowerCase() === "nuevo grupo" || nombreGrupo.toLowerCase() === "nombre de grupo") {
                alert("Por favor, cambia el nombre por defecto antes de guardar.");
                return;
            }

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

    cargarArchivosRecientes();
    cargarGruposGuardados();
});

function renderizarSecciones(secciones, contenedor) {
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
    const inputTitulo = document.getElementById('groupTitle');
    if (inputTitulo) inputTitulo.value = grupo.nombre;
    const sectionList = document.getElementById('sectionList');
    if (sectionList) renderizarSecciones(grupo.secciones, sectionList);
    console.log(`Grupo "${grupo.nombre}" cargado en el editor.`);
}

async function cargarArchivosRecientes() {
    const fileList = document.getElementById('fileList');
    if (!fileList) return;

    try {
        const archivos = await invoke('obtener_archivos_recientes');
        fileList.innerHTML = '';

        archivos.forEach(archivo => {
            const detalles = document.createElement('details');
            detalles.className = 'excel-file-details';

            const nombreArchivo = archivo.ruta.split(/[\\/]/).pop();

            detalles.innerHTML = `
                <summary class="excel-file-summary">
                    <input type="checkbox" class="chk-file" title="Seleccionar todas las hojas">
                    <svg class="icon xlsx" viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                        <polyline points="14 2 14 8 20 8"/>
                        <line x1="8" y1="13" x2="16" y2="13"/>
                        <line x1="8" y1="17" x2="16" y2="17"/>
                    </svg>
                    <span>${nombreArchivo}</span>
                </summary>
                <ul class="sheets-list">
                    <li class="loading-text">Cargando hojas...</li>
                </ul>
            `;

            detalles.dataset.ruta = archivo.ruta;

            const chkFile = detalles.querySelector('.chk-file');

            chkFile.addEventListener('change', (e) => {
                const isChecked = e.target.checked;
                const chkHojas = detalles.querySelectorAll('.chk-sheet');
                chkHojas.forEach(chk => {
                    chk.checked = isChecked;
                });
            });

            detalles.addEventListener('toggle', async () => {
                const ul = detalles.querySelector('.sheets-list');
                if (detalles.open && ul.children.length === 1 && ul.innerHTML.includes('Cargando')) {
                    try {
                        const hojas = await invoke('obtener_hojas_excel', { ruta: archivo.ruta });
                        ul.innerHTML = '';

                        hojas.forEach(nombreHoja => {
                            const liHoja = document.createElement('li');
                            liHoja.className = 'sheet-item';

                            liHoja.innerHTML = `
                                <div style="display: flex; align-items: center; gap: 8px; width: 100%;">
                                    <input type="checkbox" class="chk-sheet" data-hoja="${nombreHoja}">
                                    <span class="sheet-name" style="cursor: pointer; flex: 1;">${nombreHoja}</span>
                                </div>
                            `;

                            const chkSheet = liHoja.querySelector('.chk-sheet');
                            chkSheet.addEventListener('change', () => {
                                const todasLasHojas = Array.from(detalles.querySelectorAll('.chk-sheet'));
                                const todasMarcadas = todasLasHojas.every(chk => chk.checked);
                                const algunaMarcada = todasLasHojas.some(chk => chk.checked);

                                chkFile.checked = todasMarcadas;
                                chkFile.indeterminate = algunaMarcada && !todasMarcadas;
                            });

                            // Ya NO hay listener de clic en .sheet-name.
                            // El procesamiento lo dispara el botón #btnProcesarSeleccionadas.

                            ul.appendChild(liHoja);
                        });
                    } catch (error) {
                        ul.innerHTML = `<li class="error-text">Error al leer el archivo</li>`;
                    }
                }
            });

            fileList.appendChild(detalles);
        });
    } catch (error) {
        console.error("Error al cargar archivos recientes:", error);
    }
}

function pintarTablaConsolidada(datos) {
    const tbody = document.getElementById('tablaConsolidadaBody');
    if (!tbody) return;
    tbody.innerHTML = '';

    datos.forEach(item => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td><strong>${item.nombre}</strong></td>
            <td>${item.unidad}</td>
            <td>${item.cantidad.toFixed(2)}</td>
            <td style="color:#999;">—</td>
            <td>
                <input type="text" class="input-comentario" placeholder="Escribe un comentario..." style="width: 100%; border: 1px solid #ccc; border-radius: 4px; padding: 4px; font-size: 12px;">
            </td>
        `;
        tbody.appendChild(tr);
    });
}
function pintarTablaConsolidadaConTotal(datos) {
    const tbody = document.getElementById('tablaConsolidadaBody');
    if (!tbody) return;
    tbody.innerHTML = '';

    datos.forEach(item => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td><strong>${item.nombre}</strong></td>
            <td>${item.unidad}</td>
            <td>${item.cantidad.toFixed(2)}</td>
            <td><strong style="color: #2563eb;">${item.cantidad_total.toFixed(2)}</strong></td>
            <td>
                <input type="text" class="input-comentario" placeholder="Escribe un comentario..." style="width: 100%; border: 1px solid #ccc; border-radius: 4px; padding: 4px; font-size: 12px;">
            </td>
        `;
        tbody.appendChild(tr);
    });
}