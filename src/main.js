const { invoke } = window.__TAURI__.core;

// Variable global para mantener las secciones actuales en JS
let seccionesActuales = [];
let ingredientesConsolidados = []; 
let tituloConsolidado = 'Consolidado de ingredientes';
let diccionarioMaestro = [];

// --- ÚNICO BLOQUE DOMContentLoaded ---
window.addEventListener('DOMContentLoaded', () => {
    const btnAddSection = document.getElementById('btnAddSection');
    const sectionList = document.getElementById('sectionList');
    const btnSaveGroup = document.getElementById('btnSaveGroup');
    const btnNewGroup = document.getElementById('btnNewGroup');
    const btnAdjust = document.getElementById('btnAdjust');
    const btnAddExcel = document.getElementById('btnAddExcel');
    const btnAddDiccionario = document.getElementById('btnAddDiccionario');
    const dictionaryList = document.getElementById('dictionaryList');
    const btnProcesarSeleccionadas = document.getElementById('btnProcesarSeleccionadas');
    const btnLimpiarSeleccion = document.getElementById('btnLimpiarSeleccion');
    const btnCalcularTotal = document.getElementById('btnCalcularTotal');
    const inputTituloConsolidado = document.getElementById('tituloConsolidado');

    if (inputTituloConsolidado) {
        inputTituloConsolidado.value = tituloConsolidado;

        inputTituloConsolidado.addEventListener('input', () => {
            tituloConsolidado = inputTituloConsolidado.value;
        });

        inputTituloConsolidado.addEventListener('blur', () => {
            if (inputTituloConsolidado.value.trim() === '') {
                tituloConsolidado = 'Consolidado de ingredientes';
                inputTituloConsolidado.value = tituloConsolidado;
            } else {
                tituloConsolidado = inputTituloConsolidado.value;
            }
        });
    }

    // Click derecho sobre una fila de ingredientes: menú de colores
    const tablaConsolidadaBody = document.getElementById('tablaConsolidadaBody');
    if (tablaConsolidadaBody) {
        tablaConsolidadaBody.addEventListener('contextmenu', (evento) => {
            const fila = evento.target.closest('tr');
            const celdaNombre = fila ? fila.querySelector('strong') : null;
            if (!celdaNombre) return; // filas de estado sin ingrediente

            evento.preventDefault();
            evento.stopPropagation();

            abrirMenuColores(evento.clientX, evento.clientY, celdaNombre.textContent.trim());
        });
    }

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

    // --- Diccionario maestro (se carga una sola vez y queda en memoria) ---
    if (btnAddDiccionario) {
        btnAddDiccionario.addEventListener('click', async () => {
            try {
                const ruta = await window.__TAURI__.dialog.open({
                    multiple: false,
                    filters: [{ name: 'Diccionario Excel', extensions: ['xlsx', 'xls'] }]
                });

                if (!ruta) return;

                diccionarioMaestro = await invoke('leer_diccionario', { ruta });

                pintarDiccionarioCargado(ruta, diccionarioMaestro.length);

                await window.__TAURI__.dialog.message(
                    `Diccionario cargado con ${diccionarioMaestro.length} artículos.`,
                    { title: 'Éxito', kind: 'info' }
                );
            } catch (error) {
                console.error('Error al cargar el diccionario:', error);
                alert('No se pudo cargar el diccionario: ' + error);
            }
        });
    }

    // Muestra en el panel izquierdo el diccionario cargado (reemplaza el anterior)
    function pintarDiccionarioCargado(ruta, totalArticulos) {
        if (!dictionaryList) return;

        dictionaryList.innerHTML = '';

        const archivo = ruta.split(/[\\/]/).pop();

        const li = document.createElement('li');
        li.className = 'dictionary-item';

        const icono = document.createElement('span');
        icono.className = 'dictionary-item-icon';
        icono.innerHTML = '<svg class="icon icon-sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg>';

        const nombre = document.createElement('span');
        nombre.className = 'dictionary-item-name';
        nombre.textContent = archivo;
        nombre.title = `${ruta}\n${totalArticulos} artículos`;

        const eliminar = document.createElement('button');
        eliminar.type = 'button';
        eliminar.className = 'dictionary-delete';
        eliminar.title = 'Quitar diccionario';
        eliminar.setAttribute('aria-label', 'Quitar diccionario');
        eliminar.innerHTML = '<svg class="icon icon-sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg>';
        eliminar.addEventListener('click', () => {
            diccionarioMaestro = [];
            pintarDiccionarioVacio();
            limpiarCodigosTabla();
        });

        li.appendChild(icono);
        li.appendChild(nombre);
        li.appendChild(eliminar);
        dictionaryList.appendChild(li);
    }

    function pintarDiccionarioVacio() {
        if (!dictionaryList) return;
        dictionaryList.innerHTML = '<li class="dictionary-empty">No hay diccionarios cargados</li>';
    }

    pintarDiccionarioVacio();

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

            tbody.innerHTML = `<tr><td colspan="6">Procesando...</td></tr>`;

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
                try {
                    // Consolidar entre archivos (suma + orden global)
                    let consolidado = await invoke('consolidar_entre_archivos', {
                        ingredientes: todosLosDatos
                    });

                    // Asignar códigos del diccionario maestro si está cargado
                    if (diccionarioMaestro.length > 0) {
                        consolidado = await invoke('asignar_codigos', {
                            ingredientes: consolidado,
                            diccionario: diccionarioMaestro
                        });
                    }

                    // Todos los ingredientes deben exponer un código seleccionado
                    // (vacío si aún no se ha elegido ninguno)
                    ingredientesConsolidados = consolidado.map(ing => ({
                        ...ing,
                        codigo_seleccionado: ing.codigo_seleccionado || ''
                    }));

                    pintarTablaConsolidada(ingredientesConsolidados);
                } catch (error) {
                    console.error('Error al consolidar los ingredientes:', error);
                    ingredientesConsolidados = [];
                    tbody.innerHTML = '<tr><td colspan="6">No se pudieron consolidar los ingredientes.</td></tr>';
                    await window.__TAURI__.dialog.message(
                        'No se pudo consolidar los ingredientes: ' + error,
                        { title: 'Error', kind: 'error' }
                    );
                }
            } else {
                tbody.innerHTML = '<tr><td colspan="6">No se obtuvieron datos.</td></tr>';
            }
        });
    }

    // Limpia visualmente la selección de archivos y hojas
    if (btnLimpiarSeleccion) {
        btnLimpiarSeleccion.addEventListener('click', () => {
            document.querySelectorAll('.chk-file, .chk-sheet').forEach(chk => {
                chk.checked = false;
            });

            document.querySelectorAll('.chk-file').forEach(chk => {
                chk.indeterminate = false;
            });
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

    // --- Agregar sección: 100% en frontend ---
    if (btnAddSection && sectionList) {
        btnAddSection.addEventListener('click', () => {
            // Calcular siguiente id disponible (evita colisiones tras eliminar)
            const nextId = seccionesActuales.length > 0
                ? Math.max(...seccionesActuales.map(s => s.id)) + 1
                : 1;

            seccionesActuales.push({
                id: nextId,
                nombre: "Nueva Sección",
                alumnos: 0,
                proporcion: 0.0
            });

            renderizarSecciones(seccionesActuales, sectionList);
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
    // Guardamos copia profunda para trabajar con ella
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
        const btnDelete = li.querySelector('.btn-delete-section');

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

        // ✅ FIX: listener de eliminar
        btnDelete.addEventListener('click', () => {
            const id = parseInt(btnDelete.dataset.id);
            seccionesActuales = seccionesActuales.filter(s => s.id !== id);
            renderizarSecciones(seccionesActuales, contenedor);
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

    // Reasignar IDs consecutivos al cargar
    const seccionesNormalizadas = grupo.secciones.map((s, i) => ({
        ...s,
        id: i + 1
    }));

    const sectionList = document.getElementById('sectionList');
    if (sectionList) renderizarSecciones(seccionesNormalizadas, sectionList);
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

            // Se muestra el nombre sin la extensión del archivo
            const nombreArchivo = archivo.ruta.split(/[\\/]/).pop().replace(/\.[^.]+$/, '');

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
                    <svg class="icon chevron" viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M6 9l6 6 6-6"/>
                    </svg>
                </summary>
                <ul class="sheets-list">
                    <li class="loading-text">Cargando hojas...</li>
                </ul>
            `;

            detalles.dataset.ruta = archivo.ruta;

            // Menú de contexto (click derecho) para las opciones del archivo
            detalles.addEventListener('contextmenu', (evento) => {
                evento.preventDefault();
                evento.stopPropagation();

                abrirMenuContextual(evento.clientX, evento.clientY, [
                    {
                        label: 'Eliminar',
                        danger: true,
                        onClick: () => eliminarArchivoDeLista(detalles)
                    }
                ], detalles);
            });

            const chkFile = detalles.querySelector('.chk-file');
            const listaHojas = detalles.querySelector('.sheets-list');
            let hojasCargadas = false;
            let promesaCarga = null;

            async function cargarHojas() {
                if (hojasCargadas) return;
                if (promesaCarga) return promesaCarga;

                promesaCarga = (async () => {
                    try {
                        const hojas = await invoke('obtener_hojas_excel', { ruta: archivo.ruta });
                        listaHojas.innerHTML = '';

                        hojas.forEach(nombreHoja => {
                            const liHoja = document.createElement('li');
                            liHoja.className = 'sheet-item';

                            liHoja.innerHTML = `
                                <label class="sheet-item-label">
                                    <input type="checkbox" class="chk-sheet" data-hoja="${nombreHoja}">
                                    <span class="sheet-name">${nombreHoja}</span>
                                </label>
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

                            listaHojas.appendChild(liHoja);
                        });

                        hojasCargadas = true;
                    } catch (error) {
                        listaHojas.innerHTML = `<li class="error-text">Error al leer el archivo</li>`;
                    } finally {
                        promesaCarga = null;
                    }
                })();

                return promesaCarga;
            }

            chkFile.addEventListener('change', async (e) => {
                const isChecked = e.target.checked;

                // Si el acordeón nunca se abrió, las hojas aún no existen: cargarlas antes de tildarlas
                if (!hojasCargadas) {
                    await cargarHojas();
                }

                const chkHojas = detalles.querySelectorAll('.chk-sheet');
                chkHojas.forEach(chk => {
                    chk.checked = isChecked;
                });

                chkFile.indeterminate = false;
            });

            detalles.addEventListener('toggle', async () => {
                if (detalles.open && !hojasCargadas) {
                    await cargarHojas();
                }
            });

            fileList.appendChild(detalles);
        });
    } catch (error) {
        console.error("Error al cargar archivos recientes:", error);
    }
}

// --- MENÚ CONTEXTUAL GENÉRICO ---

const COLORES_INGREDIENTE = [
    '#f8d7da', '#ffe8cc', '#fff3bf', '#d3f9d8',
    '#c5f6fa', '#d0ebff', '#e5dbff', '#f3d9fa'
];

// Color elegido por ingrediente (se conserva entre repintados de la tabla)
const coloresIngredientes = new Map();

// Cierra cualquier menú contextual abierto y limpia el marcado del origen
function cerrarMenuContextual() {
    document.querySelectorAll('.context-menu').forEach(menu => menu.remove());
    document.querySelectorAll('.context-target').forEach(el => el.classList.remove('context-target'));
}

// Única implementación compartida: inserta, posiciona (ajustando al viewport),
// marca el elemento de origen y dispara la animación de entrada.
function mostrarMenuContextual(menu, x, y, targetElement = null) {
    cerrarMenuContextual();

    if (targetElement) {
        targetElement.classList.add('context-target');
    }

    menu.classList.add('context-menu');
    // Evita que el clic derecho sobre el propio menú abra otro menú
    menu.addEventListener('contextmenu', (e) => e.preventDefault());

    document.body.appendChild(menu);

    // Se mide ya insertado para que no se salga de la ventana
    const margen = 4;
    const rect = menu.getBoundingClientRect();
    const posX = Math.min(x, window.innerWidth - rect.width - margen);
    const posY = Math.min(y, window.innerHeight - rect.height - margen);

    menu.style.left = `${Math.max(margen, posX)}px`;
    menu.style.top = `${Math.max(margen, posY)}px`;
}

// Menú genérico: opciones = [{ label, icon, danger, onClick }]
function abrirMenuContextual(x, y, opciones, targetElement = null) {
    const menu = document.createElement('div');
    menu.id = 'menuContextual';

    opciones.forEach(opcion => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'context-menu-item' + (opcion.danger ? ' danger' : '');

        if (opcion.icon) {
            const icono = document.createElement('span');
            icono.className = 'context-menu-icon';
            icono.innerHTML = opcion.icon; // marcado SVG

            const texto = document.createElement('span');
            texto.textContent = opcion.label;

            item.append(icono, texto);
        } else {
            item.textContent = opcion.label;
        }

        item.addEventListener('click', () => {
            cerrarMenuContextual();
            if (typeof opcion.onClick === 'function') opcion.onClick();
        });

        menu.appendChild(item);
    });

    mostrarMenuContextual(menu, x, y, targetElement);
}

// Menú de colores de una fila de ingrediente: grid de 8 swatches + "Quitar color"
function abrirMenuColores(x, y, nombreIngrediente) {
    const filaOrigen = Array.from(document.querySelectorAll('#tablaConsolidadaBody tr'))
        .find(fila => fila.querySelector('strong')?.textContent.trim() === nombreIngrediente) || null;

    const menu = document.createElement('div');
    menu.id = 'menuColores';
    menu.classList.add('context-menu-colores');

    const grid = document.createElement('div');
    grid.className = 'color-grid';

    COLORES_INGREDIENTE.forEach(color => {
        const swatch = document.createElement('button');
        swatch.type = 'button';
        swatch.className = 'color-swatch';
        swatch.style.background = color;
        swatch.title = color;
        swatch.setAttribute('aria-label', `Color ${color}`);

        swatch.addEventListener('click', () => {
            cerrarMenuContextual();
            aplicarColorIngrediente(nombreIngrediente, color);
        });

        grid.appendChild(swatch);
    });

    menu.appendChild(grid);

    const quitar = document.createElement('button');
    quitar.type = 'button';
    quitar.className = 'context-menu-item danger';
    quitar.textContent = 'Quitar color';

    quitar.addEventListener('click', () => {
        cerrarMenuContextual();
        aplicarColorIngrediente(nombreIngrediente, null);
    });

    menu.appendChild(quitar);

    mostrarMenuContextual(menu, x, y, filaOrigen);
}

function aplicarColorIngrediente(nombre, color) {
    if (color) {
        coloresIngredientes.set(nombre, color);
    } else {
        coloresIngredientes.delete(nombre);
    }

    document.querySelectorAll('#tablaConsolidadaBody tr').forEach(fila => {
        const celdaNombre = fila.querySelector('strong');
        if (celdaNombre && celdaNombre.textContent.trim() === nombre) {
            fila.style.backgroundColor = color || '';
        }
    });
}

// Reaplica los colores guardados después de repintar la tabla
function aplicarColoresGuardados(tbody) {
    if (coloresIngredientes.size === 0) return;

    tbody.querySelectorAll('tr').forEach(fila => {
        const celdaNombre = fila.querySelector('strong');
        if (!celdaNombre) return;

        const color = coloresIngredientes.get(celdaNombre.textContent.trim());
        if (color) fila.style.backgroundColor = color;
    });
}

async function eliminarArchivoDeLista(detalles) {
    const ruta = detalles.dataset.ruta;
    const nombre = ruta.split(/[\\/]/).pop();

    const confirmar = await window.__TAURI__.dialog.ask(
        `¿Quitar "${nombre}" de la lista de archivos recientes?`,
        {
            title: 'Eliminar archivo',
            kind: 'warning',
            okLabel: 'Eliminar',
            cancelLabel: 'Cancelar'
        }
    );

    if (!confirmar) return;

    try {
        await invoke('eliminar_archivo_reciente', { ruta });
        detalles.remove();
    } catch (error) {
        console.error('Error al eliminar el archivo de la lista:', error);
        await window.__TAURI__.dialog.message(
            'No se pudo eliminar: ' + error,
            { title: 'Error', kind: 'error' }
        );
    }
}

// Cerrar el menú al interactuar fuera de él, al hacer scroll o al perder el foco
document.addEventListener('click', cerrarMenuContextual);
document.addEventListener('contextmenu', (evento) => {
    if (!evento.target.closest || !evento.target.closest('.excel-file-details, #tablaConsolidadaBody tr')) {
        cerrarMenuContextual();
    }
});
document.addEventListener('keydown', (evento) => {
    if (evento.key === 'Escape') cerrarMenuContextual();
});
document.addEventListener('scroll', cerrarMenuContextual, true);
window.addEventListener('blur', cerrarMenuContextual);
window.addEventListener('resize', cerrarMenuContextual);

// --- Columna Código: selector del diccionario o entrada manual ---
const CODIGO_MANUAL = '__MANUAL__';

// Sincroniza el código en el estado global (por nombre + unidad)
function sincronizarCodigoSeleccionado(item, valor) {
    item.codigo_seleccionado = valor;

    const original = ingredientesConsolidados.find(
        ing => ing.nombre === item.nombre && ing.unidad === item.unidad
    );
    if (original) {
        original.codigo_seleccionado = valor;
        if (item.opciones_codigo) original.opciones_codigo = item.opciones_codigo;
    }
}

// Entrada manual: misma apariencia que el selector
function crearInputCodigo(item, opciones, td) {
    const contenedor = document.createElement('div');
    contenedor.className = 'codigo-manual-wrapper';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'input-codigo-manual';
    input.placeholder = 'Escribir código...';
    input.value = item.codigo_seleccionado || '';
    input.addEventListener('input', () => sincronizarCodigoSeleccionado(item, input.value));

    contenedor.appendChild(input);

    // Si venía de una lista de opciones, permite volver al desplegable
    if (opciones.length > 0) {
        const volver = document.createElement('button');
        volver.type = 'button';
        volver.className = 'btn-codigo-opciones';
        volver.title = 'Volver a las opciones del diccionario';
        volver.setAttribute('aria-label', 'Volver a las opciones del diccionario');
        volver.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg>';
        volver.addEventListener('click', () => {
            // Si el código manual no existe en el diccionario, se limpia
            const coincide = opciones.some(o => o.codigo === item.codigo_seleccionado);
            if (!coincide) sincronizarCodigoSeleccionado(item, '');
            pintarControlCodigo(td, item, opciones);
        });
        contenedor.appendChild(volver);
    }

    return contenedor;
}

// Selector nativo con overlay: cerrado muestra solo el código,
// desplegado muestra el nombre completo de cada artículo.
function crearSelectCodigo(item, opciones, td) {
    const contenedor = document.createElement('div');
    contenedor.className = 'code-select';

    const etiqueta = document.createElement('span');
    etiqueta.className = 'code-select-label';

    const chevron = document.createElement('span');
    chevron.className = 'code-select-chevron';
    chevron.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';

    const select = document.createElement('select');
    select.setAttribute('aria-label', `Código para ${item.nombre}`);

    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Elegir código...';
    select.appendChild(placeholder);

    opciones.forEach(opcion => {
        const opt = document.createElement('option');
        opt.value = opcion.codigo;
        opt.dataset.nombre = opcion.descripcion;
        opt.textContent = `${opcion.codigo} - ${opcion.descripcion}`;
        select.appendChild(opt);
    });

    // Opción extra SIEMPRE al final
    const manual = document.createElement('option');
    manual.value = CODIGO_MANUAL;
    manual.textContent = '✏️ Escribir manualmente...';
    select.appendChild(manual);

    const describirSeleccion = (codigo) => {
        const opcion = opciones.find(o => o.codigo === codigo);
        return opcion ? `${opcion.codigo} - ${opcion.descripcion}` : '';
    };

    const actualizarEtiqueta = () => {
        const seleccionado = select.value;
        etiqueta.textContent = seleccionado || 'Elegir código...';
        contenedor.classList.toggle('is-empty', !seleccionado);
        contenedor.title = describirSeleccion(seleccionado);
    };

    select.value = item.codigo_seleccionado || '';
    actualizarEtiqueta();

    select.addEventListener('change', () => {
        // Cambio a entrada manual: se reemplaza el select por un input
        if (select.value === CODIGO_MANUAL) {
            sincronizarCodigoSeleccionado(item, '');
            td.innerHTML = '';
            td.appendChild(crearInputCodigo(item, opciones, td));

            const input = td.querySelector('.input-codigo-manual');
            if (input) input.focus();
            return;
        }

        sincronizarCodigoSeleccionado(item, select.value);
        actualizarEtiqueta();
    });

    contenedor.appendChild(etiqueta);
    contenedor.appendChild(chevron);
    contenedor.appendChild(select);
    return contenedor;
}

// Decide qué control pintar: input manual o selector de códigos
function pintarControlCodigo(td, item, opciones) {
    td.innerHTML = '';

    const codigo = item.codigo_seleccionado || '';
    const coincide = opciones.some(o => o.codigo === codigo);

    if (opciones.length === 0 || (codigo && !coincide)) {
        td.appendChild(crearInputCodigo(item, opciones, td));
    } else {
        td.appendChild(crearSelectCodigo(item, opciones, td));
    }
}

// Celda de código del diccionario maestro
function crearCeldaCodigo(item) {
    const td = document.createElement('td');
    pintarControlCodigo(td, item, item.opciones_codigo || []);
    return td;
}

// Quita los códigos asignados y refresca la columna de la tabla
function limpiarCodigosTabla() {
    ingredientesConsolidados.forEach(ing => {
        ing.opciones_codigo = [];
        ing.codigo_seleccionado = '';
    });

    const tbody = document.getElementById('tablaConsolidadaBody');
    if (!tbody) return;

    tbody.querySelectorAll('tr').forEach(fila => {
        if (fila.children.length < 2) return;

        const nombre = fila.querySelector('strong')?.textContent.trim();
        const ingrediente = ingredientesConsolidados.find(ing => ing.nombre === nombre);

        fila.children[1].replaceWith(
            crearCeldaCodigo(ingrediente || {
                nombre: nombre || '',
                unidad: '',
                opciones_codigo: [],
                codigo_seleccionado: ''
            })
        );
    });
}

function pintarTablaConsolidada(datos) {
    const tbody = document.getElementById('tablaConsolidadaBody');
    if (!tbody) return;
    tbody.innerHTML = '';

    datos.forEach(item => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td><strong>${item.nombre}</strong></td>
            <td></td>
            <td>${item.unidad}</td>
            <td>${item.cantidad.toFixed(2)}</td>
            <td style="color:#999;">—</td>
            <td>
                <input type="text" class="input-comentario" placeholder="Escribe un comentario..." style="width: 100%; border: 1px solid #ccc; border-radius: 4px; padding: 4px; font-size: 12px;">
            </td>
        `;
        tr.children[1].replaceWith(crearCeldaCodigo(item));
        tbody.appendChild(tr);
    });

    aplicarColoresGuardados(tbody);
}
function pintarTablaConsolidadaConTotal(datos) {
    const tbody = document.getElementById('tablaConsolidadaBody');
    if (!tbody) return;
    tbody.innerHTML = '';

    datos.forEach(item => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td><strong>${item.nombre}</strong></td>
            <td></td>
            <td>${item.unidad}</td>
            <td>${item.cantidad.toFixed(2)}</td>
            <td><strong style="color: #2563eb;">${item.cantidad_total.toFixed(2)}</strong></td>
            <td>
                <input type="text" class="input-comentario" placeholder="Escribe un comentario..." style="width: 100%; border: 1px solid #ccc; border-radius: 4px; padding: 4px; font-size: 12px;">
            </td>
        `;
        tr.children[1].replaceWith(crearCeldaCodigo(item));
        tbody.appendChild(tr);
    });

    aplicarColoresGuardados(tbody);
}