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
    const btnResumenColores = document.getElementById('btnResumenColores');
    const inputTituloConsolidado = document.getElementById('tituloConsolidado');

    // Carga inicial de los colores persistidos (no bloquea el arranque)
    coloresCargadosPromise = cargarColoresFilas();

    // Resumen visual de colores aplicados (solo lectura)
    if (btnResumenColores) {
        btnResumenColores.addEventListener('click', abrirResumenColores);
    }

    // Opción B: volcar los colores al store antes de permitir el cierre
    if (window.__TAURI__?.window?.getCurrentWindow) {
        const ventanaActual = window.__TAURI__.window.getCurrentWindow();
        let cierreEnCurso = false;
        let permitirCierre = false;

        ventanaActual.onCloseRequested(async (evento) => {
            console.log('[colores] onCloseRequested recibido.');
            if (permitirCierre) return; // deja pasar el cierre que provocamos abajo

            evento.preventDefault();

            if (cierreEnCurso) return; // ya se está guardando
            cierreEnCurso = true;

            // No bloqueamos el cierre más de ~1.5s aunque el store no responda;
            // los guardados inmediatos ya cubren el caso normal.
            await Promise.race([
                flushColoresAlCerrar(),
                new Promise(resolve => setTimeout(resolve, 1500))
            ]);

            permitirCierre = true;

            try {
                await ventanaActual.close();
            } catch (error) {
                console.error('No se pudo cerrar la ventana tras guardar los colores:', error);
                permitirCierre = false;
                cierreEnCurso = false;
            }
        }).then(() => {
            console.log('[colores] onCloseRequested enganchado correctamente.');
        }).catch((error) => {
            console.error('No se pudo enganchar onCloseRequested:', error);
        });
    } else {
        console.warn('[colores] window.__TAURI__.window no disponible; sin flush al cerrar.');
    }

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
            if (!fila || !fila.querySelector('strong')) return; // filas de estado sin ingrediente

            const idFila = fila.dataset.idFila;
            if (!idFila) return;

            evento.preventDefault();
            evento.stopPropagation();

            abrirMenuColores(evento.clientX, evento.clientY, idFila, fila);
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

                // Recordar la ruta para restaurar el diccionario al iniciar
                try {
                    await invoke('guardar_ruta_diccionario', { ruta });
                } catch (error) {
                    console.warn('No se pudo guardar la ruta del diccionario:', error);
                }

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

            // Olvidar la ruta persistida para no restaurarla al reiniciar
            invoke('guardar_ruta_diccionario', { ruta: '' }).catch((error) => {
                console.warn('No se pudo borrar la ruta del diccionario:', error);
            });
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

    // --- Restaurar el diccionario guardado en la sesión anterior ---
    (async () => {
        try {
            const rutaGuardada = await invoke('obtener_ruta_diccionario');
            if (!rutaGuardada) return;

            try {
                diccionarioMaestro = await invoke('leer_diccionario', { ruta: rutaGuardada });
                pintarDiccionarioCargado(rutaGuardada, diccionarioMaestro.length);
                console.info(`Diccionario restaurado: ${rutaGuardada} (${diccionarioMaestro.length} artículos).`);
            } catch (error) {
                // Archivo ilegible o eliminado: se limpia el estado sin bloquear la app
                diccionarioMaestro = [];
                pintarDiccionarioVacio();
                console.warn('No se pudo restaurar el diccionario guardado:', error);
            }
        } catch (error) {
            // Sin preferencia guardada o store no disponible: se ignora
            console.warn('No se pudo leer la ruta del diccionario guardado:', error);
        }
    })();

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
    { id: 'rojo', valor: '#f8d7da' },
    { id: 'naranja', valor: '#ffe8cc' },
    { id: 'amarillo', valor: '#fff3bf' },
    { id: 'verde', valor: '#d3f9d8' },
    { id: 'turquesa', valor: '#c5f6fa' },
    { id: 'azul', valor: '#d0ebff' },
    { id: 'violeta', valor: '#e5dbff' },
    { id: 'rosa', valor: '#f3d9fa' }
];

// El id de color es lo que se persiste; el hex solo es presentación
const COLORES_POR_ID = new Map(COLORES_INGREDIENTE.map(c => [c.id, c.valor]));

// Versión actual del esquema de claves de colores. Ver migrarColoresLegacy().
// v1: clave = solo nombre normalizado (o "nombre|unidad" en versiones intermedias).
// v2: clave = "nombre_normalizado::unidad_normalizada".
const SCHEMA_VERSION_COLORES = 2;

// Separador de la pk compuesta. Se elige "::" porque:
//  - no aparece en nombres de ingredientes ni unidades habituales,
//  - es visible al depurar y distinto del "|" que usa la clave interna de
//    consolidación de Rust, lo que permite reconocer formatos viejos.
const SEPARADOR_PK_COLOR = '::';

// Color elegido por fila (pkColorFila -> idColor). Fuente de verdad en runtime.
const coloresIngredientes = new Map();

// Entradas leídas con formato viejo (solo nombre, o "nombre|unidad").
// No se aplican hasta conocer las filas actuales: ver migrarColoresLegacy().
const coloresPendientesMigracion = new Map();

// Versión leída del store (0 = sin versión / esquema viejo).
let versionColoresCargada = 0;

// Promesa de la carga inicial desde el store
let coloresCargadosPromise = null;

// Banderas para no migrar ni volcar datos antes de saber qué había en disco.
let coloresCargados = false;
let cargaColoresFallida = false;

// Cola de escrituras para que los guardados no se pisen entre sí
let persistenciaColoresCola = Promise.resolve();

// Nombre normalizado de la fila. Rust lo expone en `clave_ingrediente`
// para no duplicar aquí la normalización de acentos/espacios.
function claveNombreIngrediente(item) {
    if (item?.clave_ingrediente) return item.clave_ingrediente;

    // Respaldo defensivo: si la fila trae la clave de consolidación
    // ("nombre_normalizado|unidad"), recuperamos solo el nombre.
    if (item?.clave && item.clave.includes('|')) {
        return item.clave.slice(0, item.clave.indexOf('|'));
    }

    return String(item?.nombre || '')
        .trim()
        .replace(/\s+/g, ' ')
        .toLowerCase();
}

function normalizarUnidadMedida(unidad) {
    return String(unidad || '')
        .trim()
        .replace(/\s+/g, ' ')
        .replace(/[.,;:]+$/, '')
        .toLowerCase();
}

// pk estable y compuesta de una fila: nombre normalizado + unidad normalizada.
// Ejemplo: "harina::kg" y "harina::g" son filas distintas.
function pkColorFila(fila) {
    const nombre = claveNombreIngrediente(fila);
    const unidad = normalizarUnidadMedida(fila?.unidad);
    return `${nombre}${SEPARADOR_PK_COLOR}${unidad}`;
}

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
function abrirMenuColores(x, y, idFila, filaOrigen = null) {
    const menu = document.createElement('div');
    menu.id = 'menuColores';
    menu.classList.add('context-menu-colores');

    const grid = document.createElement('div');
    grid.className = 'color-grid';

    COLORES_INGREDIENTE.forEach(({ id, valor }) => {
        const swatch = document.createElement('button');
        swatch.type = 'button';
        swatch.className = 'color-swatch';
        swatch.style.background = valor;
        swatch.title = id;
        swatch.setAttribute('aria-label', `Color ${id}`);

        swatch.addEventListener('click', () => {
            cerrarMenuContextual();
            guardarColorFila(idFila, id);
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
        quitarColorFila(idFila);
    });

    menu.appendChild(quitar);

    mostrarMenuContextual(menu, x, y, filaOrigen);
}

// Persiste todo el mapa en el store sin bloquear la UI.
// Se encola para que varias escrituras seguidas no se pisen y para
// esperar a que termine la carga inicial antes de sobrescribir.
function persistirColoresFilas() {
    const guardar = () => {
        const colores = Object.fromEntries(coloresIngredientes);
        const total = Object.keys(colores).length;

        console.log(`[colores] Persistiendo ${total} color(es) en el store...`);

        return invoke('guardar_colores_filas', { colores })
            .then(() => console.log(`[colores] Store OK: ${total} color(es) guardados.`));
    };

    persistenciaColoresCola = persistenciaColoresCola
        .then(() => coloresCargadosPromise || Promise.resolve())
        .then(guardar)
        .catch((error) => {
            console.error('No se pudieron guardar los colores de las filas:', error);
        });
}

// Marca en el store la versión del esquema ya aplicada (idempotencia).
function persistirVersionColores() {
    const version = versionColoresCargada || SCHEMA_VERSION_COLORES;

    persistenciaColoresCola = persistenciaColoresCola
        .then(() => coloresCargadosPromise || Promise.resolve())
        .then(() => invoke('guardar_version_colores_filas', { version }))
        .catch((error) => {
            console.error('No se pudo guardar la versión del esquema de colores:', error);
        });
}

// Aplica el color a todas las filas con ese id (la tabla puede estar duplicada)
function pintarFilaPorId(idFila, colorId) {
    const color = colorId ? (COLORES_POR_ID.get(colorId) || '') : '';

    document.querySelectorAll('#tablaConsolidadaBody tr').forEach(fila => {
        if (fila.dataset.idFila === idFila) {
            fila.style.backgroundColor = color;
        }
    });
}

// Actualiza estado en memoria + pinta de inmediato y persiste en background
function guardarColorFila(idFila, colorId) {
    if (!idFila || !COLORES_POR_ID.has(colorId)) return;

    console.log(`[colores] guardarColorFila: "${idFila}" -> ${colorId}`);

    coloresIngredientes.set(idFila, colorId);
    pintarFilaPorId(idFila, colorId);
    persistirColoresFilas();
}

function quitarColorFila(idFila) {
    if (!idFila) return;

    console.log(`[colores] quitarColorFila: "${idFila}"`);

    coloresIngredientes.delete(idFila);
    pintarFilaPorId(idFila, null);
    persistirColoresFilas();
}

// Lee los colores persistidos al iniciar la app.
// Las claves con formato viejo quedan pendientes hasta que la tabla exista.
async function cargarColoresFilas() {
    try {
        const guardados = await invoke('obtener_colores_filas');
        const claves = Object.keys(guardados || {});
        console.log(`[colores] Store leído: ${claves.length} clave(s).`, claves);

        // La versión es secundaria: si falla, la migración se apoya en el
        // formato de las claves y sigue siendo segura.
        try {
            const version = await invoke('obtener_version_colores_filas');
            versionColoresCargada = Number(version) || 0;
            console.log(`[colores] Versión del esquema en store: ${versionColoresCargada}`);
        } catch (error) {
            console.error('No se pudo leer la versión del esquema de colores:', error);
            versionColoresCargada = 0;
        }

        Object.entries(guardados || {}).forEach(([clave, colorId]) => {
            // Ignora ids de color desconocidos (paleta cambiada)
            if (!COLORES_POR_ID.has(colorId)) {
                console.warn(`[colores] Color desconocido "${colorId}" para "${clave}"; se ignora.`);
                return;
            }

            if (clave.includes(SEPARADOR_PK_COLOR)) {
                coloresIngredientes.set(clave, colorId);       // esquema actual
            } else {
                coloresPendientesMigracion.set(clave, colorId); // esquema viejo
            }
        });

        console.log(
            `[colores] En memoria: ${coloresIngredientes.size} actuales, ` +
            `${coloresPendientesMigracion.size} pendientes de migrar.`
        );

        // Sin entradas viejas: solo nos aseguramos de marcar el esquema actual.
        if (coloresPendientesMigracion.size === 0
            && versionColoresCargada < SCHEMA_VERSION_COLORES) {
            versionColoresCargada = SCHEMA_VERSION_COLORES;
            persistirVersionColores();
        }

        // Si la tabla ya está pintada, aplicamos los colores ahora mismo.
        const tbody = document.getElementById('tablaConsolidadaBody');
        if (tbody && tbody.querySelector('tr[data-id-fila]')) {
            aplicarColoresGuardados(tbody);
        }
    } catch (error) {
        cargaColoresFallida = true;
        console.error('No se pudieron cargar los colores de las filas:', error);
    } finally {
        coloresCargados = true;
    }

    return coloresIngredientes;
}

// Migra las claves persistidas con esquemas viejos al actual.
// Heurística:
//  - "nombre|unidad" (formato intermedio): se convierte a "nombre::unidad"
//    y solo se aplica si esa fila existe hoy.
//  - "nombre" (v1 real): si hoy hay UNA sola fila con ese nombre, hereda el
//    color; si hay VARIAS (mismo nombre, distinta unidad) es ambiguo y se
//    descarta. TODO: requeriría decisión manual si se quisiera conservar.
// Es idempotente: al terminar se marca SCHEMA_VERSION_COLORES en el store.
function migrarColoresLegacy(datos) {
    // No migrar hasta saber qué había en disco (evita marcar v2 prematuramente)
    if (!coloresCargados || !datos || datos.length === 0) return;

    if (coloresPendientesMigracion.size === 0) {
        if (versionColoresCargada < SCHEMA_VERSION_COLORES) {
            versionColoresCargada = SCHEMA_VERSION_COLORES;
            persistirVersionColores();
        }
        return;
    }

    const filasPorNombre = new Map();
    const pksValidas = new Set();

    datos.forEach(item => {
        const nombre = claveNombreIngrediente(item);
        if (!filasPorNombre.has(nombre)) filasPorNombre.set(nombre, []);
        filasPorNombre.get(nombre).push(item);
        pksValidas.add(pkColorFila(item));
    });

    coloresPendientesMigracion.forEach((colorId, claveVieja) => {
        const candidatos = filasPorNombre.get(claveVieja) || [];

        // Caso v1: solo nombre y hoy existe una única fila con ese nombre.
        // Si ya hay una entrada con la pk nueva, esa gana.
        if (candidatos.length === 1) {
            const pk = pkColorFila(candidatos[0]);
            if (!coloresIngredientes.has(pk)) {
                coloresIngredientes.set(pk, colorId);
            }
            return;
        }

        // Varias filas con el mismo nombre: no hay forma de saber la unidad.
        // Se descarta la entrada vieja para no pintar la fila equivocada.
        if (candidatos.length > 1) return;

        // Caso intermedio: "nombre|unidad" -> "nombre::unidad"
        if (claveVieja.includes('|')) {
            const corte = claveVieja.indexOf('|');
            const unidadVieja = normalizarUnidadMedida(claveVieja.slice(corte + 1));
            const pk = `${claveVieja.slice(0, corte)}${SEPARADOR_PK_COLOR}${unidadVieja}`;

            if (pksValidas.has(pk) && !coloresIngredientes.has(pk)) {
                coloresIngredientes.set(pk, colorId);
            }
        }
    });

    coloresPendientesMigracion.clear();
    versionColoresCargada = SCHEMA_VERSION_COLORES;

    // Primero el mapa y después la versión: si algo falla, se reintenta
    // la migración en el próximo arranque.
    persistirColoresFilas();
    persistirVersionColores();
}

// Elimina colores de ingredientes que ya no existen en la tabla.
// IMPORTANTE: no se invoca automáticamente. La tabla consolidada puede ser
// un subconjunto de los archivos del usuario (un grupo, una selección), así
// que borrar por "nombre ausente" destruiría colores de otras tablas y se
// percibiría como un reinicio. Se conserva como utilidad de mantenimiento
// manual y solo elimina por NOMBRE ausente (no por unidad), para que una
// diferencia de formato en la unidad ("Litro" vs "Lt") no borre datos.
function limpiarColoresHuerfanos(datos) {
    if (!coloresCargados || !Array.isArray(datos) || datos.length === 0) return;

    const nombresValidos = new Set(datos.map(claveNombreIngrediente));
    let eliminadas = 0;

    coloresIngredientes.forEach((_, clave) => {
        const corte = clave.lastIndexOf(SEPARADOR_PK_COLOR);
        const nombre = corte >= 0 ? clave.slice(0, corte) : clave;

        if (!nombresValidos.has(nombre)) {
            coloresIngredientes.delete(clave);
            eliminadas++;
        }
    });

    if (eliminadas > 0) {
        console.log(`[colores] Huérfanos eliminados: ${eliminadas}`);
        persistirColoresFilas();
    }
}

// Reaplica los colores guardados después de repintar la tabla.
// Si una clave no coincide exactamente (p. ej. cambió el formato de la
// unidad), intenta recuperarla por nombre cuando no hay ambigüedad.
function aplicarColoresGuardados(tbody) {
    const filas = Array.from(tbody.querySelectorAll('tr[data-id-fila]'));
    if (filas.length === 0) return;

    // Índice de claves persistidas por nombre
    const guardadosPorNombre = new Map();
    coloresIngredientes.forEach((colorId, clave) => {
        const corte = clave.lastIndexOf(SEPARADOR_PK_COLOR);
        const nombre = corte >= 0 ? clave.slice(0, corte) : clave;
        if (!guardadosPorNombre.has(nombre)) guardadosPorNombre.set(nombre, []);
        guardadosPorNombre.get(nombre).push({ clave, colorId });
    });

    // Filas de la tabla agrupadas por nombre
    const filasPorNombre = new Map();
    filas.forEach(fila => {
        const idFila = fila.dataset.idFila;
        const corte = idFila.lastIndexOf(SEPARADOR_PK_COLOR);
        const nombre = corte >= 0 ? idFila.slice(0, corte) : idFila;
        if (!filasPorNombre.has(nombre)) filasPorNombre.set(nombre, []);
        filasPorNombre.get(nombre).push(fila);
    });

    let aplicadas = 0;
    let reasignadas = 0;

    filas.forEach(fila => {
        const idFila = fila.dataset.idFila;
        let colorId = coloresIngredientes.get(idFila);

        if (!colorId) {
            const corte = idFila.lastIndexOf(SEPARADOR_PK_COLOR);
            const nombre = corte >= 0 ? idFila.slice(0, corte) : idFila;
            const entradas = guardadosPorNombre.get(nombre) || [];
            const filasMismoNombre = filasPorNombre.get(nombre) || [];

            // Recuperación segura: solo si hay una fila y una entrada
            if (entradas.length === 1 && filasMismoNombre.length === 1) {
                const entrada = entradas[0];
                colorId = entrada.colorId;

                if (entrada.clave !== idFila) {
                    coloresIngredientes.delete(entrada.clave);
                    coloresIngredientes.set(idFila, colorId);
                    reasignadas++;
                    console.log(
                        `[colores] Clave reasignada por unidad distinta: ` +
                        `"${entrada.clave}" -> "${idFila}"`
                    );
                }
            }
        }

        fila.style.backgroundColor = colorId ? (COLORES_POR_ID.get(colorId) || '') : '';
        if (colorId) aplicadas++;
    });

    if (reasignadas > 0) {
        console.log(`[colores] Reasignadas ${reasignadas} clave(s); persistiendo...`);
        persistirColoresFilas();
    }

    console.log(
        `[colores] Restaurados ${aplicadas}/${filas.length} colores ` +
        `(mapa: ${coloresIngredientes.size}).`
    );
}

// Si la carga inicial termina después de pintar, se migra (si hacía falta)
// y se vuelve a aplicar sobre el tbody vigente.
function asegurarColoresCargados(tbody, datos = []) {
    if (!coloresCargadosPromise) return;

    coloresCargadosPromise.then(() => {
        if (!tbody.isConnected) return;
        if (datos.length > 0) {
            migrarColoresLegacy(datos);
        }
        aplicarColoresGuardados(tbody);

        // Segundo intento tras el repintado del navegador, por si el DOM
        // todavía estaba siendo actualizado cuando se aplicó el color.
        requestAnimationFrame(() => {
            if (tbody.isConnected) aplicarColoresGuardados(tbody);
        });
    });
}

// Opción B: vuelca el mapa completo al store antes de cerrar la app
async function flushColoresAlCerrar() {
    try {
        // Evita sobrescribir con un mapa vacío si la carga inicial no terminó
        if (coloresCargadosPromise) await coloresCargadosPromise;

        // Si la lectura falló, no pisamos lo que haya en disco con un mapa vacío
        if (cargaColoresFallida) {
            console.error('Se omite el volcado de colores: falló la carga inicial.');
            return;
        }

        // Espera cualquier guardado pendiente antes del volcado final
        await persistenciaColoresCola;

        const colores = Object.fromEntries(coloresIngredientes);

        // Si aún no hubo tabla para migrar, conservamos las claves viejas
        // para no perderlas al cerrar.
        coloresPendientesMigracion.forEach((colorId, claveVieja) => {
            if (!(claveVieja in colores)) colores[claveVieja] = colorId;
        });

        const version = coloresPendientesMigracion.size > 0
            ? (versionColoresCargada || 1)  // todavía no migrado
            : SCHEMA_VERSION_COLORES;

        console.log(
            `[colores] Flush al cerrar: ${Object.keys(colores).length} clave(s), ` +
            `versión ${version}.`
        );

        await Promise.all([
            invoke('guardar_colores_filas', { colores }),
            invoke('guardar_version_colores_filas', { version })
        ]);

        console.log('[colores] Flush al cerrar completado.');
    } catch (error) {
        // Nunca debe bloquear el cierre de la ventana
        console.error('No se pudieron volcar los colores al cerrar:', error);
    }
}

// --- Modal de resumen de colores ---

function cerrarResumenColores() {
    const overlay = document.getElementById('modalResumenColores');
    if (overlay) overlay.remove();

    document.removeEventListener('keydown', cerrarResumenPorEscape);
}

function cerrarResumenPorEscape(evento) {
    if (evento.key === 'Escape') {
        evento.stopPropagation();
        cerrarResumenColores();
    }
}

// Agrupa las filas visibles por id de color.
// Cada elemento incluye la pk para poder quitar el color desde el panel.
function obtenerFilasPorColor() {
    const filasPorColor = new Map();
    COLORES_INGREDIENTE.forEach(color => filasPorColor.set(color.id, []));

    document.querySelectorAll('#tablaConsolidadaBody tr').forEach(fila => {
        const idFila = fila.dataset.idFila;
        if (!idFila) return;

        const colorId = coloresIngredientes.get(idFila);
        if (!colorId || !filasPorColor.has(colorId)) return;

        const nombre = fila.querySelector('strong')?.textContent.trim() || idFila;
        const unidad = fila.children[2]?.textContent.trim() || '';
        const etiqueta = unidad ? `${nombre} (${unidad})` : nombre;

        filasPorColor.get(colorId).push({ idFila, etiqueta });
    });

    filasPorColor.forEach(filas => {
        filas.sort((a, b) => a.etiqueta.localeCompare(b.etiqueta, 'es'));
    });

    return filasPorColor;
}

// Panel estilo "picker" de Django admin:
// colores a la izquierda, filas afectadas a la derecha (con X para quitar).
function abrirResumenColores() {
    cerrarResumenColores();

    const filasPorColor = obtenerFilasPorColor();

    const overlay = document.createElement('div');
    overlay.className = 'colors-modal-overlay';
    overlay.id = 'modalResumenColores';
    overlay.addEventListener('click', (evento) => {
        if (evento.target === overlay) cerrarResumenColores();
    });

    const modal = document.createElement('div');
    modal.className = 'colors-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'coloresResumenTitulo');

    // Cabecera
    const header = document.createElement('div');
    header.className = 'colors-modal-header';

    const titulo = document.createElement('div');
    titulo.className = 'colors-modal-title';
    titulo.id = 'coloresResumenTitulo';
    titulo.textContent = 'Resumen de colores';

    const subtitulo = document.createElement('span');
    subtitulo.className = 'colors-modal-subtitle';
    subtitulo.textContent = 'Colores asignados';
    titulo.appendChild(subtitulo);

    const cerrarBtn = document.createElement('button');
    cerrarBtn.type = 'button';
    cerrarBtn.className = 'colors-modal-close';
    cerrarBtn.title = 'Cerrar';
    cerrarBtn.setAttribute('aria-label', 'Cerrar resumen de colores');
    cerrarBtn.innerHTML = '<svg class="icon icon-sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg>';
    cerrarBtn.addEventListener('click', cerrarResumenColores);

    header.append(titulo, cerrarBtn);

    // Cuerpo en dos columnas
    const body = document.createElement('div');
    body.className = 'colors-modal-body';

    const colIzquierda = document.createElement('div');
    colIzquierda.className = 'colors-picker-column';

    const tituloIzquierda = document.createElement('div');
    tituloIzquierda.className = 'colors-picker-heading';
    tituloIzquierda.textContent = 'Colores';

    const listaColores = document.createElement('ul');
    listaColores.className = 'colors-picker-list';

    const colDerecha = document.createElement('div');
    colDerecha.className = 'colors-picker-column';

    const tituloDerecha = document.createElement('div');
    tituloDerecha.className = 'colors-picker-heading';

    const listaFilas = document.createElement('ul');
    listaFilas.className = 'colors-picker-rows';

    // Botones de color (izquierda)
    const botonesColor = new Map();

    COLORES_INGREDIENTE.forEach(color => {
        const filas = filasPorColor.get(color.id);

        const li = document.createElement('li');

        const boton = document.createElement('button');
        boton.type = 'button';
        boton.className = 'colors-picker-color';

        const swatch = document.createElement('span');
        swatch.className = 'colors-picker-swatch';
        swatch.style.background = color.valor;

        const nombreColor = document.createElement('span');
        nombreColor.className = 'colors-picker-name';
        nombreColor.textContent = color.id.charAt(0).toUpperCase() + color.id.slice(1);

        const contador = document.createElement('span');
        contador.className = 'colors-picker-count';
        contador.textContent = String(filas.length);

        boton.append(swatch, nombreColor, contador);

        boton.addEventListener('click', () => {
            colorSeleccionado = color.id;
            pintarResumen();
        });

        li.appendChild(boton);
        listaColores.appendChild(li);
        botonesColor.set(color.id, boton);
    });

    // Selección inicial: primer color con filas asignadas
    let colorSeleccionado = COLORES_INGREDIENTE
        .map(color => color.id)
        .find(id => filasPorColor.get(id).length > 0) || COLORES_INGREDIENTE[0].id;

    function pintarResumen() {
        // Se recalcula en cada refresco para reflejar los cambios del DOM/estado
        const filasActuales = obtenerFilasPorColor();

        botonesColor.forEach((boton, id) => {
            const activo = id === colorSeleccionado;
            boton.classList.toggle('active', activo);
            boton.setAttribute('aria-pressed', activo ? 'true' : 'false');

            const contador = boton.querySelector('.colors-picker-count');
            if (contador) {
                contador.textContent = String((filasActuales.get(id) || []).length);
            }
        });

        const color = COLORES_INGREDIENTE.find(c => c.id === colorSeleccionado);
        tituloDerecha.textContent = `Filas con color ${color.id}`;

        listaFilas.innerHTML = '';

        const filas = filasActuales.get(colorSeleccionado) || [];

        if (filas.length === 0) {
            const vacio = document.createElement('li');
            vacio.className = 'colors-picker-empty';
            vacio.textContent = 'Sin filas asignadas a este color.';
            listaFilas.appendChild(vacio);
            return;
        }

        filas.forEach(({ idFila, etiqueta }) => {
            const li = document.createElement('li');
            li.className = 'colors-picker-row';

            const texto = document.createElement('span');
            texto.className = 'colors-picker-row-label';
            texto.textContent = etiqueta;

            // Quitar color: sin confirmación (es reversible volviendo a pintar)
            const quitar = document.createElement('button');
            quitar.type = 'button';
            quitar.className = 'colors-picker-remove';
            quitar.title = 'Quitar color';
            quitar.setAttribute('aria-label', `Quitar color a ${etiqueta}`);
            quitar.innerHTML = '<svg class="icon icon-sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg>';

            quitar.addEventListener('click', () => {
                // Memoria + DOM de la tabla central + store
                quitarColorFila(idFila);
                // Refresca contadores y lista (la fila desaparece del panel)
                pintarResumen();
            });

            li.append(texto, quitar);
            listaFilas.appendChild(li);
        });
    }

    // TODO: en una futura iteración, permitir reasignar colores en lote o
    // filtrar la tabla desde este panel.

    colIzquierda.append(tituloIzquierda, listaColores);
    colDerecha.append(tituloDerecha, listaFilas);
    body.append(colIzquierda, colDerecha);
    modal.append(header, body);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    pintarResumen();

    document.addEventListener('keydown', cerrarResumenPorEscape);
    cerrarBtn.focus();
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
        tr.dataset.idFila = pkColorFila(item);
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

    // Migra claves persistidas con esquemas viejos antes de aplicar colores.
    // No se limpian huérfanos aquí: la tabla puede ser un subconjunto y se
    // borrarían colores de otros ingredientes (ver limpiarColoresHuerfanos).
    migrarColoresLegacy(datos);

    aplicarColoresGuardados(tbody);
    asegurarColoresCargados(tbody, datos);
}
function pintarTablaConsolidadaConTotal(datos) {
    const tbody = document.getElementById('tablaConsolidadaBody');
    if (!tbody) return;
    tbody.innerHTML = '';

    datos.forEach(item => {
        const tr = document.createElement('tr');
        tr.dataset.idFila = pkColorFila(item);
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

    migrarColoresLegacy(datos);
    aplicarColoresGuardados(tbody);
    asegurarColoresCargados(tbody, datos);
}