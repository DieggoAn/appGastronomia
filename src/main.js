const { invoke } = window.__TAURI__.core;

// Variable global para mantener las secciones actuales en JS
let seccionesActuales = [];
let ingredientesConsolidados = []; 
// Datos crudos de la última consolidación: [{ ruta, datos }].
// Permiten saber cuánto aportó cada archivo a cada fila consolidada.
let ingredientesPorArchivo = [];
let tituloConsolidado = 'Consolidado de ingredientes';
let diccionarioMaestro = [];

// Ajustes GENERALES de la app (pestañas "General" y "Exportación"). No
// contienen ninguna regla de lectura de Excel: eso vive aparte en
// `mapeoInsumos` y se persiste bajo la clave `mapeo_insumos` de config.json.
function crearAjustesPorDefecto() {
    return {
        delayAutoprocesadoMs: 500,
        tema: 'claro',
        formatoNumeros: 'punto',
        incluirColoresExportacion: true,
        columnasExportacion: ['ingrediente', 'codigo', 'unidad', 'cantidad', 'total', 'comentarios'],
        ingredientesNoEncontrados: 'omitir'
    };
}

// Configuración segregada del tratamiento de Excel (pestaña "Mapeo de
// Insumos"): sinónimos de columnas, filtros y cabeceras.
// Los valores por defecto reproducen las reglas que antes estaban fijas.
function crearMapeoPorDefecto() {
    return {
        sinonimosIngrediente: ['ingrediente', 'descripción', 'material'],
        sinonimosUnidad: ['u/m', 'um', 'unidad'],
        // Una sola lista de cantidad: incluye las abreviaturas que antes
        // estaban repartidas entre prefijos y etiquetas parciales.
        sinonimosCantidad: ['cantidad', 'cant.', 'cant', 'ctdad.', 'ctdad', 'peso', 'q'],
        sinonimosTotal: ['total', 'total cantidad'],
        palabrasFilaIgnorada: ['material', 'descripción'],
        unidades: [
            { estandar: 'Litro', variantes: ['litro', 'litros', 'lt', 'lts', 'l'] },
            { estandar: 'Kilo', variantes: ['kilo', 'kilos', 'kg', 'kgs', 'kilogramo', 'kilogramos'] },
            { estandar: 'Gramo', variantes: ['gramo', 'gramos', 'g', 'gr', 'grs'] },
            { estandar: 'Unidad', variantes: ['unidad', 'unidades', 'un', 'und', 'u'] }
        ],
        filasCabeceraIgnoradas: 0,
        filasEscaneoCabecera: 15
    };
}

let ajustesProcesamiento = crearAjustesPorDefecto();
let mapeoInsumos = crearMapeoPorDefecto();

let ajustesCargadosPromise = null;
let vistaCompactaCargadaPromise = null;

// Formato de números usado para pintar la tabla. Normalmente es el guardado en
// `ajustesProcesamiento`, pero el modal lo sobreescribe mientras se previsualiza
// un cambio (null = usar el persistido). Solo afecta a la UI: los cálculos y la
// exportación siguen trabajando con números y punto decimal.
let formatoNumerosVista = null;

// --- AUTOPROCESADO: DEBOUNCE Y CONTROL DE CONCURRENCIA ---
// Retrasa `fn` hasta que pasen `delay` ms sin nuevas llamadas. Si `delay` es
// una función se evalúa en cada llamada, así se respeta el valor actual del
// Store sin recrear el debounce.
function debounce(fn, delay) {
    let temporizador = null;

    const diferida = (...args) => {
        const espera = typeof delay === 'function' ? delay() : delay;

        if (temporizador !== null) clearTimeout(temporizador);
        temporizador = setTimeout(() => {
            temporizador = null;
            fn(...args);
        }, Math.max(0, Number(espera) || 0));
    };

    diferida.cancelar = () => {
        if (temporizador !== null) clearTimeout(temporizador);
        temporizador = null;
    };

    return diferida;
}

// Delay configurado en "Ajustes de Procesamiento" (config.json).
function delayAutoprocesadoMs() {
    const valor = Number(ajustesProcesamiento?.delayAutoprocesadoMs);
    return Number.isFinite(valor) && valor >= 0
        ? valor
        : AJUSTES_POR_DEFECTO.delayAutoprocesadoMs;
}

// Cada cambio de selección o edición incrementa su contador: al terminar una
// tarea asíncrona se compara el id capturado con el vigente y, si cambió, el
// resultado viejo se descarta antes de tocar el estado o la tabla.
let idSeleccionHojas = 0;
let idRecalculoTabla = 0;
let tareasProcesando = 0;
// Recuerda si los totales visibles vienen del cálculo por grupos vinculados:
// en ese modo el autoprocesado de la tabla no debe aplicar el factor del panel.
let ultimoCalculoVinculado = false;
// Interruptor "Auto-procesar": controla si los cambios de hojas e inputs
// disparan el procesamiento automático o si hace falta el botón manual.
let autoProcesarActivo = true;

const procesarHojasDebounced = debounce(
    (idSolicitud) => {
        if (!autoProcesarActivo) return;
        ejecutarProcesamientoHojas(idSolicitud, { silencioso: true });
    },
    () => delayAutoprocesadoMs()
);

const recalcularTablaDebounced = debounce(
    (idSolicitud) => ejecutarRecalculoTabla(idSolicitud),
    () => delayAutoprocesadoMs()
);

// Autoprocesado de hojas. Con `inmediato` (botón Procesar o encendido del
// interruptor Auto) se cancela el debounce pendiente y se ejecuta en el acto.
function solicitarProcesamientoHojas({ inmediato = false, silencioso = false } = {}) {
    // Con el interruptor apagado, solo el botón manual puede disparar.
    if (!inmediato && !autoProcesarActivo) return;

    const idSolicitud = ++idSeleccionHojas;

    if (inmediato) {
        procesarHojasDebounced.cancelar();
        desmarcarHojaDebounced.cancelar();
        ejecutarProcesamientoHojas(idSolicitud, { silencioso });
        return;
    }

    desmarcarHojaDebounced.cancelar();
    procesarHojasDebounced(idSolicitud);
}

// Acción de quitar o desmarcar hojas envuelta con el helper debounce
const desmarcarHojaDebounced = debounce(
    (idSolicitud) => {
        if (!autoProcesarActivo) return;
        ejecutarProcesamientoHojas(idSolicitud, { silencioso: true });
    },
    () => delayAutoprocesadoMs()
);

const quitarHojaDebounced = desmarcarHojaDebounced;

// Función ejecutada al desmarcar o quitar hojas
function desmarcarHoja({ inmediato = false, silencioso = true } = {}) {
    if (!inmediato && !autoProcesarActivo) return;

    const idSolicitud = ++idSeleccionHojas;

    if (inmediato) {
        desmarcarHojaDebounced.cancelar();
        procesarHojasDebounced.cancelar();
        ejecutarProcesamientoHojas(idSolicitud, { silencioso });
        return;
    }

    procesarHojasDebounced.cancelar();
    desmarcarHojaDebounced(idSolicitud);
}

const quitarHoja = desmarcarHoja;

// Marcar hojas pasa por el debounce de selección. Si el usuario marca
// varias hojas seguidas, el temporizador se reinicia en cada clic y la
// recolección + recálculo se ejecutan una sola vez al final.
function solicitarProcesamientoPorSeleccion() {
    solicitarProcesamientoHojas({ silencioso: true });
}

// Autoprocesado de la tabla tras editar cantidad, total o comentario.
function programarRecalculoTabla() {
    if (!autoProcesarActivo) return;

    const idSolicitud = ++idRecalculoTabla;
    recalcularTablaDebounced(idSolicitud);
}

// Indicador "Procesando..." de la cabecera. Se usa un contador porque puede
// haber a la vez un procesamiento de hojas y un recálculo de la tabla.
function mostrarProcesando(texto = 'Procesando…') {
    tareasProcesando++;

    const indicador = document.getElementById('estadoProcesamiento');
    if (!indicador) return;

    const etiqueta = indicador.querySelector('.processing-text');
    if (etiqueta) etiqueta.textContent = texto;

    indicador.hidden = false;
}

function ocultarProcesando() {
    tareasProcesando = Math.max(0, tareasProcesando - 1);

    if (tareasProcesando > 0) return;

    const indicador = document.getElementById('estadoProcesamiento');
    if (indicador) indicador.hidden = true;
}

// Refleja el interruptor en la UI: checkbox marcado, grupo resaltado y botón
// manual deshabilitado mientras el autoprocesado esté activo.
function aplicarAutoProcesar(activo, { persistir = false } = {}) {
    autoProcesarActivo = Boolean(activo);

    const grupo = document.getElementById('grupoProcesar');
    const chk = document.getElementById('chkAutoProcesar');
    const btn = document.getElementById('btnProcesarSeleccionadas');

    if (chk) chk.checked = autoProcesarActivo;
    if (grupo) grupo.classList.toggle('auto-activo', autoProcesarActivo);

    if (btn) {
        btn.disabled = autoProcesarActivo;
        btn.setAttribute('aria-disabled', String(autoProcesarActivo));
        btn.title = autoProcesarActivo
            ? 'Auto-procesar activo: las hojas se procesan automáticamente'
            : 'Procesar hojas seleccionadas';
    }

    if (!autoProcesarActivo) {
        // Al apagarlo, se descartan los debounces pendientes y se invalidan
        // las tareas en curso para que no rendericen resultados viejos.
        idSeleccionHojas++;
        idRecalculoTabla++;
        procesarHojasDebounced.cancelar();
        desmarcarHojaDebounced.cancelar();
        recalcularTablaDebounced.cancelar();
    }

    if (persistir) {
        invoke('guardar_auto_procesar', { activo: autoProcesarActivo }).catch(error => {
            console.error('No se pudo guardar el estado de auto-procesar:', error);
        });
    }
}

async function inicializarAutoProcesar() {
    try {
        const activo = await invoke('obtener_auto_procesar');
        aplicarAutoProcesar(activo);
    } catch (error) {
        console.error('No se pudo leer el estado de auto-procesar:', error);
        aplicarAutoProcesar(true);
    }
}

// --- ÚNICO BLOQUE DOMContentLoaded ---
window.addEventListener('DOMContentLoaded', () => {
    const btnAddSection = document.getElementById('btnAddSection');
    const sectionList = document.getElementById('sectionList');
    const btnSaveGroup = document.getElementById('btnSaveGroup');
    const btnNewGroup = document.getElementById('btnNewGroup');
    const btnImportarGruposExcel = document.getElementById('btnImportarGruposExcel');
    const btnAdjust = document.getElementById('btnAdjust');
    const btnAddExcel = document.getElementById('btnAddExcel');
    const btnEliminarSeleccionados = document.getElementById('btnEliminarSeleccionados');
    const btnAddDiccionario = document.getElementById('btnAddDiccionario');
    const dictionaryList = document.getElementById('dictionaryList');
    const btnProcesarSeleccionadas = document.getElementById('btnProcesarSeleccionadas');
    const btnLimpiarSeleccion = document.getElementById('btnLimpiarSeleccion');
    const btnCalcularTotal = document.getElementById('btnCalcularTotal');
    const btnCalcularVinculados = document.getElementById('btnCalcularVinculados');
    const btnResumenColores = document.getElementById('btnResumenColores');
    const btnVincular = document.getElementById('btnVincular');
    const inputTituloConsolidado = document.getElementById('tituloConsolidado');

    // Carga inicial de los colores persistidos (no bloquea el arranque)
    coloresCargadosPromise = cargarColoresFilas();

    // Carga inicial de las vinculaciones archivo-grupo (no bloquea el arranque)
    vinculacionesCargadasPromise = cargarVinculaciones();

    // Carga inicial de los ajustes de procesamiento (no bloquea el arranque)
    ajustesCargadosPromise = cargarAjustesProcesamiento();

    // Resumen visual de colores aplicados (solo lectura)
    if (btnResumenColores) {
        btnResumenColores.addEventListener('click', abrirResumenColores);
    }

    // Filtro por color de la tabla (reemplaza al antiguo botón "Auto-color")
    const btnFiltrarColor = document.getElementById('btnFiltrarColor');
    if (btnFiltrarColor) {
        btnFiltrarColor.addEventListener('click', abrirMenuFiltroColor);
    }

    // Cierre del menú de filtro: clic fuera, Escape, scroll, resize o blur
    document.addEventListener('click', (evento) => {
        if (!menuFiltroColor) return;
        if (evento.target.closest && evento.target.closest('#colorFilterMenu, #btnFiltrarColor')) return;
        cerrarMenuFiltroColor();
    });
    document.addEventListener('keydown', (evento) => {
        if (evento.key === 'Escape' && menuFiltroColor) cerrarMenuFiltroColor();
    });
    document.addEventListener('scroll', () => {
        if (menuFiltroColor) cerrarMenuFiltroColor();
    }, true);
    window.addEventListener('resize', cerrarMenuFiltroColor);
    window.addEventListener('blur', cerrarMenuFiltroColor);

    // Vinculación de archivos Excel con los grupos guardados
    if (btnVincular) {
        btnVincular.addEventListener('click', abrirModalVincular);
    }

    // Ajustes de procesamiento (delay y sinónimos de columnas)
    const btnAjustesProcesamiento = document.getElementById('btnAjustesProcesamiento');
    if (btnAjustesProcesamiento) {
        btnAjustesProcesamiento.addEventListener('click', abrirAjustesProcesamiento);
    }

    // Exportación: Excel (.xlsx) y PDF (respetan el filtro de color activo)
    const btnExportExcel = document.getElementById('btnExportExcel');
    const btnExportPdf = document.getElementById('btnExportPdf');

    if (btnExportExcel) {
        btnExportExcel.addEventListener('click', exportarExcel);
    }
    if (btnExportPdf) {
        btnExportPdf.addEventListener('click', exportarPdf);
    }

    // Cierre de la ventana: volcado de colores y cierre forzado.
    //
    // `onCloseRequested` de Tauri impide el cierre nativo (lo intercepta el
    // JS), así que somos nosotros quienes debemos cerrar. Se usa `destroy()`
    // y NO `close()`: `close()` vuelve a emitir `closeRequested` y, como
    // `core:window:default` no incluye `allow-destroy`, el cierre se quedaba
    // esperando para siempre (ventana abierta y proceso colgado).
    if (window.__TAURI__?.window?.getCurrentWindow) {
        const ventanaActual = window.__TAURI__.window.getCurrentWindow();
        let cerrando = false;

        ventanaActual.onCloseRequested(async (evento) => {
            // Doble clic en la X u otro evento mientras se guarda: se bloquea
            // el cierre nativo para no cortar el guardado a medias.
            if (cerrando) {
                evento.preventDefault();
                return;
            }

            cerrando = true;
            evento.preventDefault();

            try {
                // Si el store no responde, no se retiene al usuario más de 1.5 s.
                // `flushColoresAlCerrar` ya captura sus propios errores.
                await Promise.race([
                    flushColoresAlCerrar(),
                    new Promise(resolve => setTimeout(resolve, 1500))
                ]);
            } catch (error) {
                console.error('Error al guardar los colores antes de cerrar:', error);
            } finally {
                // `destroy()` no vuelve a emitir `closeRequested`: evita el
                // bucle y cierra aunque el guardado haya fallado.
                try {
                    await ventanaActual.destroy();
                } catch (error) {
                    // Si falla (p. ej. falta el permiso en una build vieja),
                    // se libera la bandera para que otra pulsación de X lo
                    // reintente, en vez de dejar la ventana muerta.
                    cerrando = false;
                    console.error(
                        'No se pudo cerrar la ventana (revisa el permiso core:window:allow-destroy):',
                        error
                    );
                }
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

            // Sobre el input de cantidad se conserva el menú nativo del
            // navegador (copiar/pegar), útil para pegar valores de Excel.
            if (evento.target.closest('.input-cantidad')) return;

            evento.preventDefault();
            evento.stopPropagation();

            abrirMenuColores(evento.clientX, evento.clientY, idFila, fila);
        });

        // Edición manual de la cantidad. Se usa delegación para que sobreviva
        // a los repintados de la tabla (innerHTML = '').
        tablaConsolidadaBody.addEventListener('input', (evento) => {
            const inputCantidad = evento.target.closest('.input-cantidad');
            if (inputCantidad) aplicarCantidadManual(inputCantidad);

            const inputTotal = evento.target.closest('.input-cantidad-total');
            if (inputTotal) aplicarTotalManual(inputTotal);

            // Comentarios, cantidades y totales disparan el recálculo
            // automático con el delay configurado en el Store.
            if (evento.target.closest(
                '.input-cantidad, .input-cantidad-total, .input-comentario'
            )) {
                programarRecalculoTabla();
            }
        });

        tablaConsolidadaBody.addEventListener('change', (evento) => {
            const inputCantidad = evento.target.closest('.input-cantidad');
            if (inputCantidad) aplicarCantidadManual(inputCantidad, { confirmar: true });

            const inputTotal = evento.target.closest('.input-cantidad-total');
            if (inputTotal) aplicarTotalManual(inputTotal, { confirmar: true });
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
                // `calcular_total` no vuelve a leer el Excel: recibe la lista de
                // estado y solo escala `cantidad` para obtener `cantidad_total`.
                // Las filas con modificadoManualmente ya llevan su cantidad base
                // fijada por el usuario, así que no se sobrescriben.
                const conTotales = await invoke('calcular_total', {
                    ingredientes: ingredientesConsolidados,
                    secciones: seccionesActuales
                });

                pintarTablaConsolidadaConTotal(conTotales);
                ultimoCalculoVinculado = false;
            } catch (error) {
                console.error('Error al calcular total:', error);
                alert('Error al calcular total: ' + error);
            }
        });
    }

    if (btnCalcularVinculados) {
        btnCalcularVinculados.addEventListener('click', calcularVinculados);
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

    // Elimina de la lista los archivos marcados con su casilla.
    if (btnEliminarSeleccionados) {
        btnEliminarSeleccionados.addEventListener('click', eliminarArchivosSeleccionados);
    }

    const fileList = document.getElementById('fileList');
    if (fileList) {
        // Delegación: la lista se repinta entera al agregar o quitar archivos.
        fileList.addEventListener('change', (evento) => {
            if (evento.target.closest('.chk-file, .chk-sheet')) {
                actualizarBotonEliminarSeleccionados();
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

    // --- Procesar todas las hojas seleccionadas ---
    if (btnProcesarSeleccionadas) {
        btnProcesarSeleccionadas.addEventListener('click', () => {
            // Con auto-procesado activo el botón está deshabilitado; si de
            // todos modos llega el clic, no se duplica el procesamiento.
            if (autoProcesarActivo) return;

            solicitarProcesamientoHojas({ inmediato: true });
        });
    }

    // Interruptor "Auto": activa/desactiva el debounce y se guarda.
    const chkAutoProcesar = document.getElementById('chkAutoProcesar');
    if (chkAutoProcesar) {
        chkAutoProcesar.addEventListener('change', () => {
            aplicarAutoProcesar(chkAutoProcesar.checked, { persistir: true });

            // Gatillo inmediato: si ya había hojas marcadas, procesarlas
            // ahora mismo sin esperar a que el usuario cambie la selección.
            if (autoProcesarActivo
                && document.querySelectorAll('.chk-sheet:checked').length > 0) {
                solicitarProcesamientoHojas({ inmediato: true, silencioso: true });
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

            // Invalida cualquier autoprocesado en curso o pendiente: ya no
            // corresponde a la selección actual.
            idSeleccionHojas++;
            procesarHojasDebounced.cancelar();
            desmarcarHojaDebounced.cancelar();
            actualizarBotonEliminarSeleccionados();
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

    // --- Importar grupos desde un Excel (codigo / Asignatura / secciones / alumnos) ---
    if (btnImportarGruposExcel) {
        btnImportarGruposExcel.addEventListener('click', importarGruposDesdeExcel);
    }

    cargarArchivosRecientes();

    // El control de Vista compacta vive ahora en Ajustes → General. Aquí solo
    // se carga el valor persistido al arrancar; el modal espera esta promesa
    // para mostrar el estado real en su checkbox.
    vistaCompactaCargadaPromise = inicializarVistaCompacta();

    // La lista de grupos necesita el tamaño de página persistido antes de
    // pintarse, así que se carga después de leer esa configuración.
    gruposVistaCargadaPromise = inicializarGruposVista().then(() => cargarGruposGuardados());

    const btnGruposAnterior = document.getElementById('btnGruposAnterior');
    if (btnGruposAnterior) {
        btnGruposAnterior.addEventListener('click', () => irPaginaGrupos(-1));
    }

    const btnGruposSiguiente = document.getElementById('btnGruposSiguiente');
    if (btnGruposSiguiente) {
        btnGruposSiguiente.addEventListener('click', () => irPaginaGrupos(1));
    }

    inicializarAutoProcesar();
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

// --- VISTA COMPACTA Y PAGINACIÓN DE LA LISTA DE GRUPOS ---
// Igual que en la lista de archivos, la clase `.modo-compacto` se aplica al
// <ul id="savedList"> para sobrevivir a los repintados. El cache evita volver a
// leer el disco cada vez que se cambia de página.
const GRUPOS_POR_PAGINA_POR_DEFECTO = 10;
const GRUPOS_POR_PAGINA_MAX = 500;
const GRUPOS_POR_PAGINA_OPCIONES = [5, 10, 20, 50];

// `...Guardado` es lo persistido; `...Activo` es lo que se ve ahora mismo (el
// modal puede previsualizar un cambio sin guardarlo).
let vistaCompactaGruposGuardada = false;
let vistaCompactaGruposActiva = false;
let gruposPorPaginaGuardado = GRUPOS_POR_PAGINA_POR_DEFECTO;
let gruposPorPaginaActivo = GRUPOS_POR_PAGINA_POR_DEFECTO;

// Última lista leída de disco y página visible (0-based).
let gruposGuardadosCache = [];
let paginaGruposActual = 0;
let gruposVistaCargadaPromise = null;

function normalizarGruposPorPagina(valor) {
    const numero = Math.trunc(Number(valor));
    if (!Number.isFinite(numero) || numero < 1) return GRUPOS_POR_PAGINA_POR_DEFECTO;
    return Math.min(numero, GRUPOS_POR_PAGINA_MAX);
}

function aplicarVistaCompactaGrupos(activa) {
    vistaCompactaGruposActiva = Boolean(activa);

    const savedList = document.getElementById('savedList');
    if (savedList) {
        savedList.classList.toggle('modo-compacto', vistaCompactaGruposActiva);
    }

    // Mantiene el interruptor del modal sincronizado.
    const chk = document.getElementById('ajusteVistaCompactaGrupos');
    if (chk) {
        chk.checked = vistaCompactaGruposActiva;
        if (chk.getAttribute('role') === 'switch') {
            chk.setAttribute('aria-checked', String(vistaCompactaGruposActiva));
        }
    }
}

function aplicarGruposPorPagina(cantidad) {
    gruposPorPaginaActivo = normalizarGruposPorPagina(cantidad);

    const totalPaginas = Math.max(
        1,
        Math.ceil(gruposGuardadosCache.length / gruposPorPaginaActivo)
    );
    paginaGruposActual = Math.min(paginaGruposActual, totalPaginas - 1);

    const select = document.getElementById('ajusteGruposPorPagina');
    if (select) select.value = String(gruposPorPaginaActivo);

    renderizarGruposGuardados();
}

async function inicializarGruposVista() {
    try {
        const [compacta, porPagina] = await Promise.all([
            invoke('obtener_vista_compacta_grupos'),
            invoke('obtener_grupos_por_pagina')
        ]);

        vistaCompactaGruposGuardada = Boolean(compacta);
        gruposPorPaginaGuardado = normalizarGruposPorPagina(porPagina);
        gruposPorPaginaActivo = gruposPorPaginaGuardado;

        aplicarVistaCompactaGrupos(vistaCompactaGruposGuardada);
    } catch (error) {
        console.error('No se pudo leer la configuración de la lista de grupos:', error);
    }
}

async function cargarGruposGuardados() {
    const savedList = document.getElementById('savedList');
    if (!savedList) return;

    try {
        gruposGuardadosCache = await invoke('obtener_grupos_guardados');

        // Una recarga (guardar, eliminar, importar) puede dejar la página actual
        // fuera de rango.
        const totalPaginas = Math.max(
            1,
            Math.ceil(gruposGuardadosCache.length / gruposPorPaginaActivo)
        );
        paginaGruposActual = Math.min(paginaGruposActual, totalPaginas - 1);

        renderizarGruposGuardados();
    } catch (error) {
        console.error("Error al cargar grupos guardados:", error);
    }
}

// Pinta solo la página actual a partir del cache. Separado de
// `cargarGruposGuardados` para que cambiar de página no vuelva a leer el disco.
function renderizarGruposGuardados() {
    const savedList = document.getElementById('savedList');
    if (!savedList) return;

    savedList.innerHTML = '';

    // `data-index` es el índice global: "Usar" funciona igual en cualquier página.
    const inicio = paginaGruposActual * gruposPorPaginaActivo;
    const visibles = gruposGuardadosCache.slice(inicio, inicio + gruposPorPaginaActivo);

    visibles.forEach((grupo, offset) => {
        const index = inicio + offset;
        const li = document.createElement('li');
        const nombreSeguro = escaparHtml(grupo.nombre);
        // El `title` muestra el nombre completo cuando la vista compacta lo trunca.
        li.innerHTML = `
            <span class="saved-name" title="${nombreSeguro}">${nombreSeguro}</span>
            <button class="btn-use-group" data-index="${index}" type="button">Usar</button>
            <button class="btn-delete-saved" data-nombre="${nombreSeguro}" title="Eliminar grupo">
                <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg>
            </button>
        `;
        savedList.appendChild(li);
    });

    savedList.querySelectorAll('.btn-use-group').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const button = e.target.closest('.btn-use-group');
            const index = parseInt(button.dataset.index, 10);
            const grupo = gruposGuardadosCache[index];
            if (grupo) usarGrupoGuardado(grupo);
        });
    });

    savedList.querySelectorAll('.btn-delete-saved').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const button = e.target.closest('.btn-delete-saved');
            const nombre = button.dataset.nombre;
            if (confirm(`¿Estás seguro de que quieres eliminar el grupo "${nombre}"?`)) {
                try {
                    await invoke('eliminar_grupo', { nombreGrupo: nombre });
                    quitarGrupoDeVinculaciones(nombre);
                    await cargarGruposGuardados();
                } catch (error) {
                    alert("Error al eliminar el grupo: " + error);
                }
            }
        });
    });

    actualizarPaginacionGrupos();
}

function actualizarPaginacionGrupos() {
    const contenedor = document.getElementById('savedPagination');
    if (!contenedor) return;

    const total = gruposGuardadosCache.length;

    // Si todo cabe en una página, no hay nada que navegar.
    if (total <= gruposPorPaginaActivo) {
        contenedor.hidden = true;
        return;
    }

    const totalPaginas = Math.max(1, Math.ceil(total / gruposPorPaginaActivo));
    const info = document.getElementById('savedPaginationInfo');
    const btnAnterior = document.getElementById('btnGruposAnterior');
    const btnSiguiente = document.getElementById('btnGruposSiguiente');

    contenedor.hidden = false;
    if (info) info.textContent = `Página ${paginaGruposActual + 1} de ${totalPaginas}`;
    if (btnAnterior) btnAnterior.disabled = paginaGruposActual <= 0;
    if (btnSiguiente) btnSiguiente.disabled = paginaGruposActual >= totalPaginas - 1;
}

function irPaginaGrupos(delta) {
    const totalPaginas = Math.max(
        1,
        Math.ceil(gruposGuardadosCache.length / gruposPorPaginaActivo)
    );
    const destino = paginaGruposActual + delta;
    if (destino < 0 || destino >= totalPaginas) return;

    paginaGruposActual = destino;
    renderizarGruposGuardados();
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

// --- IMPORTACIÓN DE GRUPOS DESDE EXCEL ---
// El backend devuelve [{ nombre, codigo, asignatura, secciones: [{ tipo, alumnos }] }].
// Aquí se convierten las secciones a la forma que usa la UI y se persiste cada
// grupo con `guardar_grupo`, preguntando antes si el nombre ya existe.

function escaparHtml(texto) {
    return String(texto ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function claveNombreGrupo(nombre) {
    return String(nombre ?? '').trim().toLowerCase();
}

// Reparte las proporciones igual que `auto_ajustar_proporciones` en Rust.
function asignarIdsYProporciones(secciones) {
    const alumnoMax = Math.max(
        0,
        ...secciones.map(seccion => Math.max(0, Number(seccion.alumnos) || 0))
    );

    return secciones.map((seccion, indice) => {
        const alumnos = Math.max(0, Math.round(Number(seccion.alumnos) || 0));

        return {
            id: indice + 1,
            nombre: seccion.nombre,
            alumnos,
            proporcion: alumnoMax > 0
                ? Math.round((alumnos / alumnoMax) * 1000) / 10
                : 0
        };
    });
}

// Convierte la respuesta de Rust en secciones con nombre D1..Dn / V1..Vn.
function seccionesDesdeImportacion(lista) {
    const contadores = { D: 0, V: 0 };
    const secciones = [];

    (Array.isArray(lista) ? lista : []).forEach(seccion => {
        const tipo = String(seccion?.tipo ?? '').trim().toUpperCase().startsWith('V')
            ? 'V'
            : 'D';

        contadores[tipo] += 1;
        secciones.push({
            nombre: `${tipo}${contadores[tipo]}`,
            alumnos: Number(seccion?.alumnos) || 0
        });
    });

    return asignarIdsYProporciones(secciones);
}

// Une las secciones actuales con las importadas y renumera D/V para que no
// queden dos secciones con el mismo nombre tras la fusión.
function fusionarSecciones(existentes, nuevas) {
    const combinadas = [];

    (Array.isArray(existentes) ? existentes : []).forEach(seccion => {
        combinadas.push({
            nombre: String(seccion?.nombre ?? '').trim() || 'Sección',
            alumnos: Number(seccion?.alumnos) || 0
        });
    });

    (Array.isArray(nuevas) ? nuevas : []).forEach(seccion => combinadas.push(seccion));

    const contadores = { D: 0, V: 0 };
    const renombradas = combinadas.map(seccion => {
        const tipo = /^d/i.test(seccion.nombre)
            ? 'D'
            : (/^v/i.test(seccion.nombre) ? 'V' : null);

        if (!tipo) return seccion;

        contadores[tipo] += 1;
        return { ...seccion, nombre: `${tipo}${contadores[tipo]}` };
    });

    return asignarIdsYProporciones(renombradas);
}

// Pregunta qué hacer con un grupo que ya está guardado.
// Devuelve 'fusionar', 'reemplazar' o 'cancelar'.
function preguntarConflictoGrupo(nombre, cantidadNuevas) {
    return new Promise(resolve => {
        let decidido = false;

        const overlay = document.createElement('div');
        overlay.className = 'colors-modal-overlay';
        overlay.id = 'modalConflictoGrupo';

        const cerrar = (decision) => {
            if (decidido) return;
            decidido = true;
            document.removeEventListener('keydown', alEscape);
            overlay.remove();
            resolve(decision);
        };

        const alEscape = (evento) => {
            if (evento.key !== 'Escape') return;
            evento.preventDefault();
            cerrar('cancelar');
        };

        overlay.addEventListener('mousedown', evento => {
            if (evento.target === overlay) cerrar('cancelar');
        });

        const modal = document.createElement('div');
        modal.className = 'colors-modal import-conflict-modal';
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');
        modal.setAttribute('aria-labelledby', 'conflictoGrupoTitulo');

        const header = document.createElement('div');
        header.className = 'colors-modal-header';

        const titulo = document.createElement('div');
        titulo.className = 'colors-modal-title';
        titulo.id = 'conflictoGrupoTitulo';
        titulo.textContent = 'El grupo ya existe';

        header.appendChild(titulo);

        const body = document.createElement('div');
        body.className = 'import-conflict-body';

        const nombreFuerte = document.createElement('span');
        nombreFuerte.className = 'import-conflict-name';
        nombreFuerte.textContent = `"${nombre}"`;

        const pregunta = document.createElement('p');
        pregunta.append('Ya existe un grupo llamado ', nombreFuerte, '.');

        const detalle = document.createElement('p');
        detalle.className = 'import-conflict-hint';
        detalle.textContent = `El Excel aporta ${cantidadNuevas} `
            + `${cantidadNuevas === 1 ? 'sección' : 'secciones'}. `
            + 'Fusionar las agrega a las actuales; reemplazar borra las que tenía el grupo.';

        body.append(pregunta, detalle);

        const footer = document.createElement('div');
        footer.className = 'import-conflict-footer';

        const btnCancelar = document.createElement('button');
        btnCancelar.type = 'button';
        btnCancelar.className = 'settings-cancel';
        btnCancelar.textContent = 'Cancelar';
        btnCancelar.addEventListener('click', () => cerrar('cancelar'));

        const btnReemplazar = document.createElement('button');
        btnReemplazar.type = 'button';
        btnReemplazar.className = 'settings-danger';
        btnReemplazar.textContent = 'Reemplazar';
        btnReemplazar.addEventListener('click', () => cerrar('reemplazar'));

        const btnFusionar = document.createElement('button');
        btnFusionar.type = 'button';
        btnFusionar.className = 'settings-save';
        btnFusionar.textContent = 'Fusionar secciones';
        btnFusionar.addEventListener('click', () => cerrar('fusionar'));

        footer.append(btnCancelar, btnReemplazar, btnFusionar);
        modal.append(header, body, footer);
        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        document.addEventListener('keydown', alEscape);
        btnFusionar.focus();
    });
}

async function importarGruposDesdeExcel() {
    const boton = document.getElementById('btnImportarGruposExcel');
    if (boton?.disabled) return;

    let ruta = '';

    try {
        const seleccion = await window.__TAURI__.dialog.open({
            multiple: false,
            filters: [{ name: 'Archivos Excel', extensions: ['xlsx', 'xls'] }]
        });

        ruta = Array.isArray(seleccion) ? seleccion[0] : seleccion;
    } catch (error) {
        console.error('No se pudo abrir el selector de archivos:', error);
        return;
    }

    if (!ruta) return;

    if (boton) boton.disabled = true;

    try {
        let gruposImportados = [];

        try {
            gruposImportados = await invoke('importar_grupos_excel', { ruta });
        } catch (error) {
            await window.__TAURI__.dialog.message(
                'No se pudieron importar los grupos.\n\n' + String(error),
                { title: 'Importar grupos', kind: 'error' }
            );
            return;
        }

        if (!Array.isArray(gruposImportados) || gruposImportados.length === 0) {
            await window.__TAURI__.dialog.message(
                'El archivo no contiene grupos para importar.',
                { title: 'Importar grupos', kind: 'warning' }
            );
            return;
        }

        let guardados = [];

        try {
            guardados = await invoke('obtener_grupos_guardados');
        } catch (error) {
            console.error('No se pudieron leer los grupos existentes:', error);
        }

        const existentes = new Map();

        (Array.isArray(guardados) ? guardados : []).forEach(grupo => {
            const nombre = String(grupo?.nombre ?? '').trim();
            if (!nombre) return;

            existentes.set(claveNombreGrupo(nombre), {
                nombre,
                secciones: Array.isArray(grupo.secciones) ? grupo.secciones : []
            });
        });

        const resumen = {
            creados: 0,
            fusionados: 0,
            reemplazados: 0,
            omitidos: 0,
            fallidos: 0
        };

        for (const grupo of gruposImportados) {
            const nombreImportado = String(grupo?.nombre ?? '').trim();
            if (!nombreImportado) continue;

            const clave = claveNombreGrupo(nombreImportado);
            const existente = existentes.get(clave);
            let secciones = seccionesDesdeImportacion(grupo.secciones);

            if (secciones.length === 0) continue;

            let nombreGuardar = nombreImportado;
            let modo = 'crear';

            if (existente) {
                const decision = await preguntarConflictoGrupo(
                    existente.nombre,
                    secciones.length
                );

                if (decision === 'cancelar') {
                    resumen.omitidos++;
                    continue;
                }

                nombreGuardar = existente.nombre;
                modo = decision;

                if (decision === 'fusionar') {
                    secciones = fusionarSecciones(existente.secciones, secciones);
                }
            }

            try {
                await invoke('guardar_grupo', {
                    nombreGrupo: nombreGuardar,
                    secciones
                });

                existentes.set(clave, { nombre: nombreGuardar, secciones });

                if (modo === 'fusionar') resumen.fusionados++;
                else if (modo === 'reemplazar') resumen.reemplazados++;
                else resumen.creados++;
            } catch (error) {
                console.error(`No se pudo guardar el grupo "${nombreGuardar}":`, error);
                resumen.fallidos++;
            }
        }

        await cargarGruposGuardados();

        const partes = [];
        if (resumen.creados) {
            partes.push(`${resumen.creados} ${resumen.creados === 1 ? 'grupo creado' : 'grupos creados'}`);
        }
        if (resumen.fusionados) {
            partes.push(`${resumen.fusionados} ${resumen.fusionados === 1 ? 'grupo fusionado' : 'grupos fusionados'}`);
        }
        if (resumen.reemplazados) {
            partes.push(`${resumen.reemplazados} ${resumen.reemplazados === 1 ? 'grupo reemplazado' : 'grupos reemplazados'}`);
        }
        if (resumen.omitidos) {
            partes.push(`${resumen.omitidos} ${resumen.omitidos === 1 ? 'grupo omitido' : 'grupos omitidos'}`);
        }
        if (resumen.fallidos) {
            partes.push(`${resumen.fallidos} ${resumen.fallidos === 1 ? 'grupo con error' : 'grupos con error'}`);
        }

        await window.__TAURI__.dialog.message(
            'Importación completada.\n\n'
                + (partes.length > 0 ? partes.join('\n') : 'No se modificó ningún grupo.'),
            {
                title: 'Importar grupos',
                kind: resumen.fallidos > 0 ? 'warning' : 'info'
            }
        );
    } finally {
        if (boton) boton.disabled = false;
    }
}

// --- VISTA COMPACTA DE LA LISTA DE ARCHIVOS ---
// La clase se aplica al <ul id="fileList"> y no a cada ítem: la lista se
// repinta entera con `innerHTML = ''` cada vez que cambian los archivos, pero
// la clase del contenedor sobrevive a esos repintados.
// `vistaCompactaGuardada` es lo persistido; `vistaCompactaActiva` es lo que se
// ve ahora mismo (el modal puede previsualizar un cambio sin guardarlo).
let vistaCompactaGuardada = false;
let vistaCompactaActiva = false;

function aplicarVistaCompacta(activa) {
    vistaCompactaActiva = Boolean(activa);

    const fileList = document.getElementById('fileList');
    if (fileList) fileList.classList.toggle('modo-compacto', vistaCompactaActiva);

    // Mantiene el checkbox del modal sincronizado.
    const chk = document.getElementById('ajusteVistaCompacta');
    if (chk) {
        chk.checked = vistaCompactaActiva;
        if (chk.getAttribute('role') === 'switch') {
            chk.setAttribute('aria-checked', String(vistaCompactaActiva));
        }
    }
}

async function inicializarVistaCompacta() {
    try {
        const activa = Boolean(await invoke('obtener_vista_compacta'));
        vistaCompactaGuardada = activa;
        aplicarVistaCompacta(activa);
    } catch (error) {
        console.error('No se pudo leer la vista compacta guardada:', error);
    }
}

// --- AJUSTES DE PROCESAMIENTO ---
// Preferencias configurables desde el modal del mismo nombre. Se persisten en
// config.json y las listas de detección las consume el backend al procesar.

const AJUSTES_POR_DEFECTO = crearAjustesPorDefecto();
const MAPEO_POR_DEFECTO = crearMapeoPorDefecto();

// Valores estables (`valor`) y etiquetas visibles (`texto`) de los ajustes
// con opciones fijas. El tema se muestra en el modal como interruptor.
const TEMAS_AJUSTES = [
    { valor: 'claro', texto: 'Claro' },
    { valor: 'oscuro', texto: 'Oscuro' }
];

const FORMATOS_NUMEROS_AJUSTES = [
    { valor: 'punto', texto: 'Punto (1,234.56)' },
    { valor: 'coma', texto: 'Coma (1.234,56)' },
    { valor: 'sin-decimales', texto: 'Sin decimales (1,235)' }
];

const INGREDIENTES_NO_ENCONTRADOS_AJUSTES = [
    { valor: 'omitir', texto: 'Omitir' },
    { valor: 'blanco', texto: 'Dejar en blanco' },
    { valor: 'similitud', texto: 'Buscar similitud' }
];

// Columnas configurables de la exportación. El id es estable y debe coincidir
// con el que entiende el frontend al exportar.
const COLUMNAS_AJUSTES_EXPORTACION = [
    { id: 'ingrediente', etiqueta: 'Ingrediente' },
    { id: 'codigo', etiqueta: 'Código' },
    { id: 'unidad', etiqueta: 'Unidad' },
    { id: 'cantidad', etiqueta: 'Cantidad' },
    { id: 'total', etiqueta: 'Total' },
    { id: 'comentarios', etiqueta: 'Comentarios' }
];

// Acepta número o el texto de un input. Un valor vacío o inválido cae al default.
function enteroNoNegativo(valor, defecto) {
    const texto = String(valor ?? '').trim();
    if (texto === '') return defecto;

    const numero = Math.trunc(Number(texto));
    return Number.isFinite(numero) && numero >= 0 ? numero : defecto;
}

// "a, b, a" -> ["a", "b"]: sin vacíos ni duplicados (sin distinguir mayúsculas).
function listaSinonimos(valor) {
    const texto = Array.isArray(valor) ? valor.join(',') : String(valor ?? '');
    const vistos = new Set();
    const lista = [];

    texto.split(',').forEach(parte => {
        const limpio = parte.trim().replace(/\s+/g, ' ');
        if (!limpio) return;

        const clave = limpio.toLowerCase();
        if (vistos.has(clave)) return;

        vistos.add(clave);
        lista.push(limpio);
    });

    return lista;
}

// Un valor booleano guardado como texto ("true"/"false") también es válido.
function booleano(valor, defecto) {
    if (typeof valor === 'boolean') return valor;
    if (valor === 'true') return true;
    if (valor === 'false') return false;
    return defecto;
}

// Devuelve el `valor` estable de una opción o el default si no coincide.
function opcionPermitida(valor, opciones, defecto) {
    const texto = String(valor ?? '').trim();
    if (!texto) return defecto;

    const encontrada = opciones.find(opcion =>
        opcion.valor.toLowerCase() === texto.toLowerCase()
    );

    return encontrada ? encontrada.valor : defecto;
}

// Solo acepta ids conocidos, sin duplicados. Un array vacío es válido: el
// usuario puede desmarcar todas las columnas.
function columnasExportacionSeleccionadas(valor) {
    const permitidas = new Set(COLUMNAS_AJUSTES_EXPORTACION.map(columna => columna.id));
    const origen = Array.isArray(valor)
        ? valor
        : AJUSTES_POR_DEFECTO.columnasExportacion;
    const vistos = new Set();
    const lista = [];

    origen.forEach(id => {
        const limpio = String(id ?? '').trim().toLowerCase();
        if (!permitidas.has(limpio) || vistos.has(limpio)) return;

        vistos.add(limpio);
        lista.push(limpio);
    });

    return lista;
}

function normalizarAjustes(valores) {
    const fuente = valores && typeof valores === 'object' ? valores : {};

    return {
        delayAutoprocesadoMs: enteroNoNegativo(
            fuente.delayAutoprocesadoMs,
            AJUSTES_POR_DEFECTO.delayAutoprocesadoMs
        ),
        tema: opcionPermitida(fuente.tema, TEMAS_AJUSTES, AJUSTES_POR_DEFECTO.tema),
        formatoNumeros: opcionPermitida(
            fuente.formatoNumeros,
            FORMATOS_NUMEROS_AJUSTES,
            AJUSTES_POR_DEFECTO.formatoNumeros
        ),
        incluirColoresExportacion: booleano(
            fuente.incluirColoresExportacion,
            AJUSTES_POR_DEFECTO.incluirColoresExportacion
        ),
        columnasExportacion: columnasExportacionSeleccionadas(
            fuente.columnasExportacion
        ),
        ingredientesNoEncontrados: opcionPermitida(
            fuente.ingredientesNoEncontrados,
            INGREDIENTES_NO_ENCONTRADOS_AJUSTES,
            AJUSTES_POR_DEFECTO.ingredientesNoEncontrados
        )
    };
}

// Normaliza la tabla de equivalencias de unidades: una forma estándar por
// entrada y variantes sin vacíos ni duplicados. Una variante solo puede
// pertenecer a una unidad (la primera que la declare gana).
function normalizarUnidadesMapeo(valor) {
    const origen = Array.isArray(valor) ? valor : [];

    // Primero se recogen los estándares: ninguna variante puede coincidir con
    // la unidad estándar de OTRA fila (sí puede repetir la suya, que es
    // redundante pero se respeta tal como la escribió el usuario).
    const preparadas = [];
    const estandares = new Set();

    origen.forEach(item => {
        if (!item || typeof item !== 'object') return;

        const estandar = normalizarValorLista(item.estandar);
        if (!estandar) return;

        const claveEstandar = estandar.toLowerCase();
        if (estandares.has(claveEstandar)) return;

        estandares.add(claveEstandar);
        preparadas.push({
            estandar,
            claveEstandar,
            variantesOrigen: Array.isArray(item.variantes) ? item.variantes : []
        });
    });

    const variantesUsadas = new Set();

    return preparadas.map(unidad => {
        const variantes = [];

        unidad.variantesOrigen.forEach(variante => {
            const limpia = normalizarValorLista(variante);
            if (!limpia) return;

            const clave = limpia.toLowerCase();
            if (variantesUsadas.has(clave)) return;
            if (estandares.has(clave) && clave !== unidad.claveEstandar) return;

            variantesUsadas.add(clave);
            variantes.push(limpia);
        });

        return { estandar: unidad.estandar, variantes };
    });
}

function normalizarMapeoInsumos(valores) {
    const fuente = valores && typeof valores === 'object' ? valores : {};

    // Mapeo guardado por una versión anterior a las listas dinámicas: las
    // listas nuevas pueden faltar y las viejas pueden estar vacías.
    const esConfigHeredada = !('sinonimosTotal' in fuente);

    // En un mapeo heredado, una lista vacía se completa con el valor
    // recomendado; en uno nuevo, una lista vacía es una elección del usuario.
    const listaConRecomendados = (valor, recomendados) => {
        const lista = listaSinonimos(valor);

        if (esConfigHeredada && lista.length === 0) {
            return listaSinonimos(recomendados);
        }

        return lista;
    };

    // La tabla de unidades puede faltar en un mapeo guardado antes de esta
    // función; un array vacío explícito sí se respeta.
    const sinUnidades = !('unidades' in fuente);

    return {
        sinonimosIngrediente: listaConRecomendados(
            fuente.sinonimosIngrediente,
            MAPEO_POR_DEFECTO.sinonimosIngrediente
        ),
        sinonimosUnidad: listaConRecomendados(
            fuente.sinonimosUnidad,
            MAPEO_POR_DEFECTO.sinonimosUnidad
        ),
        sinonimosCantidad: listaConRecomendados(
            fuente.sinonimosCantidad,
            MAPEO_POR_DEFECTO.sinonimosCantidad
        ),
        sinonimosTotal: listaConRecomendados(
            fuente.sinonimosTotal,
            MAPEO_POR_DEFECTO.sinonimosTotal
        ),
        palabrasFilaIgnorada: listaConRecomendados(
            fuente.palabrasFilaIgnorada,
            MAPEO_POR_DEFECTO.palabrasFilaIgnorada
        ),
        unidades: sinUnidades
            ? normalizarUnidadesMapeo(MAPEO_POR_DEFECTO.unidades)
            : normalizarUnidadesMapeo(fuente.unidades),
        filasCabeceraIgnoradas: enteroNoNegativo(
            fuente.filasCabeceraIgnoradas,
            MAPEO_POR_DEFECTO.filasCabeceraIgnoradas
        ),
        filasEscaneoCabecera: enteroNoNegativo(
            fuente.filasEscaneoCabecera,
            MAPEO_POR_DEFECTO.filasEscaneoCabecera
        )
    };
}

// Devuelve las listas obligatorias del mapeo que quedaron vacías, con el mismo
// criterio que valida el backend, para avisar antes de guardar.
function faltantesMapeoInsumos(mapeo) {
    const faltantes = [];

    if (!mapeo.sinonimosIngrediente.length) {
        faltantes.push('Sinónimos de ingrediente');
    }
    if (!mapeo.sinonimosUnidad.length) {
        faltantes.push('Sinónimos de unidad');
    }
    if (
        !mapeo.sinonimosCantidad.length
        && !mapeo.sinonimosTotal.length
    ) {
        faltantes.push('Sinónimos de cantidad o de total');
    }
    if (mapeo.filasEscaneoCabecera < 1) {
        faltantes.push('Filas a examinar buscando la cabecera (mínimo 1)');
    }

    return faltantes;
}

// Aplica el tema visual a toda la app. La clase vive en <body> y el CSS define
// las variables de color de cada modo.
function aplicarTema(tema) {
    const oscuro = tema === 'oscuro';

    document.body.classList.toggle('modo-oscuro', oscuro);
    document.body.classList.toggle('modo-claro', !oscuro);
    document.documentElement.style.colorScheme = oscuro ? 'dark' : 'light';
}

async function cargarAjustesProcesamiento() {
    const [resultadoAjustes, resultadoMapeo] = await Promise.allSettled([
        invoke('obtener_ajustes_procesamiento'),
        invoke('obtener_mapeo_insumos')
    ]);

    if (resultadoAjustes.status === 'fulfilled') {
        ajustesProcesamiento = normalizarAjustes(resultadoAjustes.value);
    } else {
        console.error(
            'No se pudieron leer los ajustes generales:',
            resultadoAjustes.reason
        );
        ajustesProcesamiento = normalizarAjustes(null);
    }

    if (resultadoMapeo.status === 'fulfilled') {
        mapeoInsumos = normalizarMapeoInsumos(resultadoMapeo.value);
    } else {
        console.error(
            'No se pudo leer el mapeo de insumos:',
            resultadoMapeo.reason
        );
        mapeoInsumos = normalizarMapeoInsumos(null);
    }

    // El tema guardado se aplica en cuanto se conoce, sin esperar al modal.
    aplicarTema(ajustesProcesamiento.tema);
    reformatearCantidadesTabla();

    return { ajustes: ajustesProcesamiento, mapeo: mapeoInsumos };
}

function cerrarAjustesProcesamiento() {
    const overlay = document.getElementById('modalAjustesProcesamiento');
    if (overlay) overlay.remove();

    document.removeEventListener('keydown', cerrarAjustesPorEscape);

    // Si se previsualizó otro tema, formato o vista compacta y no se guardó,
    // la app vuelve al estado persistido.
    if (overlay) {
        formatoNumerosVista = null;
        aplicarTema(ajustesProcesamiento.tema);
        reformatearCantidadesTabla();
        aplicarVistaCompacta(vistaCompactaGuardada);
        aplicarVistaCompactaGrupos(vistaCompactaGruposGuardada);
        aplicarGruposPorPagina(gruposPorPaginaGuardado);
    }
}

function cerrarAjustesPorEscape(evento) {
    if (evento.key !== 'Escape') return;
    if (!document.getElementById('modalAjustesProcesamiento')) return;

    evento.stopPropagation();
    cerrarAjustesProcesamiento();
}

// Campo etiquetado reutilizado por las secciones del modal.
function crearCampoAjuste({ id, etiqueta, tipo = 'text', valor = '', pista = '', min, step, placeholder }) {
    const campo = document.createElement('label');
    campo.className = 'settings-field';
    campo.htmlFor = id;

    const label = document.createElement('span');
    label.className = 'settings-label';
    label.textContent = etiqueta;
    campo.appendChild(label);

    const input = document.createElement('input');
    input.id = id;
    input.className = 'settings-input';
    input.type = tipo;
    input.value = valor;

    if (min !== undefined) input.min = String(min);
    if (step !== undefined) input.step = String(step);
    if (placeholder) input.placeholder = placeholder;

    campo.appendChild(input);

    if (pista) {
        const ayuda = document.createElement('span');
        ayuda.className = 'settings-hint';
        ayuda.textContent = pista;
        campo.appendChild(ayuda);
    }

    return campo;
}

function seccionAjustes(titulo, ...contenido) {
    const seccion = document.createElement('div');
    seccion.className = 'settings-section';

    const heading = document.createElement('div');
    heading.className = 'settings-section-title';
    heading.textContent = titulo;

    seccion.append(heading, ...contenido);
    return seccion;
}

// Select etiquetado. Si el valor guardado no está entre las opciones, se
// selecciona la primera para no dejar el control vacío. `onChange` permite
// previsualizar el cambio sin guardar (tema, formato de números).
function crearSelectAjuste({ id, etiqueta, valor, opciones, pista, onChange }) {
    const campo = document.createElement('label');
    campo.className = 'settings-field';
    campo.htmlFor = id;

    const label = document.createElement('span');
    label.className = 'settings-label';
    label.textContent = etiqueta;
    campo.appendChild(label);

    const select = document.createElement('select');
    select.id = id;
    select.className = 'settings-input settings-select';

    opciones.forEach(opcion => {
        const option = document.createElement('option');
        option.value = opcion.valor;
        option.textContent = opcion.texto;
        select.appendChild(option);
    });

    const disponible = opciones.some(opcion => opcion.valor === valor);
    select.value = disponible ? valor : (opciones[0]?.valor || '');

    if (typeof onChange === 'function') {
        select.addEventListener('change', () => onChange(select.value, select));
    }

    campo.appendChild(select);

    if (pista) {
        const ayuda = document.createElement('span');
        ayuda.className = 'settings-hint';
        ayuda.textContent = pista;
        campo.appendChild(ayuda);
    }

    return campo;
}

// Checkbox etiquetado con toda la fila clickeable. `onChange` permite
// previsualizar el cambio sin guardar (vista compacta).
function crearCheckboxAjuste({ id, etiqueta, marcado, pista, onChange }) {
    const campo = document.createElement('label');
    campo.className = 'settings-check';
    campo.htmlFor = id;

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.id = id;
    input.checked = Boolean(marcado);

    if (typeof onChange === 'function') {
        input.addEventListener('change', () => onChange(input.checked, input));
    }

    const texto = document.createElement('span');
    texto.className = 'settings-check-label';
    texto.textContent = etiqueta;

    campo.append(input, texto);

    if (pista) {
        const ayuda = document.createElement('span');
        ayuda.className = 'settings-hint settings-check-hint';
        ayuda.textContent = pista;
        campo.appendChild(ayuda);
    }

    return campo;
}

// Interruptor (toggle switch) con título arriba, control + texto en medio y
// ayuda abajo. `onChange` permite previsualizar el cambio sin guardar.
function crearToggleAjuste({ id, etiqueta, marcado, texto, pista, onChange }) {
    const campo = document.createElement('div');
    campo.className = 'settings-toggle-field';

    const titulo = document.createElement('span');
    titulo.className = 'settings-label';
    titulo.textContent = etiqueta;

    const control = document.createElement('label');
    control.className = 'settings-toggle';

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.id = id;
    input.setAttribute('role', 'switch');
    input.setAttribute('aria-label', etiqueta);
    input.checked = Boolean(marcado);
    input.setAttribute('aria-checked', String(input.checked));

    const track = document.createElement('span');
    track.className = 'settings-toggle-track';
    track.setAttribute('aria-hidden', 'true');

    const thumb = document.createElement('span');
    thumb.className = 'settings-toggle-thumb';
    track.appendChild(thumb);

    const textoControl = document.createElement('span');
    textoControl.className = 'settings-toggle-text';
    textoControl.textContent = texto;

    input.addEventListener('change', () => {
        input.setAttribute('aria-checked', String(input.checked));
        if (typeof onChange === 'function') onChange(input.checked, input);
    });

    control.append(input, track, textoControl);
    campo.append(titulo, control);

    if (pista) {
        const ayuda = document.createElement('span');
        ayuda.className = 'settings-hint';
        ayuda.textContent = pista;
        campo.appendChild(ayuda);
    }

    return campo;
}

// --- EDITORES DE LISTAS DEL MODAL DE AJUSTES ---
// Cada lista (sinónimos, filtros…) se edita con filas verticales: agregar,
// editar en línea y eliminar. El estado vive en memoria y se refleja en un
// input oculto con JSON, que es lo que lee `leerAjustesDesdeModal`.
const editoresListaAjustes = new Map();

function normalizarValorLista(valor) {
    return String(valor ?? '').trim().replace(/\s+/g, ' ');
}

function crearBotonLista(etiqueta, clase, onClick, titulo = etiqueta) {
    const boton = document.createElement('button');
    boton.type = 'button';
    boton.className = clase;
    boton.title = titulo;
    boton.setAttribute('aria-label', titulo);
    boton.textContent = etiqueta;
    boton.addEventListener('click', onClick);
    return boton;
}

function crearEditorListaAjuste({
    id,
    etiqueta,
    valores = [],
    valoresPorDefecto = [],
    placeholder = 'Nuevo valor',
    pista = '',
    requerida = false,
    sinCabecera = false
}) {
    const campo = document.createElement('div');
    campo.className = sinCabecera
        ? 'settings-field settings-list-field settings-list-field-plain'
        : 'settings-field settings-list-field';

    const cabecera = document.createElement('div');
    cabecera.className = 'settings-label-row';

    if (!sinCabecera) {
        const label = document.createElement('span');
        label.className = 'settings-label';
        label.textContent = etiqueta;
        cabecera.appendChild(label);

        // Botón para volver a los valores que antes estaban fijos en el código.
        if (Array.isArray(valoresPorDefecto) && valoresPorDefecto.length > 0) {
            const btnRecomendados = crearBotonLista(
                'Usar recomendados',
                'settings-list-reset',
                () => restaurar()
            );
            btnRecomendados.title = 'Restaura los valores recomendados de esta lista';
            cabecera.appendChild(btnRecomendados);
        }
    }

    // Fuente de verdad para `leerAjustesDesdeModal`.
    const oculto = document.createElement('input');
    oculto.type = 'hidden';
    oculto.id = id;

    const items = document.createElement('div');
    items.className = 'settings-list-items';

    const error = document.createElement('span');
    error.className = 'settings-list-error';
    error.hidden = true;

    const filaAgregar = document.createElement('div');
    filaAgregar.className = 'settings-list-add';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'settings-input';
    input.placeholder = placeholder;
    input.setAttribute('aria-label', `Nuevo valor para ${etiqueta}`);

    const btnAgregar = crearBotonLista(
        '+ Agregar',
        'settings-list-add-btn',
        () => agregar(),
        'Agregar valor'
    );
    filaAgregar.append(input, btnAgregar);

    let lista = listaSinonimos(valores);
    let indiceEnEdicion = null;

    const sincronizar = () => {
        oculto.value = JSON.stringify(lista);
    };

    const mostrarError = (texto) => {
        error.textContent = texto;
        error.hidden = !texto;
    };

    const agregar = () => {
        const limpio = normalizarValorLista(input.value);

        if (!limpio) {
            mostrarError('Escribe un valor antes de agregarlo.');
            input.focus();
            return;
        }

        if (limpio.includes(',')) {
            mostrarError('Cada valor va en su propia fila: no uses comas.');
            input.focus();
            return;
        }

        const duplicado = lista.some(valor => valor.toLowerCase() === limpio.toLowerCase());
        if (duplicado) {
            mostrarError('Ese valor ya existe en la lista.');
            input.focus();
            return;
        }

        lista.push(limpio);
        input.value = '';
        mostrarError('');
        indiceEnEdicion = null;
        render();
        input.focus();
    };

    const render = () => {
        items.innerHTML = '';

        if (lista.length === 0) {
            const vacio = document.createElement('span');
            vacio.className = 'settings-list-empty';
            vacio.textContent = requerida
                ? 'Lista vacía: agrega al menos un valor.'
                : 'Sin valores.';
            items.appendChild(vacio);
        }

        lista.forEach((valor, indice) => {
            const fila = document.createElement('div');
            fila.className = 'settings-list-item';

            if (indiceEnEdicion === indice) {
                const inputEdicion = document.createElement('input');
                inputEdicion.type = 'text';
                inputEdicion.className = 'settings-input settings-list-edit-input';
                inputEdicion.value = valor;
                inputEdicion.setAttribute('aria-label', `Editar ${etiqueta}`);

                const confirmar = () => {
                    const limpio = normalizarValorLista(inputEdicion.value);

                    if (!limpio) {
                        mostrarError('El valor no puede quedar vacío.');
                        inputEdicion.focus();
                        return;
                    }

                    if (limpio.includes(',')) {
                        mostrarError('Cada valor va en su propia fila: no uses comas.');
                        inputEdicion.focus();
                        return;
                    }

                    const duplicado = lista.some(
                        (otro, otroIndice) =>
                            otroIndice !== indice
                            && otro.toLowerCase() === limpio.toLowerCase()
                    );

                    if (duplicado) {
                        mostrarError('Ese valor ya existe en la lista.');
                        inputEdicion.focus();
                        return;
                    }

                    lista[indice] = limpio;
                    indiceEnEdicion = null;
                    mostrarError('');
                    render();
                };

                const cancelar = () => {
                    indiceEnEdicion = null;
                    mostrarError('');
                    render();
                };

                inputEdicion.addEventListener('keydown', (evento) => {
                    // El modal guarda con Enter; aquí se intercepta para
                    // confirmar solo la edición del valor.
                    if (evento.key === 'Enter') {
                        evento.preventDefault();
                        evento.stopPropagation();
                        confirmar();
                    } else if (evento.key === 'Escape') {
                        evento.preventDefault();
                        evento.stopPropagation();
                        cancelar();
                    }
                });

                fila.append(
                    inputEdicion,
                    crearBotonLista('Guardar', 'settings-list-btn settings-list-btn-ok', confirmar),
                    crearBotonLista('Cancelar', 'settings-list-btn', cancelar)
                );

                items.appendChild(fila);
                // El foco se pone después de insertar en el documento.
                queueMicrotask(() => inputEdicion.focus());
                return;
            }

            const valorTexto = document.createElement('span');
            valorTexto.className = 'settings-list-value';
            valorTexto.textContent = valor;
            valorTexto.title = valor;

            fila.append(
                valorTexto,
                crearBotonLista('Editar', 'settings-list-btn', () => {
                    indiceEnEdicion = indice;
                    mostrarError('');
                    render();
                }),
                crearBotonLista(
                    '×',
                    'settings-list-btn settings-list-btn-x settings-list-btn-danger',
                    () => {
                        lista.splice(indice, 1);
                        indiceEnEdicion = null;
                        mostrarError('');
                        render();
                    },
                    `Eliminar "${valor}"`
                )
            );

            items.appendChild(fila);
        });

        sincronizar();
    };

    // Restaura la lista recomendada; la usan el botón de la cabecera y la
    // tabla de pares del "Mapeo de Insumos".
    const restaurar = () => {
        lista = listaSinonimos(valoresPorDefecto);
        indiceEnEdicion = null;
        mostrarError('');
        render();
    };

    input.addEventListener('keydown', (evento) => {
        if (evento.key !== 'Enter') return;

        // Evita que el Enter del modal guarde y cierre mientras se agrega.
        evento.preventDefault();
        evento.stopPropagation();
        agregar();
    });

    const partes = sinCabecera
        ? [oculto, items, filaAgregar, error]
        : [cabecera, oculto, items, filaAgregar, error];
    campo.append(...partes);

    if (pista && !sinCabecera) {
        const ayuda = document.createElement('span');
        ayuda.className = 'settings-hint';
        ayuda.textContent = pista;
        campo.appendChild(ayuda);
    }

    // Permite que "Restablecer todo" vuelva a dibujar la lista.
    editoresListaAjustes.set(id, {
        establecer: (nuevos) => {
            lista = listaSinonimos(nuevos);
            indiceEnEdicion = null;
            mostrarError('');
            render();
        },
        restaurar
    });

    render();
    return campo;
}

// --- TABLA DE PARES CONCEPTO → SINÓNIMOS ---
// Cada fila muestra a la izquierda el concepto base y a la derecha sus
// sinónimos en una lista vertical con botón × para quitar cada uno.
function crearTablaParesAjustes(titulo, filas) {
    const seccion = document.createElement('div');
    seccion.className = 'settings-section';

    const heading = document.createElement('div');
    heading.className = 'settings-section-title';
    heading.textContent = titulo;
    seccion.appendChild(heading);

    const tabla = document.createElement('div');
    tabla.className = 'settings-pair-table';

    const cabecera = document.createElement('div');
    cabecera.className = 'settings-pair-head';
    const conceptoHead = document.createElement('span');
    conceptoHead.textContent = 'Concepto';
    const valoresHead = document.createElement('span');
    valoresHead.textContent = 'Sinónimos / variantes';
    cabecera.append(conceptoHead, valoresHead);
    tabla.appendChild(cabecera);

    filas.forEach(fila => {
        const row = document.createElement('div');
        row.className = 'settings-pair-row';

        const concepto = document.createElement('div');
        concepto.className = 'settings-pair-concept';

        const label = document.createElement('span');
        label.className = 'settings-pair-label';
        label.textContent = fila.concepto;
        concepto.appendChild(label);

        if (fila.requerida) {
            const badge = document.createElement('span');
            badge.className = 'settings-pair-requerido';
            badge.textContent = 'obligatorio';
            concepto.appendChild(badge);
        }

        if (fila.pista) {
            const hint = document.createElement('span');
            hint.className = 'settings-pair-hint';
            hint.textContent = fila.pista;
            concepto.appendChild(hint);
        }

        if (Array.isArray(fila.valoresPorDefecto) && fila.valoresPorDefecto.length > 0) {
            const reset = document.createElement('button');
            reset.type = 'button';
            reset.className = 'settings-list-reset';
            reset.textContent = 'Recomendados';
            reset.title = `Restaura los valores recomendados de ${fila.concepto}`;
            reset.addEventListener('click', () => {
                editoresListaAjustes.get(fila.id)?.restaurar();
            });
            concepto.appendChild(reset);
        }

        const editor = crearEditorListaAjuste({
            id: fila.id,
            etiqueta: fila.concepto,
            valores: fila.valores,
            valoresPorDefecto: fila.valoresPorDefecto || [],
            placeholder: fila.placeholder,
            requerida: Boolean(fila.requerida),
            sinCabecera: true
        });

        row.append(concepto, editor);
        tabla.appendChild(row);
    });

    seccion.appendChild(tabla);
    return seccion;
}

// --- TABLA DE EQUIVALENCIAS DE UNIDADES ---
// Izquierda: unidad estándar. Derecha: variantes que se unifican a ella.
const editoresUnidadesAjustes = new Map();

function crearEditorUnidadesAjuste({ id, valores = [], valoresPorDefecto = [], pista = '' }) {
    const campo = document.createElement('div');
    campo.className = 'settings-field settings-list-field';

    const cabecera = document.createElement('div');
    cabecera.className = 'settings-label-row';

    const label = document.createElement('span');
    label.className = 'settings-label';
    label.textContent = 'Unidades de medida';
    cabecera.appendChild(label);

    const btnRecomendados = document.createElement('button');
    btnRecomendados.type = 'button';
    btnRecomendados.className = 'settings-list-reset';
    btnRecomendados.textContent = 'Usar recomendados';
    btnRecomendados.title = 'Restaura las equivalencias recomendadas';
    btnRecomendados.addEventListener('click', () => restaurar());
    cabecera.appendChild(btnRecomendados);

    // Fuente de verdad para `leerMapeoDesdeModal`.
    const oculto = document.createElement('input');
    oculto.type = 'hidden';
    oculto.id = id;

    const tabla = document.createElement('div');
    tabla.className = 'settings-pair-table settings-unidades-table';

    const cabeceraTabla = document.createElement('div');
    cabeceraTabla.className = 'settings-pair-head';
    const headEstandar = document.createElement('span');
    headEstandar.textContent = 'Unidad estándar';
    const headVariantes = document.createElement('span');
    headVariantes.textContent = 'Variantes que se unifican';
    cabeceraTabla.append(headEstandar, headVariantes);
    tabla.appendChild(cabeceraTabla);

    const filasEl = document.createElement('div');
    filasEl.className = 'settings-pair-rows';
    tabla.appendChild(filasEl);

    const error = document.createElement('span');
    error.className = 'settings-list-error';
    error.hidden = true;

    const filaAgregar = document.createElement('div');
    filaAgregar.className = 'settings-map-add';

    const inputEstandarNuevo = document.createElement('input');
    inputEstandarNuevo.type = 'text';
    inputEstandarNuevo.className = 'settings-input';
    inputEstandarNuevo.placeholder = 'Nueva unidad estándar (ej. Litro)';
    inputEstandarNuevo.setAttribute('aria-label', 'Nueva unidad estándar');

    const btnAgregarUnidad = crearBotonLista(
        'Agregar unidad',
        'settings-list-add-btn',
        () => agregarUnidad()
    );
    filaAgregar.append(inputEstandarNuevo, btnAgregarUnidad);

    let unidades = normalizarUnidadesMapeo(valores);
    let estandarEnEdicion = null;
    // { unidad, variante } mientras se edita una variante concreta.
    let varianteEnEdicion = null;

    const sincronizar = () => {
        oculto.value = JSON.stringify(unidades);
    };

    const mostrarError = (texto) => {
        error.textContent = texto;
        error.hidden = !texto;
    };

    const clave = (texto) => normalizarValorLista(texto).toLowerCase();

    // Devuelve la unidad que ya usa ese texto (como estándar o variante),
    // ignorando la entrada que se está editando.
    const unidadQueUsa = (texto, ignorar = null) => {
        const buscada = clave(texto);
        if (!buscada) return null;

        for (let indice = 0; indice < unidades.length; indice++) {
            const unidad = unidades[indice];
            const esMismoEstandar = Boolean(
                ignorar && ignorar.unidad === indice && ignorar.esEstandar
            );

            if (!esMismoEstandar && clave(unidad.estandar) === buscada) {
                return unidad;
            }

            for (let v = 0; v < unidad.variantes.length; v++) {
                const esMismaVariante = Boolean(
                    ignorar && ignorar.unidad === indice && ignorar.variante === v
                );
                if (!esMismaVariante && clave(unidad.variantes[v]) === buscada) {
                    return unidad;
                }
            }
        }

        return null;
    };

    const render = () => {
        filasEl.innerHTML = '';

        if (unidades.length === 0) {
            const vacio = document.createElement('div');
            vacio.className = 'settings-pair-row settings-pair-empty';
            vacio.textContent = 'Sin unidades configuradas: se muestran tal como vienen del Excel.';
            filasEl.appendChild(vacio);
        }

        unidades.forEach((unidad, indice) => {
            const fila = document.createElement('div');
            fila.className = 'settings-pair-row';

            // --- Izquierda: unidad estándar ---
            const concepto = document.createElement('div');
            concepto.className = 'settings-pair-concept';

            if (estandarEnEdicion === indice) {
                const inputEstandar = document.createElement('input');
                inputEstandar.type = 'text';
                inputEstandar.className = 'settings-input settings-map-input';
                inputEstandar.value = unidad.estandar;
                inputEstandar.setAttribute('aria-label', 'Editar unidad estándar');

                const confirmar = () => {
                    const valor = normalizarValorLista(inputEstandar.value);

                    if (!valor) {
                        mostrarError('La unidad estándar no puede quedar vacía.');
                        inputEstandar.focus();
                        return;
                    }

                    const dueno = unidadQueUsa(valor, { unidad: indice, esEstandar: true });
                    if (dueno) {
                        mostrarError(`"${valor}" ya está en uso por "${dueno.estandar}".`);
                        inputEstandar.focus();
                        return;
                    }

                    unidades[indice].estandar = valor;
                    estandarEnEdicion = null;
                    mostrarError('');
                    render();
                };

                const cancelar = () => {
                    estandarEnEdicion = null;
                    mostrarError('');
                    render();
                };

                inputEstandar.addEventListener('keydown', (evento) => {
                    if (evento.key === 'Enter') {
                        evento.preventDefault();
                        evento.stopPropagation();
                        confirmar();
                    } else if (evento.key === 'Escape') {
                        evento.preventDefault();
                        evento.stopPropagation();
                        cancelar();
                    }
                });

                concepto.append(
                    inputEstandar,
                    crearBotonLista('Guardar', 'settings-list-btn settings-list-btn-ok', confirmar),
                    crearBotonLista('Cancelar', 'settings-list-btn', cancelar)
                );
                queueMicrotask(() => inputEstandar.focus());
            } else {
                const estandar = document.createElement('span');
                estandar.className = 'settings-pair-label';
                estandar.textContent = unidad.estandar;
                concepto.appendChild(estandar);
                concepto.append(
                    crearBotonLista('Renombrar', 'settings-list-btn', () => {
                        estandarEnEdicion = indice;
                        mostrarError('');
                        render();
                    }),
                    crearBotonLista('Eliminar', 'settings-list-btn settings-list-btn-danger', () => {
                        unidades.splice(indice, 1);
                        estandarEnEdicion = null;
                        varianteEnEdicion = null;
                        mostrarError('');
                        render();
                    })
                );
            }

            // --- Derecha: variantes ---
            const variantesEl = document.createElement('div');
            variantesEl.className = 'settings-unidad-variantes';

            const chips = document.createElement('div');
            chips.className = 'settings-list-items';

            unidad.variantes.forEach((variante, indiceVariante) => {
                const editando = varianteEnEdicion
                    && varianteEnEdicion.unidad === indice
                    && varianteEnEdicion.variante === indiceVariante;

                const chip = document.createElement('div');
                chip.className = 'settings-list-item';

                if (editando) {
                    const inputVariante = document.createElement('input');
                    inputVariante.type = 'text';
                    inputVariante.className = 'settings-input settings-list-edit-input';
                    inputVariante.value = variante;
                    inputVariante.setAttribute('aria-label', 'Editar variante de unidad');

                    const confirmar = () => {
                        const valor = normalizarValorLista(inputVariante.value);

                        if (!valor) {
                            mostrarError('La variante no puede quedar vacía.');
                            inputVariante.focus();
                            return;
                        }

                        const dueno = unidadQueUsa(valor, {
                            unidad: indice,
                            variante: indiceVariante
                        });
                        if (dueno) {
                            mostrarError(`"${valor}" ya está en uso por "${dueno.estandar}".`);
                            inputVariante.focus();
                            return;
                        }

                        unidades[indice].variantes[indiceVariante] = valor;
                        varianteEnEdicion = null;
                        mostrarError('');
                        render();
                    };

                    const cancelar = () => {
                        varianteEnEdicion = null;
                        mostrarError('');
                        render();
                    };

                    inputVariante.addEventListener('keydown', (evento) => {
                        if (evento.key === 'Enter') {
                            evento.preventDefault();
                            evento.stopPropagation();
                            confirmar();
                        } else if (evento.key === 'Escape') {
                            evento.preventDefault();
                            evento.stopPropagation();
                            cancelar();
                        }
                    });

                    chip.append(
                        inputVariante,
                        crearBotonLista('Guardar', 'settings-list-btn settings-list-btn-ok', confirmar),
                        crearBotonLista('Cancelar', 'settings-list-btn', cancelar)
                    );
                    queueMicrotask(() => inputVariante.focus());
                } else {
                    const texto = document.createElement('span');
                    texto.className = 'settings-list-value';
                    texto.textContent = variante;
                    texto.title = variante;

                    chip.append(
                        texto,
                        crearBotonLista('Editar', 'settings-list-btn', () => {
                            varianteEnEdicion = { unidad: indice, variante: indiceVariante };
                            mostrarError('');
                            render();
                        }),
                        crearBotonLista('Eliminar', 'settings-list-btn settings-list-btn-danger', () => {
                            unidades[indice].variantes.splice(indiceVariante, 1);
                            varianteEnEdicion = null;
                            mostrarError('');
                            render();
                        })
                    );
                }

                chips.appendChild(chip);
            });

            const agregarVarianteEl = document.createElement('div');
            agregarVarianteEl.className = 'settings-list-add';

            const inputVarianteNueva = document.createElement('input');
            inputVarianteNueva.type = 'text';
            inputVarianteNueva.className = 'settings-input';
            inputVarianteNueva.placeholder = 'Nueva variante (ej. LT)';
            inputVarianteNueva.setAttribute('aria-label', `Nueva variante para ${unidad.estandar}`);

            const btnAgregarVariante = crearBotonLista(
                'Agregar',
                'settings-list-add-btn',
                () => {
                    const valor = normalizarValorLista(inputVarianteNueva.value);

                    if (!valor) {
                        mostrarError('Escribe una variante antes de agregarla.');
                        inputVarianteNueva.focus();
                        return;
                    }

                    const dueno = unidadQueUsa(valor);
                    if (dueno) {
                        mostrarError(`"${valor}" ya está en uso por "${dueno.estandar}".`);
                        inputVarianteNueva.focus();
                        return;
                    }

                    unidades[indice].variantes.push(valor);
                    inputVarianteNueva.value = '';
                    mostrarError('');
                    render();
                }
            );

            inputVarianteNueva.addEventListener('keydown', (evento) => {
                if (evento.key !== 'Enter') return;
                evento.preventDefault();
                evento.stopPropagation();
                btnAgregarVariante.click();
            });

            agregarVarianteEl.append(inputVarianteNueva, btnAgregarVariante);
            variantesEl.append(chips, agregarVarianteEl);

            fila.append(concepto, variantesEl);
            filasEl.appendChild(fila);
        });

        sincronizar();
    };

    const agregarUnidad = () => {
        const valor = normalizarValorLista(inputEstandarNuevo.value);

        if (!valor) {
            mostrarError('Escribe la unidad estándar.');
            inputEstandarNuevo.focus();
            return;
        }

        const dueno = unidadQueUsa(valor);
        if (dueno) {
            mostrarError(`"${valor}" ya está en uso por "${dueno.estandar}".`);
            inputEstandarNuevo.focus();
            return;
        }

        unidades.push({ estandar: valor, variantes: [] });
        inputEstandarNuevo.value = '';
        mostrarError('');
        render();
    };

    inputEstandarNuevo.addEventListener('keydown', (evento) => {
        if (evento.key !== 'Enter') return;
        evento.preventDefault();
        evento.stopPropagation();
        agregarUnidad();
    });

    const restaurar = () => {
        unidades = normalizarUnidadesMapeo(valoresPorDefecto);
        estandarEnEdicion = null;
        varianteEnEdicion = null;
        mostrarError('');
        render();
    };

    campo.append(cabecera, oculto, tabla, filaAgregar, error);

    if (pista) {
        const ayuda = document.createElement('span');
        ayuda.className = 'settings-hint';
        ayuda.textContent = pista;
        campo.appendChild(ayuda);
    }

    editoresUnidadesAjustes.set(id, {
        establecer: (nuevos) => {
            unidades = normalizarUnidadesMapeo(nuevos);
            estandarEnEdicion = null;
            varianteEnEdicion = null;
            mostrarError('');
            render();
        },
        restaurar
    });

    render();
    return campo;
}

function valorListaDesdeModal(id) {
    const input = document.getElementById(id);
    if (!input) return [];

    try {
        const valor = JSON.parse(input.value);
        return Array.isArray(valor) ? valor : [];
    } catch (error) {
        console.error(`Lista de ajustes ilegible (${id}):`, error);
        return [];
    }
}

function valorUnidadesDesdeModal(id) {
    const input = document.getElementById(id);
    if (!input) return [];

    try {
        const valor = JSON.parse(input.value);
        return Array.isArray(valor) ? valor : [];
    } catch (error) {
        console.error(`Tabla de unidades ilegible (${id}):`, error);
        return [];
    }
}

// Lee los controles generales del modal (General y Exportación) y los
// normaliza antes de persistirlos.
function leerAjustesDesdeModal() {
    const columnas = {};

    COLUMNAS_AJUSTES_EXPORTACION.forEach(columna => {
        const check = document.getElementById(`ajusteColumna-${columna.id}`);
        columnas[columna.id] = Boolean(check && check.checked);
    });

    return normalizarAjustes({
        delayAutoprocesadoMs: document.getElementById('ajusteDelayMs')?.value,
        tema: document.getElementById('ajusteTema')?.checked ? 'oscuro' : 'claro',
        formatoNumeros: document.getElementById('ajusteFormatoNumeros')?.value,
        incluirColoresExportacion: document.getElementById('ajusteIncluirColores')?.checked,
        columnasExportacion: COLUMNAS_AJUSTES_EXPORTACION
            .filter(columna => columnas[columna.id])
            .map(columna => columna.id),
        ingredientesNoEncontrados: document.getElementById('ajusteIngredientesNoEncontrados')?.value
    });
}

// Lee exclusivamente los controles de la pestaña "Mapeo de Insumos".
function leerMapeoDesdeModal() {
    return normalizarMapeoInsumos({
        sinonimosIngrediente: valorListaDesdeModal('mapeoSinonimosIngrediente'),
        sinonimosUnidad: valorListaDesdeModal('mapeoSinonimosUnidad'),
        sinonimosCantidad: valorListaDesdeModal('mapeoSinonimosCantidad'),
        sinonimosTotal: valorListaDesdeModal('mapeoSinonimosTotal'),
        palabrasFilaIgnorada: valorListaDesdeModal('mapeoPalabrasFilaIgnorada'),
        unidades: valorUnidadesDesdeModal('mapeoUnidades'),
        filasCabeceraIgnoradas: document.getElementById('mapeoFilasCabecera')?.value,
        filasEscaneoCabecera: document.getElementById('mapeoFilasEscaneo')?.value
    });
}

// Vuelca el estado general en los controles ya dibujados (se usa al restablecer).
function volcarAjustesEnModal() {
    const asignarValor = (id, valor) => {
        const control = document.getElementById(id);
        if (control) control.value = valor;
    };

    const asignarCheck = (id, valor) => {
        const control = document.getElementById(id);
        if (!control) return;

        control.checked = Boolean(valor);
        if (control.getAttribute('role') === 'switch') {
            control.setAttribute('aria-checked', String(Boolean(valor)));
        }
    };

    asignarValor('ajusteDelayMs', String(ajustesProcesamiento.delayAutoprocesadoMs));
    asignarCheck('ajusteTema', ajustesProcesamiento.tema === 'oscuro');
    asignarValor('ajusteFormatoNumeros', ajustesProcesamiento.formatoNumeros);
    asignarCheck('ajusteVistaCompacta', vistaCompactaGuardada);
    asignarCheck('ajusteVistaCompactaGrupos', vistaCompactaGruposGuardada);
    asignarValor('ajusteGruposPorPagina', String(gruposPorPaginaGuardado));
    asignarCheck('ajusteIncluirColores', ajustesProcesamiento.incluirColoresExportacion);
    asignarValor(
        'ajusteIngredientesNoEncontrados',
        ajustesProcesamiento.ingredientesNoEncontrados
    );

    COLUMNAS_AJUSTES_EXPORTACION.forEach(columna => {
        asignarCheck(
            `ajusteColumna-${columna.id}`,
            ajustesProcesamiento.columnasExportacion.includes(columna.id)
        );
    });
}

// Vuelca el estado del mapeo en la pestaña "Mapeo de Insumos".
function volcarMapeoEnModal() {
    const asignarValor = (id, valor) => {
        const control = document.getElementById(id);
        if (control) control.value = valor;
    };

    const asignarLista = (id, valores) => {
        const editor = editoresListaAjustes.get(id);
        if (editor) editor.establecer(valores);
        else asignarValor(id, JSON.stringify(valores));
    };

    const asignarUnidades = (id, valores) => {
        const editor = editoresUnidadesAjustes.get(id);
        if (editor) editor.establecer(valores);
        else asignarValor(id, JSON.stringify(valores));
    };

    asignarLista('mapeoSinonimosIngrediente', mapeoInsumos.sinonimosIngrediente);
    asignarLista('mapeoSinonimosUnidad', mapeoInsumos.sinonimosUnidad);
    asignarLista('mapeoSinonimosCantidad', mapeoInsumos.sinonimosCantidad);
    asignarLista('mapeoSinonimosTotal', mapeoInsumos.sinonimosTotal);
    asignarLista('mapeoPalabrasFilaIgnorada', mapeoInsumos.palabrasFilaIgnorada);
    asignarUnidades('mapeoUnidades', mapeoInsumos.unidades);
    asignarValor('mapeoFilasCabecera', String(mapeoInsumos.filasCabeceraIgnoradas));
    asignarValor('mapeoFilasEscaneo', String(mapeoInsumos.filasEscaneoCabecera));
}

// Barra de pestañas + paneles. Se ocultan por clase porque el overlay usa
// display:flex y el atributo `hidden` quedaría anulado por el CSS.
function crearPestanasAjustes(pestanas) {
    const contenedor = document.createElement('div');
    contenedor.className = 'settings-tabs';

    const barra = document.createElement('div');
    barra.className = 'settings-tabbar';
    barra.setAttribute('role', 'tablist');
    barra.setAttribute('aria-label', 'Secciones de ajustes');

    const cuerpo = document.createElement('div');
    cuerpo.className = 'settings-tabpanels';

    const botones = new Map();
    const paneles = new Map();

    const activar = (id) => {
        botones.forEach((boton, botonId) => {
            const activo = botonId === id;
            boton.classList.toggle('active', activo);
            boton.setAttribute('aria-selected', activo ? 'true' : 'false');
            boton.tabIndex = activo ? 0 : -1;
        });

        paneles.forEach((panel, panelId) => {
            panel.classList.toggle('active', panelId === id);
        });
    };

    pestanas.forEach((pestana, indice) => {
        const boton = document.createElement('button');
        boton.type = 'button';
        boton.className = 'settings-tab';
        boton.id = `settingsTab-${pestana.id}`;
        boton.setAttribute('role', 'tab');
        boton.setAttribute('aria-controls', `settingsPanel-${pestana.id}`);
        boton.textContent = pestana.etiqueta;

        boton.addEventListener('click', () => activar(pestana.id));

        // Navegación con flechas, como una tablist nativa.
        boton.addEventListener('keydown', (evento) => {
            if (evento.key !== 'ArrowRight' && evento.key !== 'ArrowLeft') return;

            evento.preventDefault();
            const paso = evento.key === 'ArrowRight' ? 1 : -1;
            const destino = (indice + paso + pestanas.length) % pestanas.length;

            activar(pestanas[destino].id);
            botones.get(pestanas[destino].id)?.focus();
        });

        botones.set(pestana.id, boton);
        barra.appendChild(boton);
    });

    pestanas.forEach(pestana => {
        const panel = document.createElement('div');
        panel.className = 'settings-panel';
        panel.id = `settingsPanel-${pestana.id}`;
        panel.setAttribute('role', 'tabpanel');
        panel.setAttribute('aria-labelledby', `settingsTab-${pestana.id}`);
        panel.append(...pestana.contenido);

        paneles.set(pestana.id, panel);
        cuerpo.appendChild(panel);
    });

    contenedor.append(barra, cuerpo);

    if (pestanas.length > 0) activar(pestanas[0].id);
    return contenedor;
}

async function abrirCarpetaDatosDesdeModal() {
    try {
        await invoke('abrir_carpeta_datos');
    } catch (error) {
        console.error('No se pudo abrir la carpeta de datos:', error);
        await window.__TAURI__.dialog.message(
            'No se pudo abrir la carpeta de datos: ' + error,
            { title: 'Error', kind: 'error' }
        );
    }
}

async function restablecerAjustesDesdeModal() {
    const confirmar = await window.__TAURI__.dialog.ask(
        'Se restablecerán todos los ajustes a sus valores por defecto. ¿Continuar?',
        {
            title: 'Restablecer ajustes',
            kind: 'warning',
            okLabel: 'Restablecer',
            cancelLabel: 'Cancelar'
        }
    );

    if (!confirmar) return;

    const ajustesPorDefecto = normalizarAjustes(AJUSTES_POR_DEFECTO);
    const mapeoPorDefecto = normalizarMapeoInsumos(MAPEO_POR_DEFECTO);

    try {
        await Promise.all([
            invoke('guardar_ajustes_procesamiento', { ajustes: ajustesPorDefecto }),
            invoke('guardar_mapeo_insumos', { mapeo: mapeoPorDefecto }),
            invoke('guardar_vista_compacta', { activa: false }),
            invoke('guardar_vista_compacta_grupos', { activa: false }),
            invoke('guardar_grupos_por_pagina', { cantidad: GRUPOS_POR_PAGINA_POR_DEFECTO })
        ]);

        ajustesProcesamiento = ajustesPorDefecto;
        mapeoInsumos = mapeoPorDefecto;
        vistaCompactaGuardada = false;
        vistaCompactaGruposGuardada = false;
        gruposPorPaginaGuardado = GRUPOS_POR_PAGINA_POR_DEFECTO;
        volcarAjustesEnModal();
        volcarMapeoEnModal();

        // El tema, el formato y la vista compacta vuelven con el resto.
        formatoNumerosVista = null;
        aplicarTema(ajustesProcesamiento.tema);
        reformatearCantidadesTabla();
        aplicarVistaCompacta(false);
        aplicarVistaCompactaGrupos(false);
        aplicarGruposPorPagina(GRUPOS_POR_PAGINA_POR_DEFECTO);

        await window.__TAURI__.dialog.message(
            'Los ajustes generales y el mapeo de insumos volvieron a sus valores por defecto.',
            { title: 'Ajustes restablecidos', kind: 'info' }
        );
    } catch (error) {
        console.error('No se pudieron restablecer los ajustes:', error);
        await window.__TAURI__.dialog.message(
            'No se pudieron restablecer los ajustes: ' + error,
            { title: 'Error', kind: 'error' }
        );
    }
}

async function guardarAjustesDesdeModal() {
    const guardarBtn = document.getElementById('btnGuardarAjustes');
    const nuevosAjustes = leerAjustesDesdeModal();
    const nuevoMapeo = leerMapeoDesdeModal();
    const nuevaVistaCompacta = Boolean(
        document.getElementById('ajusteVistaCompacta')?.checked
    );
    const nuevaVistaCompactaGrupos = Boolean(
        document.getElementById('ajusteVistaCompactaGrupos')?.checked
    );
    const nuevosGruposPorPagina = normalizarGruposPorPagina(
        document.getElementById('ajusteGruposPorPagina')?.value
    );

    // Validación en la interfaz con el mismo criterio que el backend, para no
    // guardar un mapeo que luego rompa la lectura de los Excel.
    const faltantes = faltantesMapeoInsumos(nuevoMapeo);
    if (faltantes.length > 0) {
        await window.__TAURI__.dialog.message(
            'No se puede guardar el Mapeo de Insumos porque falta configuración obligatoria:\n\n- '
                + faltantes.join('\n- ')
                + '\n\nAgrega al menos un valor en cada lista.',
            { title: 'Revisa el Mapeo de Insumos', kind: 'warning' }
        );
        return;
    }

    if (guardarBtn) guardarBtn.disabled = true;

    try {
        // Cada configuración se persiste en su propia clave de config.json.
        await Promise.all([
            invoke('guardar_ajustes_procesamiento', { ajustes: nuevosAjustes }),
            invoke('guardar_mapeo_insumos', { mapeo: nuevoMapeo }),
            invoke('guardar_vista_compacta', { activa: nuevaVistaCompacta }),
            invoke('guardar_vista_compacta_grupos', { activa: nuevaVistaCompactaGrupos }),
            invoke('guardar_grupos_por_pagina', { cantidad: nuevosGruposPorPagina })
        ]);

        ajustesProcesamiento = nuevosAjustes;
        mapeoInsumos = nuevoMapeo;
        vistaCompactaGuardada = nuevaVistaCompacta;
        vistaCompactaGruposGuardada = nuevaVistaCompactaGrupos;
        gruposPorPaginaGuardado = nuevosGruposPorPagina;

        // Lo previsualizado pasa a ser el estado persistido.
        formatoNumerosVista = null;
        aplicarTema(ajustesProcesamiento.tema);
        reformatearCantidadesTabla();
        aplicarVistaCompacta(vistaCompactaGuardada);

        cerrarAjustesProcesamiento();

        // Las reglas nuevas se aplican de inmediato a lo ya seleccionado.
        if (document.querySelector('.chk-sheet:checked')) {
            solicitarProcesamientoHojas({ inmediato: true, silencioso: true });
        }
    } catch (error) {
        console.error('No se pudieron guardar los ajustes o el mapeo:', error);
        if (guardarBtn) guardarBtn.disabled = false;

        await window.__TAURI__.dialog.message(
            'No se pudieron guardar los ajustes: ' + error,
            { title: 'Error', kind: 'error' }
        );
    }
}

async function abrirAjustesProcesamiento() {
    if (document.getElementById('modalAjustesProcesamiento')) return;

    cerrarMenuContextual();
    cerrarResumenColores();

    // Espera la carga inicial para mostrar los valores persistidos.
    try {
        await Promise.all([
            ajustesCargadosPromise || Promise.resolve(),
            vistaCompactaCargadaPromise || Promise.resolve(),
            gruposVistaCargadaPromise || Promise.resolve()
        ]);
    } catch (error) {
        console.error('No se pudieron cargar los ajustes antes de abrir el modal:', error);
    }

    if (document.getElementById('modalAjustesProcesamiento')) return;

    const overlay = document.createElement('div');
    overlay.className = 'colors-modal-overlay';
    overlay.id = 'modalAjustesProcesamiento';

    // El cierre por clic fuera solo se dispara si el gesto empezó y terminó
    // sobre el fondo. Así, seleccionar texto dentro de un input y soltar el
    // mouse fuera del modal ya no lo cierra.
    let clicIniciadoEnFondo = false;
    overlay.addEventListener('mousedown', (evento) => {
        clicIniciadoEnFondo = evento.target === overlay;
    });
    overlay.addEventListener('mouseup', (evento) => {
        const cerrar = clicIniciadoEnFondo && evento.target === overlay;
        clicIniciadoEnFondo = false;
        if (cerrar) cerrarAjustesProcesamiento();
    });
    overlay.addEventListener('mouseleave', () => {
        clicIniciadoEnFondo = false;
    });

    const modal = document.createElement('div');
    modal.className = 'colors-modal settings-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'ajustesTitulo');

    // Cabecera
    const header = document.createElement('div');
    header.className = 'colors-modal-header';

    const titulo = document.createElement('div');
    titulo.className = 'colors-modal-title';
    titulo.id = 'ajustesTitulo';
    titulo.textContent = 'Ajustes';

    const subtitulo = document.createElement('span');
    subtitulo.className = 'colors-modal-subtitle';
    subtitulo.textContent = 'Configuración general de la aplicación';
    titulo.appendChild(subtitulo);

    const cerrarBtn = document.createElement('button');
    cerrarBtn.type = 'button';
    cerrarBtn.className = 'colors-modal-close';
    cerrarBtn.title = 'Cerrar';
    cerrarBtn.setAttribute('aria-label', 'Cerrar ajustes');
    cerrarBtn.innerHTML = '<svg class="icon icon-sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg>';
    cerrarBtn.addEventListener('click', cerrarAjustesProcesamiento);

    header.append(titulo, cerrarBtn);

    // --- Pestaña "General" (procesamiento + apariencia + datos) ---
    const gridGeneral = document.createElement('div');
    gridGeneral.className = 'settings-grid';
    gridGeneral.append(
        crearCampoAjuste({
            id: 'ajusteDelayMs',
            etiqueta: 'Delay de autoprocesado (ms)',
            tipo: 'number',
            valor: String(ajustesProcesamiento.delayAutoprocesadoMs),
            min: 0,
            step: 100,
            pista: 'Espera antes de procesar automáticamente. Ej: 500.'
        }),
        crearSelectAjuste({
            id: 'ajusteFormatoNumeros',
            etiqueta: 'Formato de números',
            valor: ajustesProcesamiento.formatoNumeros,
            opciones: FORMATOS_NUMEROS_AJUSTES,
            pista: 'Solo cambia cómo se ven las cantidades: los cálculos y el Excel siguen usando punto decimal.',
            onChange: (valor) => {
                formatoNumerosVista = valor;
                reformatearCantidadesTabla();
            }
        })
    );

    // Apariencia: interruptores lado a lado (el tercero hace wrap).
    const gridApariencia = document.createElement('div');
    gridApariencia.className = 'settings-grid';
    gridApariencia.append(
        crearToggleAjuste({
            id: 'ajusteTema',
            etiqueta: 'Tema',
            marcado: ajustesProcesamiento.tema === 'oscuro',
            texto: 'Modo Oscuro',
            pista: 'Cambia la apariencia general de la aplicación.',
            // Previsualización inmediata; al cerrar sin guardar se revierte.
            onChange: (oscuro) => aplicarTema(oscuro ? 'oscuro' : 'claro')
        }),
        crearToggleAjuste({
            id: 'ajusteVistaCompacta',
            etiqueta: 'Vista compacta de archivos',
            marcado: vistaCompactaActiva,
            texto: 'Activada',
            pista: 'Muestra la lista de archivos en una sola línea, con el nombre truncado.',
            // Previsualización inmediata; al cerrar sin guardar se revierte.
            onChange: (marcado) => aplicarVistaCompacta(marcado)
        }),
        crearToggleAjuste({
            id: 'ajusteVistaCompactaGrupos',
            etiqueta: 'Vista compacta de grupos',
            marcado: vistaCompactaGruposActiva,
            texto: 'Activada',
            pista: 'Muestra cada grupo en una sola línea, con el nombre truncado. Pasa el mouse por encima para verlo completo.',
            // Previsualización inmediata; al cerrar sin guardar se revierte.
            onChange: (marcado) => aplicarVistaCompactaGrupos(marcado)
        })
    );

    // Paginación de la lista de grupos. Se ofrece un select porque los tamaños
    // útiles son pocos y así se evita validar números escritos a mano.
    const opcionesGruposPorPagina = GRUPOS_POR_PAGINA_OPCIONES.map(cantidad => ({
        valor: String(cantidad),
        texto: String(cantidad)
    }));

    // Si el store trae un valor fuera de la lista (editado a mano, versión
    // anterior), se añade para no mostrarle al usuario una cantidad distinta
    // de la que realmente usa la lista.
    if (!GRUPOS_POR_PAGINA_OPCIONES.includes(gruposPorPaginaActivo)) {
        opcionesGruposPorPagina.push({
            valor: String(gruposPorPaginaActivo),
            texto: String(gruposPorPaginaActivo)
        });
        opcionesGruposPorPagina.sort((a, b) => Number(a.valor) - Number(b.valor));
    }

    const gridPaginacion = document.createElement('div');
    gridPaginacion.className = 'settings-grid';
    gridPaginacion.append(
        crearSelectAjuste({
            id: 'ajusteGruposPorPagina',
            etiqueta: 'Elementos por página en grupos',
            valor: String(gruposPorPaginaActivo),
            opciones: opcionesGruposPorPagina,
            pista: 'Si hay más grupos que este límite, la lista muestra botones para pasar de página.',
            // Previsualización inmediata; al cerrar sin guardar se revierte.
            onChange: (valor) => aplicarGruposPorPagina(valor)
        })
    );

    const notaGeneral = document.createElement('p');
    notaGeneral.className = 'settings-note';
    notaGeneral.textContent = 'Las reglas de columnas, filtros, cabeceras y unidades están en la pestaña "Mapeo de Insumos".';

    // --- Pestaña "Mapeo de Insumos" ---
    const notaMapeo = document.createElement('p');
    notaMapeo.className = 'settings-note';
    notaMapeo.textContent = 'Estas reglas son las que usa el lector de Excel: definen qué columnas se reconocen, qué filas se descartan y cómo se normalizan los nombres y las unidades de los insumos.';

    const seccionColumnasMapeo = crearTablaParesAjustes(
        'Sinónimos de columnas',
        [
            {
                concepto: 'Ingrediente',
                id: 'mapeoSinonimosIngrediente',
                valores: mapeoInsumos.sinonimosIngrediente,
                valoresPorDefecto: MAPEO_POR_DEFECTO.sinonimosIngrediente,
                placeholder: 'ej. producto',
                pista: 'La columna se reconoce si la cabecera contiene alguno de estos valores.',
                requerida: true
            },
            {
                concepto: 'Unidad',
                id: 'mapeoSinonimosUnidad',
                valores: mapeoInsumos.sinonimosUnidad,
                valoresPorDefecto: MAPEO_POR_DEFECTO.sinonimosUnidad,
                placeholder: 'ej. medida',
                pista: 'Sinónimos aceptados para la columna de unidad de medida.',
                requerida: true
            },
            {
                concepto: 'Cantidad',
                id: 'mapeoSinonimosCantidad',
                valores: mapeoInsumos.sinonimosCantidad,
                valoresPorDefecto: MAPEO_POR_DEFECTO.sinonimosCantidad,
                placeholder: 'ej. cant. / peso / q',
                pista: 'Única lista de cantidad: acepta nombres, prefijos y abreviaturas de la columna.'
            },
            {
                concepto: 'Total',
                id: 'mapeoSinonimosTotal',
                valores: mapeoInsumos.sinonimosTotal,
                valoresPorDefecto: MAPEO_POR_DEFECTO.sinonimosTotal,
                placeholder: 'ej. total final',
                pista: 'Columna autoritativa de cantidad total; se compara por igualdad exacta.'
            }
        ]
    );

    const seccionFiltrosMapeo = crearTablaParesAjustes(
        'Filtros de lectura',
        [
            {
                concepto: 'Palabras que descartan filas',
                id: 'mapeoPalabrasFilaIgnorada',
                valores: mapeoInsumos.palabrasFilaIgnorada,
                valoresPorDefecto: MAPEO_POR_DEFECTO.palabrasFilaIgnorada,
                placeholder: 'ej. nota',
                pista: 'Filas cuyo nombre contenga estas palabras se omiten (cabeceras repetidas).'
            }
        ]
    );

    const seccionUnidadesMapeo = seccionAjustes(
        'Unificación de unidades de medida',
        crearEditorUnidadesAjuste({
            id: 'mapeoUnidades',
            valores: mapeoInsumos.unidades,
            valoresPorDefecto: MAPEO_POR_DEFECTO.unidades,
            pista: 'Cada variante se reemplaza por su unidad estándar antes de consolidar. Solo unifica escrituras: no convierte gramos en kilos.'
        })
    );

    const gridLecturaMapeo = document.createElement('div');
    gridLecturaMapeo.className = 'settings-grid';
    gridLecturaMapeo.append(
        crearCampoAjuste({
            id: 'mapeoFilasCabecera',
            etiqueta: 'Ignorar las primeras N filas',
            tipo: 'number',
            valor: String(mapeoInsumos.filasCabeceraIgnoradas),
            min: 0,
            step: 1,
            pista: 'Filas que se saltean antes de buscar la cabecera.'
        }),
        crearCampoAjuste({
            id: 'mapeoFilasEscaneo',
            etiqueta: 'Filas a examinar buscando la cabecera',
            tipo: 'number',
            valor: String(mapeoInsumos.filasEscaneoCabecera),
            min: 1,
            step: 1,
            pista: 'Cuántas filas se revisan desde el inicio (por defecto 15).'
        })
    );

    const seccionLecturaMapeo = seccionAjustes(
        'Lectura de la cabecera',
        gridLecturaMapeo
    );

    // --- Pestaña "Exportación" ---
    const gridColumnas = document.createElement('div');
    gridColumnas.className = 'settings-check-grid';

    COLUMNAS_AJUSTES_EXPORTACION.forEach(columna => {
        gridColumnas.appendChild(crearCheckboxAjuste({
            id: `ajusteColumna-${columna.id}`,
            etiqueta: columna.etiqueta,
            marcado: ajustesProcesamiento.columnasExportacion.includes(columna.id)
        }));
    });

    const seccionColumnas = seccionAjustes(
        'Columnas a exportar',
        gridColumnas
    );

    // --- Pestaña "Sistema" (ahora dentro de General) ---
    const seccionIngredientes = seccionAjustes(
        'Ingredientes no encontrados',
        crearSelectAjuste({
            id: 'ajusteIngredientesNoEncontrados',
            etiqueta: 'Cuando un ingrediente no está en el diccionario',
            valor: ajustesProcesamiento.ingredientesNoEncontrados,
            opciones: INGREDIENTES_NO_ENCONTRADOS_AJUSTES,
            pista: 'Define cómo se resuelve un ingrediente sin coincidencia.'
        })
    );

    const accionesSistema = document.createElement('div');
    accionesSistema.className = 'settings-system-actions';

    const btnCarpetaDatos = document.createElement('button');
    btnCarpetaDatos.type = 'button';
    btnCarpetaDatos.className = 'settings-cancel';
    btnCarpetaDatos.textContent = 'Abrir carpeta de datos';
    btnCarpetaDatos.title = 'Abre en el explorador la carpeta donde se guardan los datos de la aplicación';
    btnCarpetaDatos.addEventListener('click', abrirCarpetaDatosDesdeModal);

    const btnRestablecer = document.createElement('button');
    btnRestablecer.type = 'button';
    btnRestablecer.className = 'settings-danger';
    btnRestablecer.textContent = 'Restablecer todo';
    btnRestablecer.title = 'Vuelve todos los ajustes a sus valores por defecto';
    btnRestablecer.addEventListener('click', restablecerAjustesDesdeModal);

    accionesSistema.append(btnCarpetaDatos, btnRestablecer);

    const seccionDatos = seccionAjustes(
        'Datos de la aplicación',
        accionesSistema
    );

    // Cuerpo: aviso global + pestañas con scroll interno propio.
    const body = document.createElement('div');
    body.className = 'settings-body';

    const aviso = document.createElement('p');
    aviso.className = 'settings-note';
    aviso.textContent = 'Los ajustes generales y el mapeo de insumos se guardan de forma independiente.';

    const pestanas = crearPestanasAjustes([
        {
            id: 'general',
            etiqueta: 'General',
            contenido: [gridGeneral, gridApariencia, gridPaginacion, seccionIngredientes, seccionDatos, notaGeneral]
        },
        {
            id: 'mapeo',
            etiqueta: 'Mapeo de Insumos',
            contenido: [
                notaMapeo,
                seccionColumnasMapeo,
                seccionFiltrosMapeo,
                seccionUnidadesMapeo,
                seccionLecturaMapeo
            ]
        },
        {
            id: 'exportacion',
            etiqueta: 'Exportación',
            contenido: [
                crearCheckboxAjuste({
                    id: 'ajusteIncluirColores',
                    etiqueta: 'Incluir colores en exportación',
                    marcado: ajustesProcesamiento.incluirColoresExportacion,
                    pista: 'Mantiene el color de cada fila en el Excel y en el PDF.'
                }),
                seccionColumnas
            ]
        }
    ]);

    body.append(aviso, pestanas);

    // Pie con la pista de persistencia y las acciones
    const footer = document.createElement('div');
    footer.className = 'link-modal-footer';

    const pista = document.createElement('span');
    pista.className = 'link-modal-hint';
    pista.textContent = 'Los cambios se guardarán al confirmar.';

    const acciones = document.createElement('div');
    acciones.className = 'settings-actions';

    const cancelar = document.createElement('button');
    cancelar.type = 'button';
    cancelar.className = 'settings-cancel';
    cancelar.textContent = 'Cancelar';
    cancelar.addEventListener('click', cerrarAjustesProcesamiento);

    const guardar = document.createElement('button');
    guardar.type = 'button';
    guardar.className = 'settings-save';
    guardar.id = 'btnGuardarAjustes';
    guardar.textContent = 'Guardar';
    guardar.addEventListener('click', guardarAjustesDesdeModal);

    acciones.append(cancelar, guardar);
    footer.append(pista, acciones);

    // Enter en cualquiera de los campos también guarda.
    modal.addEventListener('keydown', (evento) => {
        if (evento.key !== 'Enter' || !(evento.target instanceof HTMLInputElement)) return;
        evento.preventDefault();
        guardarAjustesDesdeModal();
    });

    modal.append(header, body, footer);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    document.addEventListener('keydown', cerrarAjustesPorEscape);
    cerrarBtn.focus();
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
                    <span class="file-name">${nombreArchivo}</span>
                    <svg class="icon chevron" viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M6 9l6 6 6-6"/>
                    </svg>
                </summary>
                <ul class="sheets-list">
                    <li class="loading-text">Cargando hojas...</li>
                </ul>
            `;

            detalles.dataset.ruta = archivo.ruta;

            // Nombre completo en el tooltip: en vista compacta el texto se
            // trunca con "…" y en la normal puede quedar partido en varias
            // líneas. Se asigna como propiedad (no interpolado en el HTML)
            // para que un nombre con comillas o "<" no rompa el marcado.
            const nombreElemento = detalles.querySelector('.file-name');
            if (nombreElemento) nombreElemento.title = nombreArchivo;

            // Menú de contexto (click derecho) para las opciones del archivo
            detalles.addEventListener('contextmenu', (evento) => {
                evento.preventDefault();
                evento.stopPropagation();

                const ruta = detalles.dataset.ruta;
                const gruposVinculados = Array.from(gruposDeArchivo(ruta))
                    .sort((a, b) => a.localeCompare(b, 'es'));

                abrirMenuContextual(evento.clientX, evento.clientY, [
                    {
                        label: 'Desvincular grupo',
                        icon: '<svg class="icon icon-sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
                        // Sin vinculaciones el ítem se muestra, pero deshabilitado
                        disabled: gruposVinculados.length === 0,
                        title: gruposVinculados.length === 0
                            ? 'Este archivo no tiene grupos vinculados'
                            : 'Quitar la vinculación con uno de sus grupos',
                        submenu: gruposVinculados.map(nombreGrupo => ({
                            label: nombreGrupo,
                            onClick: () => desvincularArchivoDeGrupo(ruta, nombreGrupo)
                        }))
                    },
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

                                // Si se desmarca, se utiliza la función debounced de desmarcado;
                                // si se marca, se mantiene la lógica de añadir hojas.
                                if (!chkSheet.checked) {
                                    desmarcarHoja();
                                } else {
                                    solicitarProcesamientoPorSeleccion();
                                }
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

                // Al DESMARCAR un archivo que nunca se abrió no hace falta leer
                // el Excel para desmarcar hojas que ni siquiera existen en el
                // DOM: esa lectura era la que bloqueaba ~1 s por archivo.
                // Solo al marcar se necesitan las hojas para poder tildarlas.
                if (!hojasCargadas && !isChecked) {
                    chkFile.indeterminate = false;
                    desmarcarHoja();
                    return;
                }

                // Si el acordeón nunca se abrió, las hojas aún no existen:
                // cargarlas antes de tildarlas.
                if (!hojasCargadas) {
                    await cargarHojas();
                }

                const chkHojas = detalles.querySelectorAll('.chk-sheet');
                chkHojas.forEach(chk => {
                    chk.checked = isChecked;
                });

                chkFile.indeterminate = false;

                // Al desmarcar el lote completo se usa desmarcarHoja (debounced);
                // al marcarlo se mantiene la selección habitual.
                if (!isChecked) {
                    desmarcarHoja();
                } else {
                    solicitarProcesamientoPorSeleccion();
                }
            });

            detalles.addEventListener('toggle', async () => {
                if (detalles.open && !hojasCargadas) {
                    await cargarHojas();
                }
            });

            fileList.appendChild(detalles);
        });

        // Refresca los tags de grupos cuando la lista se vuelve a pintar
        aplicarTagsVinculacion();
        actualizarBotonEliminarSeleccionados();
    } catch (error) {
        console.error("Error al cargar archivos recientes:", error);
    }
}

// --- VINCULACIÓN ARCHIVOS ↔ GRUPOS (N a N) ---
// Estructura en memoria: Map<ruta_absoluta, Set<nombre_grupo>>.
// El nombre del grupo se usa como id natural porque grupos.json los indexa
// como "grupo_{nombre}" y no existe un id numérico estable.
const vinculacionesArchivosGrupos = new Map();

// Promesa de la carga inicial y cola de escrituras (igual que los colores)
let vinculacionesCargadasPromise = null;
let persistenciaVinculacionesCola = Promise.resolve();

function gruposDeArchivo(ruta) {
    return vinculacionesArchivosGrupos.get(ruta) || new Set();
}

async function cargarVinculaciones() {
    try {
        const guardadas = await invoke('obtener_vinculaciones');
        vinculacionesArchivosGrupos.clear();

        Object.entries(guardadas || {}).forEach(([ruta, grupos]) => {
            if (!ruta || !Array.isArray(grupos)) return;

            const limpios = grupos.filter(nombre =>
                typeof nombre === 'string' && nombre.trim() !== ''
            );

            // Solo se conservan archivos con al menos un grupo vinculado
            if (limpios.length > 0) {
                vinculacionesArchivosGrupos.set(ruta, new Set(limpios));
            }
        });

        console.log(
            `[vinculaciones] Cargadas ${vinculacionesArchivosGrupos.size} ` +
            `vinculación(es) archivo-grupo.`
        );
    } catch (error) {
        console.error('No se pudieron cargar las vinculaciones:', error);
    } finally {
        aplicarTagsVinculacion();
    }

    return vinculacionesArchivosGrupos;
}

// Persiste el mapa completo en background. Espera la carga inicial para no
// sobrescribir con un mapa vacío y encola las escrituras para que no se pisen.
function persistirVinculaciones() {
    const guardar = () => {
        const datos = {};

        vinculacionesArchivosGrupos.forEach((grupos, ruta) => {
            if (grupos.size > 0) {
                datos[ruta] = Array.from(grupos).sort((a, b) => a.localeCompare(b, 'es'));
            }
        });

        return invoke('guardar_vinculaciones', { vinculaciones: datos })
            .catch(error => {
                console.error('No se pudieron guardar las vinculaciones:', error);
            });
    };

    persistenciaVinculacionesCola = persistenciaVinculacionesCola
        .then(() => vinculacionesCargadasPromise || Promise.resolve())
        .then(guardar);
}

// Vincula o desvincula un archivo de un grupo (N a N)
function alternarVinculacion(ruta, nombreGrupo) {
    if (!ruta || !nombreGrupo) return;

    let grupos = vinculacionesArchivosGrupos.get(ruta);

    if (!grupos) {
        grupos = new Set();
        vinculacionesArchivosGrupos.set(ruta, grupos);
    }

    if (grupos.has(nombreGrupo)) {
        grupos.delete(nombreGrupo);
    } else {
        grupos.add(nombreGrupo);
    }

    if (grupos.size === 0) vinculacionesArchivosGrupos.delete(ruta);

    aplicarTagsVinculacion();
    persistirVinculaciones();
}

// Desvincula un archivo de UN grupo concreto sin tocar el resto de sus
// vinculaciones ni el archivo Excel. Persiste y refresca los chips de la lista.
function desvincularArchivoDeGrupo(ruta, nombreGrupo) {
    if (!ruta || !nombreGrupo) return false;

    const grupos = vinculacionesArchivosGrupos.get(ruta);
    if (!grupos || !grupos.has(nombreGrupo)) return false;

    grupos.delete(nombreGrupo);

    // Un archivo sin grupos no se guarda como entrada vacía
    if (grupos.size === 0) vinculacionesArchivosGrupos.delete(ruta);

    aplicarTagsVinculacion();
    persistirVinculaciones();

    console.log(`[vinculaciones] Archivo desvinculado de "${nombreGrupo}": ${ruta}`);
    return true;
}

// Al eliminar un grupo, se quitan sus referencias de todos los archivos
function quitarGrupoDeVinculaciones(nombreGrupo) {
    if (!nombreGrupo) return;

    let huboCambios = false;

    vinculacionesArchivosGrupos.forEach((grupos, ruta) => {
        if (grupos.delete(nombreGrupo)) huboCambios = true;
        if (grupos.size === 0) vinculacionesArchivosGrupos.delete(ruta);
    });

    if (huboCambios) {
        aplicarTagsVinculacion();
        persistirVinculaciones();
    }
}

// Refleja las vinculaciones en la columna izquierda: chips con los grupos
// bajo el nombre del archivo (máximo 2 visibles + contador).
function aplicarTagsVinculacion() {
    document.querySelectorAll('#fileList .excel-file-details').forEach(detalles => {
        const summary = detalles.querySelector('summary.excel-file-summary');
        if (!summary) return;

        summary.querySelector('.excel-file-tags')?.remove();

        const grupos = Array.from(vinculacionesArchivosGrupos.get(detalles.dataset.ruta) || [])
            .sort((a, b) => a.localeCompare(b, 'es'));

        if (grupos.length === 0) return;

        const contenedor = document.createElement('span');
        contenedor.className = 'excel-file-tags';
        contenedor.title = `Grupos: ${grupos.join(', ')}`;

        function crearChip(texto, claseExtra = '', tooltip = texto) {
            const chip = document.createElement('span');
            chip.className = `file-group-tag${claseExtra}`;
            chip.textContent = texto;
            chip.title = tooltip;
            // Los chips son informativos: un clic sobre ellos no pliega el archivo
            chip.addEventListener('click', evento => evento.preventDefault());
            contenedor.appendChild(chip);
        }

        grupos.slice(0, 2).forEach(nombre => crearChip(nombre));

        if (grupos.length > 2) {
            crearChip(`+${grupos.length - 2}`, ' more', grupos.join(', '));
        }

        summary.appendChild(contenedor);
    });
}

function cerrarModalVincular() {
    const overlay = document.getElementById('modalVincularArchivos');
    if (overlay) overlay.remove();

    document.removeEventListener('keydown', cerrarVinculacionPorEscape);
}

function cerrarVinculacionPorEscape(evento) {
    if (evento.key !== 'Escape') return;
    if (!document.getElementById('modalVincularArchivos')) return;

    evento.stopPropagation();
    cerrarModalVincular();
}

// --- CÁLCULO FILTRADO POR ARCHIVOS VINCULADOS ---

// Clave estable de consolidación, equivalente a la que usa Rust:
// "nombre_normalizado|unidad_recortada_en_minúsculas".
// Se reconstruye aquí para que las filas crudas y las consolidadas coincidan
// aunque la unidad traiga espacios accidentales.
function claveConsolidada(ing) {
    if (!ing) return '';

    const nombre = ing.clave_ingrediente
        || (ing.clave ? String(ing.clave).split('|')[0] : '');
    if (!nombre) return '';

    const unidad = String(ing.unidad || '').trim().toLowerCase();
    return `${nombre}|${unidad}`;
}

// Mapa: clave consolidada -> Set de rutas que aportaron esa fila.
// Se construye con los resultados crudos de cada archivo, antes de consolidar.
function construirArchivosPorClave(datosPorArchivo) {
    const archivosPorClave = new Map();

    (datosPorArchivo || []).forEach(({ ruta, datos }) => {
        if (!ruta || !Array.isArray(datos)) return;

        datos.forEach(ing => {
            const clave = claveConsolidada(ing);
            if (!clave) return;

            if (!archivosPorClave.has(clave)) {
                archivosPorClave.set(clave, new Set());
            }
            archivosPorClave.get(clave).add(ruta);
        });
    });

    return archivosPorClave;
}

// --- CÁLCULO CRUZADO POR VINCULACIONES ARCHIVO -> GRUPO ---

// Réplica mínima de la condición que valida Rust en calcular_total:
// se puede calcular si hay suma de proporciones o de alumnos > 0.
function grupoTieneFactorCalculo(secciones) {
    if (!Array.isArray(secciones)) return false;

    let sumaProporciones = 0;
    let sumaAlumnos = 0;

    secciones.forEach(seccion => {
        sumaProporciones += Number(seccion?.proporcion) || 0;
        sumaAlumnos += Number(seccion?.alumnos) || 0;
    });

    return sumaProporciones > 0 || sumaAlumnos > 0;
}

// Procesa las hojas marcadas y reemplaza la tabla. `idSolicitud` identifica
// la selección vigente: si el usuario cambió de hojas mientras se leía el
// Excel, el resultado viejo se descarta antes de tocar el estado o la UI.
// Mensaje de estado dentro de la tabla. Se usa textContent (nunca innerHTML)
// porque el texto puede venir de un error de Rust con nombres de archivo.
function mostrarMensajeEnTabla(tbody, mensaje, { error = false } = {}) {
    if (!tbody) return;

    tbody.innerHTML = '';

    const fila = document.createElement('tr');
    const celda = document.createElement('td');
    celda.colSpan = 6;
    celda.className = error ? 'tabla-mensaje tabla-mensaje-error' : 'tabla-mensaje';
    celda.textContent = mensaje;

    fila.appendChild(celda);
    tbody.appendChild(fila);
}

async function ejecutarProcesamientoHojas(idSolicitud, { silencioso = false } = {}) {
    const hojasMarcadas = document.querySelectorAll('.chk-sheet:checked');

    if (hojasMarcadas.length === 0) {
        if (idSolicitud === idSeleccionHojas) {
            ingredientesConsolidados = [];
            ingredientesPorArchivo = [];
            ultimoCalculoVinculado = false;
            const tbody = document.getElementById('tablaConsolidadaBody');
            if (tbody) tbody.innerHTML = '';
            if (!silencioso) {
                alert('No hay hojas seleccionadas.');
            }
        }
        return false;
    }

    const tbody = document.getElementById('tablaConsolidadaBody');
    if (!tbody) return false;

    // Los ajustes se cargan al arrancar en paralelo: se espera a que terminen
    // para no procesar con los valores por defecto.
    try {
        await (ajustesCargadosPromise || Promise.resolve());
    } catch (error) {
        console.error('No se pudieron cargar los ajustes antes de procesar:', error);
    }

    // Agrupamos las hojas por archivo (ruta), igual que el botón Procesar.
    const hojasPorArchivo = {};
    hojasMarcadas.forEach(chk => {
        const detalles = chk.closest('details');
        const ruta = detalles?.dataset.ruta;
        if (!ruta) return;

        if (!hojasPorArchivo[ruta]) hojasPorArchivo[ruta] = [];
        hojasPorArchivo[ruta].push(chk.dataset.hoja);
    });

    const archivos = Object.entries(hojasPorArchivo);
    if (archivos.length === 0) return false;

    mostrarProcesando('Procesando hojas…');

    let todosLosDatos = [];
    const datosPorArchivo = [];
    // Advertencias y errores por archivo/hoja: se muestran al usuario en vez
    // de quedar solo en la consola.
    const advertencias = [];
    const errores = [];

    try {
        for (const [ruta, hojas] of archivos) {
            const nombreArchivo = ruta.split(/[\\/]/).pop() || ruta;

            try {
                const resultado = await invoke('procesar_hojas_excel', {
                    ruta,
                    nombresHojas: hojas,
                    // El backend usa el mapeo segregado en lugar de listas fijas.
                    mapeo: mapeoInsumos
                });

                // Llegó una selección más nueva: no seguir acumulando datos.
                if (idSolicitud !== idSeleccionHojas) return false;

                // Formato actual: { ingredientes, advertencias }. Se tolera el
                // array plano por compatibilidad con una versión anterior.
                const datos = Array.isArray(resultado?.ingredientes)
                    ? resultado.ingredientes
                    : (Array.isArray(resultado) ? resultado : []);

                const advertenciasArchivo = Array.isArray(resultado?.advertencias)
                    ? resultado.advertencias
                    : [];

                advertenciasArchivo.forEach(aviso => {
                    advertencias.push(`${nombreArchivo}: ${aviso}`);
                });

                todosLosDatos = todosLosDatos.concat(datos);
                datosPorArchivo.push({ ruta, datos });
            } catch (error) {
                console.error(`Error procesando archivo ${ruta}:`, error);
                errores.push(`${nombreArchivo}: ${String(error)}`);
            }
        }

        if (idSolicitud !== idSeleccionHojas) return false;

        if (todosLosDatos.length === 0) {
            ingredientesConsolidados = [];
            ingredientesPorArchivo = [];
            ultimoCalculoVinculado = false;

            const detalle = [...errores, ...advertencias].join('\n');
            const mensaje = detalle || 'No se obtuvieron datos de las hojas seleccionadas.';

            mostrarMensajeEnTabla(tbody, mensaje, { error: true });

            // En autoprocesado (silencioso) no se abre un diálogo por cada
            // pulsación; el mensaje ya queda visible en la tabla.
            if (!silencioso) {
                await window.__TAURI__.dialog.message(mensaje, {
                    title: 'No se pudo procesar el Excel',
                    kind: 'error'
                });
            }

            return false;
        }

        // Consolidar entre archivos (suma + orden global).
        let consolidado = await invoke('consolidar_entre_archivos', {
            ingredientes: todosLosDatos
        });

        if (idSolicitud !== idSeleccionHojas) return false;

        // Asignar códigos del diccionario maestro si está cargado.
        if (diccionarioMaestro.length > 0) {
            consolidado = await invoke('asignar_codigos', {
                ingredientes: consolidado,
                diccionario: diccionarioMaestro
            });

            if (idSolicitud !== idSeleccionHojas) return false;
        }

        const archivosPorClave = construirArchivosPorClave(datosPorArchivo);

        const nuevosIngredientes = consolidado.map(ing => ({
            ...ing,
            // Se guarda la cantidad tal como salió de Excel para poder
            // restaurarla si el usuario edita la celda manualmente.
            cantidadOriginal: Number(ing.cantidad) || 0,
            modificadoManualmente: false,
            totalModificadoManualmente: false,
            archivos_origen: Array.from(
                archivosPorClave.get(claveConsolidada(ing)) || []
            ),
            codigo_seleccionado: ing.codigo_seleccionado || ''
        }));

        // Última comprobación antes de reemplazar estado y tabla.
        if (idSolicitud !== idSeleccionHojas) return false;

        ingredientesConsolidados = nuevosIngredientes;
        ingredientesPorArchivo = datosPorArchivo;
        ultimoCalculoVinculado = false;

        pintarTablaConsolidada(ingredientesConsolidados);

        // Hojas omitidas o columnas no reconocidas: se avisa sin bloquear el
        // resultado que sí se pudo leer.
        const avisos = [...errores, ...advertencias];
        if (avisos.length > 0) {
            console.warn('Advertencias al procesar hojas:\n' + avisos.join('\n'));

            if (!silencioso) {
                await window.__TAURI__.dialog.message(
                    'Se procesaron las hojas con advertencias:\n\n- ' + avisos.join('\n- '),
                    { title: 'Advertencias al procesar', kind: 'warning' }
                );
            }
        }

        return true;
    } catch (error) {
        console.error('Error al consolidar los ingredientes:', error);

        if (idSolicitud === idSeleccionHojas) {
            ingredientesConsolidados = [];
            ingredientesPorArchivo = [];
            mostrarMensajeEnTabla(
                tbody,
                'No se pudieron consolidar los ingredientes: ' + String(error),
                { error: true }
            );

            await window.__TAURI__.dialog.message(
                'No se pudo consolidar los ingredientes: ' + error,
                { title: 'Error', kind: 'error' }
            );
        }

        return false;
    } finally {
        ocultarProcesando();
    }
}

// Recalcula los totales con las secciones actuales sin repintar la tabla:
// conserva comentarios, colores y códigos, y respeta los totales fijados a
// mano. Se descarta si llegó una edición más nueva (`idSolicitud`).
async function ejecutarRecalculoTabla(idSolicitud) {
    if (idSolicitud !== idRecalculoTabla) return false;
    if (ingredientesConsolidados.length === 0) return false;

    // Los totales vinculados se recalculan con el botón "Calcular vinculados".
    // Aplicar aquí el factor del panel los sobrescribiría.
    if (ultimoCalculoVinculado) return false;

    // Sin secciones con alumnos o proporciones no hay factor que aplicar.
    // El cálculo vinculado sigue siendo explícito (botón "Calcular vinculados").
    if (!grupoTieneFactorCalculo(seccionesActuales)) return false;

    mostrarProcesando('Recalculando totales…');

    try {
        const conTotales = await invoke('calcular_total', {
            ingredientes: ingredientesConsolidados,
            secciones: seccionesActuales
        });

        if (idSolicitud !== idRecalculoTabla) return false;

        actualizarTotalesCalculados(conTotales);
        return true;
    } catch (error) {
        if (idSolicitud === idRecalculoTabla) {
            console.error('Error al recalcular los totales:', error);
        }
        return false;
    } finally {
        ocultarProcesando();
    }
}

// Aplica en sitio los totales devueltos por Rust sin recrear las filas.
function actualizarTotalesCalculados(calculados) {
    calculados.forEach(item => {
        const estado = ingredientePorIdFila(pkColorFila(item));
        if (!estado) return;

        const base = Number(item.cantidad) || 0;
        estado.factorTotal = base > 0 ? Number(item.cantidad_total) / base : null;

        // Un total fijado a mano no se sobrescribe.
        if (estado.totalModificadoManualmente) return;

        estado.cantidad_total = item.cantidad_total;
        pintarTotalFila(estado);
    });
}

async function calcularVinculados() {
    // Espera la carga inicial de vinculaciones para no alertar por error
    await (vinculacionesCargadasPromise || Promise.resolve());

    if (vinculacionesArchivosGrupos.size === 0) {
        alert('No hay archivos vinculados a grupos.');
        return;
    }

    if (ingredientesConsolidados.length === 0) {
        alert('Primero procesa algunas hojas para obtener ingredientes.');
        return;
    }

    if (ingredientesPorArchivo.length === 0) {
        alert('No hay información del origen de las filas. Vuelve a procesar las hojas.');
        return;
    }

    // Se leen las secciones guardadas de TODOS los grupos: este cálculo no
    // depende del grupo cargado en el panel derecho.
    let guardados = [];
    try {
        guardados = await invoke('obtener_grupos_guardados');
    } catch (error) {
        console.error('No se pudieron leer los grupos guardados:', error);
        alert('No se pudieron leer los grupos guardados: ' + error);
        return;
    }

    const seccionesPorGrupo = new Map();
    (guardados || []).forEach(grupo => {
        const nombre = grupo?.nombre;
        if (typeof nombre !== 'string' || !nombre.trim()) return;
        seccionesPorGrupo.set(
            nombre,
            Array.isArray(grupo.secciones) ? grupo.secciones : []
        );
    });

    // Archivo -> TODOS los grupos válidos a los que está vinculado.
    // Si está en A y B, se calculará una vez con cada uno y sus resultados
    // se sumarán (regla de negocio: Opción B - sumatoria).
    const gruposPorArchivo = new Map();
    vinculacionesArchivosGrupos.forEach((grupos, ruta) => {
        const candidatos = Array.from(grupos)
            .filter(nombre => {
                const secciones = seccionesPorGrupo.get(nombre);
                return Boolean(secciones) && grupoTieneFactorCalculo(secciones);
            })
            .sort((a, b) => a.localeCompare(b, 'es'));

        if (candidatos.length > 0) {
            gruposPorArchivo.set(ruta, candidatos);
        }
    });

    if (gruposPorArchivo.size === 0) {
        alert('Las vinculaciones no apuntan a grupos guardados con alumnos o proporciones definidas.');
        return;
    }

    // Agrupar archivos por grupo: una sola llamada a calcular_total por grupo.
    // Un archivo vinculado a varios grupos aparece en el Set de cada uno.
    const archivosPorGrupo = new Map();
    gruposPorArchivo.forEach((nombresGrupo, ruta) => {
        nombresGrupo.forEach(nombreGrupo => {
            if (!archivosPorGrupo.has(nombreGrupo)) {
                archivosPorGrupo.set(nombreGrupo, new Set());
            }
            archivosPorGrupo.get(nombreGrupo).add(ruta);
        });
    });

    const datosPorRuta = new Map();
    ingredientesPorArchivo.forEach(({ ruta, datos }) => {
        datosPorRuta.set(ruta, Array.isArray(datos) ? datos : []);
    });

    // Total por clave consolidada: cada aporte de archivo se escala con el
    // factor de CADA grupo al que pertenece y todos los resultados se suman.
    // (Si un archivo está en A y B, suma cantidad×factor(A) + cantidad×factor(B)).
    const totalesPorClave = new Map();
    const clavesCalculadas = new Set();
    let gruposCalculados = 0;
    let archivosUsados = 0;

    for (const [nombreGrupo, rutas] of archivosPorGrupo) {
        const ingredientes = [];

        rutas.forEach(ruta => {
            const datos = datosPorRuta.get(ruta);
            if (datos && datos.length > 0) {
                ingredientes.push(...datos);
                archivosUsados++;
            }
        });

        if (ingredientes.length === 0) continue;

        try {
            // Mismo comando y misma fórmula que el botón "Calcular"
            const calculados = await invoke('calcular_total', {
                ingredientes,
                secciones: seccionesPorGrupo.get(nombreGrupo) || []
            });

            gruposCalculados++;

            calculados.forEach(ing => {
                const clave = claveConsolidada(ing);
                if (!clave) return;

                clavesCalculadas.add(clave);
                totalesPorClave.set(
                    clave,
                    (totalesPorClave.get(clave) || 0) + ing.cantidad_total
                );
            });
        } catch (error) {
            console.warn(
                `[cálculo] El grupo "${nombreGrupo}" no se pudo calcular ` +
                `(¿sin alumnos o proporciones?):`, error
            );
        }
    }

    if (gruposCalculados === 0) {
        alert(archivosUsados === 0
            ? 'Los archivos vinculados no forman parte de la tabla actual. Procesa sus hojas primero.'
            : 'No se pudo calcular ningún grupo vinculado. Revisa que tengan alumnos o proporciones.');
        return;
    }

    // Aportes de archivos sin grupo: se mantienen intactos (factor 1) para no
    // perder datos en filas compartidas por archivos vinculados y no vinculados.
    ingredientesPorArchivo.forEach(({ ruta, datos }) => {
        if ((gruposPorArchivo.get(ruta) || []).length > 0) return;

        (datos || []).forEach(ing => {
            const clave = claveConsolidada(ing);
            if (!clave || !clavesCalculadas.has(clave)) return;

            totalesPorClave.set(
                clave,
                (totalesPorClave.get(clave) || 0) + (Number(ing.cantidad) || 0)
            );
        });
    });

    aplicarTotalesVinculados(totalesPorClave, clavesCalculadas);
    ultimoCalculoVinculado = true;

    console.log(
        `[cálculo] Vinculados: ${gruposCalculados} grupo(s), ` +
        `${clavesCalculadas.size} fila(s) recalculadas.`
    );
}

// Aplica los totales sin repintar la tabla: conserva comentarios, colores,
// códigos y los totales previos de las filas sin vínculos.
function aplicarTotalesVinculados(totalesPorClave, clavesCalculadas) {
    const tbody = document.getElementById('tablaConsolidadaBody');
    const filasPorPk = new Map();

    if (tbody) {
        tbody.querySelectorAll('tr[data-id-fila]').forEach(fila => {
            filasPorPk.set(fila.dataset.idFila, fila);
        });
    }

    let actualizadas = 0;

    ingredientesConsolidados.forEach(ing => {
        const clave = claveConsolidada(ing);
        if (!clavesCalculadas.has(clave)) return; // fila sin vínculos: intacta

        const total = totalesPorClave.get(clave);
        if (typeof total !== 'number' || !Number.isFinite(total)) return;

        // Factor efectivo del cálculo vinculado: se deriva de la cantidad
        // original (lectura del Excel), no de una base editada a mano.
        const baseCalculo = Number(ing.cantidadOriginal ?? ing.cantidad) || 0;
        ing.factorTotal = baseCalculo > 0 ? total / baseCalculo : null;

        // Un total fijado a mano manda: no se sobrescribe ni en estado ni en UI.
        if (ing.totalModificadoManualmente) return;

        ing.cantidad_total = total;

        const fila = filasPorPk.get(pkColorFila(ing));
        const input = fila?.querySelector('.input-cantidad-total');
        if (!input) return;

        input.value = valorTotalTexto(ing);
        input.classList.remove('total-modificado-manualmente');
        input.title = tituloInputTotal(ing);
        actualizadas++;
    });

    console.log(`[cálculo] Totales actualizados en ${actualizadas} fila(s).`);
}

// Panel de 2 columnas: archivos cargados a la izquierda, grupos a la derecha.
// El guardado es automático al marcar/desmarcar un grupo (igual que los
// colores): no hay trabajo pendiente si se cierra con X, Escape o clic fuera.
async function abrirModalVincular() {
    if (document.getElementById('modalVincularArchivos')) return;

    cerrarMenuContextual();
    cerrarResumenColores();

    // Aseguramos tener el estado persistido antes de mostrar los checks
    try {
        await (vinculacionesCargadasPromise || Promise.resolve());
    } catch (error) {
        console.error('No se pudieron cargar las vinculaciones antes de abrir el modal:', error);
    }

    let grupos = [];
    try {
        const guardados = await invoke('obtener_grupos_guardados');
        grupos = (guardados || [])
            .map(grupo => grupo?.nombre)
            .filter(nombre => typeof nombre === 'string' && nombre.trim() !== '');
        grupos.sort((a, b) => a.localeCompare(b, 'es'));
    } catch (error) {
        console.error('No se pudieron cargar los grupos para vincular:', error);
    }

    // Si se abrió dos veces mientras esperábamos, no duplicamos el modal
    if (document.getElementById('modalVincularArchivos')) return;

    const archivos = Array.from(document.querySelectorAll('#fileList .excel-file-details'))
        .map(detalles => {
            const ruta = detalles.dataset.ruta || '';
            const nombre = ruta.split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
            return { ruta, nombre };
        })
        .filter(archivo => archivo.ruta);

    const overlay = document.createElement('div');
    overlay.className = 'colors-modal-overlay';
    overlay.id = 'modalVincularArchivos';
    overlay.addEventListener('click', evento => {
        if (evento.target === overlay) cerrarModalVincular();
    });

    const modal = document.createElement('div');
    modal.className = 'colors-modal link-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'vincularTitulo');

    // Cabecera
    const header = document.createElement('div');
    header.className = 'colors-modal-header';

    const titulo = document.createElement('div');
    titulo.className = 'colors-modal-title';
    titulo.id = 'vincularTitulo';
    titulo.textContent = 'Vincular Archivos a Grupos';

    const subtitulo = document.createElement('span');
    subtitulo.className = 'colors-modal-subtitle';
    subtitulo.textContent = 'Un archivo puede pertenecer a varios grupos';
    titulo.appendChild(subtitulo);

    const cerrarBtn = document.createElement('button');
    cerrarBtn.type = 'button';
    cerrarBtn.className = 'colors-modal-close';
    cerrarBtn.title = 'Cerrar';
    cerrarBtn.setAttribute('aria-label', 'Cerrar vinculación de archivos');
    cerrarBtn.innerHTML = '<svg class="icon icon-sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg>';
    cerrarBtn.addEventListener('click', cerrarModalVincular);

    header.append(titulo, cerrarBtn);

    // Cuerpo en dos columnas (reutiliza las clases del panel de colores)
    const body = document.createElement('div');
    body.className = 'colors-modal-body';

    const colIzquierda = document.createElement('div');
    colIzquierda.className = 'colors-picker-column';

    const tituloIzquierda = document.createElement('div');
    tituloIzquierda.className = 'colors-picker-heading';
    tituloIzquierda.textContent = 'Archivos cargados';

    const listaArchivos = document.createElement('ul');
    listaArchivos.className = 'colors-picker-list';
    listaArchivos.id = 'vincularListaArchivos';

    const colDerecha = document.createElement('div');
    colDerecha.className = 'colors-picker-column';

    const tituloDerecha = document.createElement('div');
    tituloDerecha.className = 'colors-picker-heading';
    tituloDerecha.id = 'vincularTituloGrupos';
    tituloDerecha.textContent = 'Grupos';

    const listaGrupos = document.createElement('ul');
    listaGrupos.className = 'colors-picker-rows';
    listaGrupos.id = 'vincularListaGrupos';

    let archivoSeleccionado = null;
    const botonesArchivo = new Map();

    function refrescarSeleccionArchivo() {
        botonesArchivo.forEach((boton, ruta) => {
            const activo = ruta === archivoSeleccionado;
            boton.classList.toggle('active', activo);
            boton.setAttribute('aria-pressed', String(activo));

            const contador = boton.querySelector('.colors-picker-count');
            if (contador) contador.textContent = String(gruposDeArchivo(ruta).size);
        });
    }

    function renderizarGrupos() {
        listaGrupos.innerHTML = '';

        const archivo = archivos.find(a => a.ruta === archivoSeleccionado);

        if (!archivo) {
            tituloDerecha.textContent = 'Grupos';
            const vacio = document.createElement('li');
            vacio.className = 'colors-picker-empty';
            vacio.textContent = archivos.length === 0
                ? 'Agrega archivos Excel para poder vincularlos.'
                : 'Selecciona un archivo de la izquierda.';
            listaGrupos.appendChild(vacio);
            return;
        }

        tituloDerecha.textContent = `Grupos de «${archivo.nombre}»`;

        if (grupos.length === 0) {
            const vacio = document.createElement('li');
            vacio.className = 'colors-picker-empty';
            vacio.textContent = 'No hay grupos guardados. Crea y guarda un grupo en el panel derecho.';
            listaGrupos.appendChild(vacio);
            return;
        }

        const vinculados = gruposDeArchivo(archivo.ruta);

        grupos.forEach(nombreGrupo => {
            const li = document.createElement('li');

            const boton = document.createElement('button');
            boton.type = 'button';
            boton.className = 'link-group-row';
            boton.setAttribute('role', 'checkbox');

            const activo = vinculados.has(nombreGrupo);
            boton.classList.toggle('active', activo);
            boton.setAttribute('aria-checked', String(activo));

            const check = document.createElement('span');
            check.className = 'link-group-check';
            check.innerHTML = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg>';

            const etiqueta = document.createElement('span');
            etiqueta.className = 'link-group-name';
            etiqueta.textContent = nombreGrupo;
            etiqueta.title = nombreGrupo;

            boton.append(check, etiqueta);

            boton.addEventListener('click', () => {
                alternarVinculacion(archivo.ruta, nombreGrupo);

                // Actualización en sitio: conserva el foco del teclado
                const ahoraActivo = gruposDeArchivo(archivo.ruta).has(nombreGrupo);
                boton.classList.toggle('active', ahoraActivo);
                boton.setAttribute('aria-checked', String(ahoraActivo));

                refrescarSeleccionArchivo();
            });

            li.appendChild(boton);
            listaGrupos.appendChild(li);
        });
    }

    // Columna izquierda: archivos
    if (archivos.length === 0) {
        const vacio = document.createElement('li');
        vacio.className = 'colors-picker-empty';
        vacio.textContent = 'No hay archivos Excel cargados.';
        listaArchivos.appendChild(vacio);
    } else {
        archivos.forEach(archivo => {
            const li = document.createElement('li');

            const boton = document.createElement('button');
            boton.type = 'button';
            boton.className = 'colors-picker-color';

            const icono = document.createElement('span');
            icono.className = 'link-file-icon';
            icono.innerHTML = '<svg class="icon icon-sm xlsx" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';

            const etiqueta = document.createElement('span');
            etiqueta.className = 'colors-picker-name link-file-name';
            etiqueta.textContent = archivo.nombre || archivo.ruta;
            etiqueta.title = archivo.ruta;

            const contador = document.createElement('span');
            contador.className = 'colors-picker-count';
            contador.textContent = String(gruposDeArchivo(archivo.ruta).size);
            contador.title = 'Grupos vinculados';

            boton.append(icono, etiqueta, contador);

            boton.addEventListener('click', () => {
                archivoSeleccionado = archivo.ruta;
                refrescarSeleccionArchivo();
                renderizarGrupos();
            });

            li.appendChild(boton);
            listaArchivos.appendChild(li);
            botonesArchivo.set(archivo.ruta, boton);
        });
    }

    // Preselección: primer archivo con vinculaciones o el primero de la lista
    const archivoConGrupos = archivos.find(archivo => gruposDeArchivo(archivo.ruta).size > 0);
    archivoSeleccionado = (archivoConGrupos || archivos[0])?.ruta || null;

    colIzquierda.append(tituloIzquierda, listaArchivos);
    colDerecha.append(tituloDerecha, listaGrupos);
    body.append(colIzquierda, colDerecha);

    // Pie: guardado automático, sin botón "Guardar" que pueda quedar sin pulsar
    const footer = document.createElement('div');
    footer.className = 'link-modal-footer';

    const pista = document.createElement('span');
    pista.className = 'link-modal-hint';
    pista.textContent = 'Los cambios se guardan automáticamente.';

    const cerrarFooter = document.createElement('button');
    cerrarFooter.type = 'button';
    cerrarFooter.className = 'btn-secondary';
    cerrarFooter.textContent = 'Cerrar';
    cerrarFooter.addEventListener('click', cerrarModalVincular);

    footer.append(pista, cerrarFooter);

    modal.append(header, body, footer);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    refrescarSeleccionArchivo();
    renderizarGrupos();

    document.addEventListener('keydown', cerrarVinculacionPorEscape);
    cerrarBtn.focus();
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

// Menú genérico: opciones = [{ label, icon, danger, disabled, title, submenu, onClick }]
// - `disabled` deshabilita el ítem (se usa para "Desvincular grupo" sin grupos).
// - `submenu` = [{ label, danger, onClick }] abre un flyout lateral en vez de
//   ejecutar `onClick` en el ítem padre.
function abrirMenuContextual(x, y, opciones, targetElement = null) {
    const menu = document.createElement('div');
    menu.id = 'menuContextual';

    opciones.forEach(opcion => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'context-menu-item' + (opcion.danger ? ' danger' : '');

        if (opcion.disabled) {
            item.classList.add('is-disabled');
            item.disabled = true;
            if (opcion.title) item.title = opcion.title;
        }

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

        const submenu = Array.isArray(opcion.submenu) ? opcion.submenu : null;

        if (submenu && submenu.length > 0) {
            item.classList.add('has-submenu');

            const flecha = document.createElement('span');
            flecha.className = 'context-menu-arrow';
            flecha.innerHTML = '<svg class="icon icon-sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';
            item.appendChild(flecha);

            // El panel cuelga del mismo contenedor posicionado, así el layout
            // del menú no se desplaza al abrir/cerrar.
            const fila = document.createElement('div');
            fila.className = 'context-menu-sub';

            const panel = document.createElement('div');
            panel.className = 'context-submenu';

            submenu.forEach(subopcion => {
                const subItem = document.createElement('button');
                subItem.type = 'button';
                subItem.className = 'context-menu-item' + (subopcion.danger ? ' danger' : '');
                subItem.textContent = subopcion.label;

                subItem.addEventListener('click', (eventoSub) => {
                    // Evita que el clic llegue al documento y cierre antes de tiempo
                    eventoSub.stopPropagation();
                    cerrarMenuContextual();
                    if (typeof subopcion.onClick === 'function') subopcion.onClick();
                });

                panel.appendChild(subItem);
            });

            fila.append(item, panel);
            menu.appendChild(fila);
            return;
        }

        item.addEventListener('click', () => {
            cerrarMenuContextual();
            if (typeof opcion.onClick === 'function') opcion.onClick();
        });

        menu.appendChild(item);
    });

    // Apertura del submenú: al pasar el ratón y también con clic (táctil)
    menu.querySelectorAll('.context-menu-sub').forEach(fila => {
        const panel = fila.querySelector('.context-submenu');
        const disparador = fila.querySelector('.context-menu-item');
        if (!panel || !disparador || disparador.disabled) return;

        const abrir = () => {
            fila.classList.add('submenu-open');

            // Si el panel se sale por la derecha, se voltea a la izquierda
            fila.classList.remove('submenu-left');
            if (panel.getBoundingClientRect().right > window.innerWidth - 4) {
                fila.classList.add('submenu-left');
            }
        };

        const cerrar = () => fila.classList.remove('submenu-open');

        fila.addEventListener('mouseenter', abrir);
        fila.addEventListener('mouseleave', cerrar);

        disparador.addEventListener('click', (evento) => {
            evento.stopPropagation(); // no cierra el menú principal
            if (fila.classList.contains('submenu-open')) {
                cerrar();
            } else {
                abrir();
            }
        });
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

    // Restaurar la cantidad leída del Excel (solo si se editó a mano)
    const ingrediente = ingredientePorIdFila(idFila);
    const modificada = Boolean(ingrediente?.modificadoManualmente);

    const separador = document.createElement('div');
    separador.className = 'context-menu-separator';
    menu.appendChild(separador);

    const restaurar = document.createElement('button');
    restaurar.type = 'button';
    restaurar.className = 'context-menu-item';
    restaurar.textContent = 'Restaurar valor original';
    restaurar.title = modificada
        ? `Volver a la cantidad leída del Excel (${formatearCantidad(ingrediente.cantidadOriginal)})`
        : 'La cantidad de esta fila no se ha modificado';

    if (!modificada) {
        restaurar.classList.add('is-disabled');
        restaurar.disabled = true;
    }

    restaurar.addEventListener('click', () => {
        cerrarMenuContextual();
        restaurarCantidadOriginal(idFila);
    });

    menu.appendChild(restaurar);

    // Restaurar el total derivado (solo si se editó a mano)
    const totalModificado = Boolean(ingrediente?.totalModificadoManualmente);

    const restaurarTotal = document.createElement('button');
    restaurarTotal.type = 'button';
    restaurarTotal.className = 'context-menu-item';
    restaurarTotal.textContent = 'Restaurar Total Original';
    restaurarTotal.title = totalModificado
        ? 'Quitar el total manual y recalcularlo con las proporciones'
        : 'El total de esta fila no se ha modificado';

    if (!totalModificado) {
        restaurarTotal.classList.add('is-disabled');
        restaurarTotal.disabled = true;
    }

    restaurarTotal.addEventListener('click', () => {
        cerrarMenuContextual();
        restaurarTotalOriginal(idFila);
    });

    menu.appendChild(restaurarTotal);

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

    // Si hay un filtro activo, pintar o quitar color puede cambiar la
    // visibilidad de esa fila: se recalcula sin repintar la tabla.
    reaplicarFiltroColor();
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

// --- FILTRO POR COLOR DE LA TABLA PRINCIPAL (SELECCIÓN MÚLTIPLE) ---

// Centinela para el checkbox "Sin color": no es un color real, así que no
// puede colisionar con los ids de COLORES_INGREDIENTE.
const FILTRO_SIN_COLOR = '__sin_color__';

// Estado del filtro en memoria: ids de color seleccionados + posible
// FILTRO_SIN_COLOR. Vacío = sin filtro (se muestran todas las filas).
// No se persiste: al reiniciar la app la tabla vuelve a mostrarse completa.
let coloresFiltroActivos = new Set();

// Nodo del menú desplegable abierto (o null). Se ancla con position: fixed
// porque .table-container tiene overflow: hidden y recortaría el dropdown.
let menuFiltroColor = null;

function nombreColor(colorId) {
    if (!colorId) return '';
    return colorId.charAt(0).toUpperCase() + colorId.slice(1);
}

// Texto legible del estado actual, para el tooltip del botón
function describirFiltroColor() {
    if (coloresFiltroActivos.size === 0) return '';

    return Array.from(coloresFiltroActivos)
        .map(id => (id === FILTRO_SIN_COLOR ? 'Sin color' : nombreColor(id)))
        .join(', ');
}

// Filas de la tabla agrupadas por color asignado ("Sin color" incluido)
function contarFilasPorColor(tbody) {
    const conteo = new Map(COLORES_INGREDIENTE.map(c => [c.id, 0]));
    conteo.set(FILTRO_SIN_COLOR, 0);
    if (!tbody) return conteo;

    tbody.querySelectorAll('tr[data-id-fila]').forEach(fila => {
        const colorId = coloresIngredientes.get(fila.dataset.idFila);
        const clave = colorId && conteo.has(colorId) ? colorId : FILTRO_SIN_COLOR;
        conteo.set(clave, (conteo.get(clave) || 0) + 1);
    });

    return conteo;
}

// Oculta/muestra filas según los colores seleccionados (lógica OR).
// No repinta la tabla: solo alterna el atributo `hidden`, así se conservan
// comentarios, códigos y los valores ya calculados.
function reaplicarFiltroColor() {
    const tbody = document.getElementById('tablaConsolidadaBody');
    if (!tbody) return;

    const hayFiltro = coloresFiltroActivos.size > 0;
    let visibles = 0;

    tbody.querySelectorAll('tr[data-id-fila]').forEach(fila => {
        const colorId = coloresIngredientes.get(fila.dataset.idFila) || null;

        // Sin selección: todo visible. Con selección: el color de la fila debe
        // estar entre los elegidos, o estar sin pintar y "Sin color" marcado.
        const coincide = !hayFiltro
            || (colorId
                ? coloresFiltroActivos.has(colorId)
                : coloresFiltroActivos.has(FILTRO_SIN_COLOR));

        fila.hidden = !coincide;
        if (coincide) visibles++;
    });

    actualizarAvisoFiltroVacio(tbody, hayFiltro, visibles);
}

// Cuando el filtro deja la tabla sin filas, se avisa en lugar de mostrar
// un hueco en blanco (el aviso no es una fila de datos: no tiene data-id-fila).
function actualizarAvisoFiltroVacio(tbody, hayFiltro, visibles) {
    tbody.querySelectorAll('tr.fila-vacia-filtro').forEach(fila => fila.remove());

    if (!hayFiltro || visibles > 0) return;

    const tr = document.createElement('tr');
    tr.className = 'fila-vacia-filtro';

    const td = document.createElement('td');
    td.colSpan = 6;
    td.className = 'fila-vacia-filtro-celda';
    td.textContent = 'Ninguna fila coincide con los colores seleccionados.';

    tr.appendChild(td);
    tbody.appendChild(tr);
}

// Refleja el estado del filtro en la barra de la tabla: texto + badge con
// la cantidad de colores seleccionados.
function actualizarIndicadorFiltroColor() {
    const boton = document.getElementById('btnFiltrarColor');
    const etiqueta = document.getElementById('filtrarColorLabel');
    const badge = document.getElementById('filtrarColorBadge');
    if (!boton || !etiqueta) return;

    const total = coloresFiltroActivos.size;

    boton.classList.toggle('is-active', total > 0);
    boton.title = total > 0
        ? `Mostrando: ${describirFiltroColor()}. Clic para cambiar el filtro.`
        : 'Mostrar las filas de uno o varios colores';
    etiqueta.textContent = total > 0 ? `Filtro (${total})` : 'Filtrar por color';

    if (badge) {
        badge.hidden = total === 0;
        badge.textContent = String(total);
    }
}

// Marca/desmarca un color y recalcula el filtro de inmediato
function alternarColorFiltro(colorId, seleccionado) {
    if (seleccionado) {
        coloresFiltroActivos.add(colorId);
    } else {
        coloresFiltroActivos.delete(colorId);
    }

    reaplicarFiltroColor();
    actualizarIndicadorFiltroColor();

    console.log(
        `[filtro-color] ${coloresFiltroActivos.size} color(es) activo(s): ` +
        (describirFiltroColor() || 'todos')
    );
}

// "Limpiar filtro": se vacía la selección y vuelven a verse todas las filas
// (solo se quita `hidden`; el orden del DOM nunca cambia).
function quitarFiltroColor() {
    coloresFiltroActivos.clear();
    sincronizarCheckboxesFiltro();
    reaplicarFiltroColor();
    actualizarIndicadorFiltroColor();

    console.log('[filtro-color] Filtro limpiado: se muestran todas las filas.');
}

// "Seleccionar todo": marca los 8 colores y también "Sin color"
function seleccionarTodoElFiltroColor() {
    COLORES_INGREDIENTE.forEach(color => coloresFiltroActivos.add(color.id));
    coloresFiltroActivos.add(FILTRO_SIN_COLOR);

    sincronizarCheckboxesFiltro();
    reaplicarFiltroColor();
    actualizarIndicadorFiltroColor();

    console.log('[filtro-color] Seleccionados todos los colores.');
}

// Refleja el estado del Set en los checkboxes del menú abierto
function sincronizarCheckboxesFiltro() {
    if (!menuFiltroColor) return;

    menuFiltroColor.querySelectorAll('input.color-filter-check').forEach(check => {
        const activo = coloresFiltroActivos.has(check.dataset.colorId);
        check.checked = activo;

        const fila = check.closest('.color-filter-item');
        if (fila) fila.classList.toggle('is-selected', activo);
    });

    const limpiar = menuFiltroColor.querySelector('.color-filter-clear');
    if (limpiar) limpiar.disabled = coloresFiltroActivos.size === 0;
}

function abrirMenuFiltroColor() {
    // Segundo clic sobre el botón: cierra (comportamiento toggle)
    if (menuFiltroColor) {
        cerrarMenuFiltroColor();
        return;
    }

    const boton = document.getElementById('btnFiltrarColor');
    if (!boton) return;

    const menu = document.createElement('div');
    menu.id = 'colorFilterMenu';
    menu.className = 'color-filter-menu';
    menu.setAttribute('role', 'group');
    menu.setAttribute('aria-label', 'Filtrar filas por color');

    const titulo = document.createElement('div');
    titulo.className = 'color-filter-heading';
    titulo.textContent = 'Mostrar filas de:';
    menu.appendChild(titulo);

    const conteo = contarFilasPorColor(document.getElementById('tablaConsolidadaBody'));

    // Un checkbox por color
    COLORES_INGREDIENTE.forEach(({ id, valor }) => {
        menu.appendChild(crearOpcionFiltroColor(id, nombreColor(id), valor, conteo.get(id) || 0));
    });

    // Checkbox extra: filas sin pintar
    menu.appendChild(
        crearOpcionFiltroColor(FILTRO_SIN_COLOR, 'Sin color', null, conteo.get(FILTRO_SIN_COLOR) || 0)
    );

    const separador = document.createElement('div');
    separador.className = 'color-filter-separator';
    menu.appendChild(separador);

    // Acciones: no cierran el menú, el filtro se aplica al instante
    const acciones = document.createElement('div');
    acciones.className = 'color-filter-actions';

    const seleccionarTodo = document.createElement('button');
    seleccionarTodo.type = 'button';
    seleccionarTodo.className = 'color-filter-action';
    seleccionarTodo.textContent = 'Seleccionar todo';
    seleccionarTodo.addEventListener('click', seleccionarTodoElFiltroColor);

    const limpiar = document.createElement('button');
    limpiar.type = 'button';
    limpiar.className = 'color-filter-action color-filter-clear';
    limpiar.disabled = coloresFiltroActivos.size === 0;
    limpiar.textContent = 'Limpiar';
    limpiar.addEventListener('click', quitarFiltroColor);

    acciones.append(seleccionarTodo, limpiar);
    menu.appendChild(acciones);

    const cerrar = document.createElement('button');
    cerrar.type = 'button';
    cerrar.className = 'color-filter-close';
    cerrar.textContent = 'Cerrar';
    cerrar.addEventListener('click', cerrarMenuFiltroColor);
    menu.appendChild(cerrar);

    document.body.appendChild(menu);
    menuFiltroColor = menu;

    // Posicionado bajo el botón, alineado a su borde derecho y ajustado
    // al viewport (igual que los menús contextuales de la app).
    const margen = 6;
    const rect = boton.getBoundingClientRect();
    const ancho = menu.offsetWidth;
    const alto = menu.offsetHeight;

    const izquierda = Math.max(
        margen,
        Math.min(rect.right - ancho, window.innerWidth - ancho - margen)
    );

    let arriba = rect.bottom + 6;
    if (arriba + alto > window.innerHeight - margen) {
        arriba = Math.max(margen, rect.top - alto - 6);
    }

    menu.style.left = `${izquierda}px`;
    menu.style.top = `${arriba}px`;

    boton.setAttribute('aria-expanded', 'true');
    boton.classList.add('is-open');
}

// Fila del menú: checkbox + muestra de color + nombre + contador de filas.
// Se usa <label> para que todo el renglón alterne el checkbox sin JS extra.
function crearOpcionFiltroColor(colorId, etiqueta, colorHex, cantidad) {
    const fila = document.createElement('label');
    fila.className = 'color-filter-item';
    fila.dataset.colorId = colorId;

    const check = document.createElement('input');
    check.type = 'checkbox';
    check.className = 'color-filter-check';
    check.dataset.colorId = colorId;
    check.checked = coloresFiltroActivos.has(colorId);

    if (check.checked) fila.classList.add('is-selected');

    const swatch = document.createElement('span');
    swatch.className = 'color-filter-swatch';
    if (colorHex) {
        swatch.style.background = colorHex;
    } else {
        swatch.classList.add('is-none');
    }

    const nombre = document.createElement('span');
    nombre.className = 'color-filter-name';
    nombre.textContent = etiqueta;

    const contador = document.createElement('span');
    contador.className = 'color-filter-count';
    contador.textContent = String(cantidad);
    contador.title = `${cantidad} fila(s)`;

    check.addEventListener('change', () => {
        alternarColorFiltro(colorId, check.checked);
        fila.classList.toggle('is-selected', check.checked);
        const limpiar = menuFiltroColor?.querySelector('.color-filter-clear');
        if (limpiar) limpiar.disabled = coloresFiltroActivos.size === 0;
    });

    fila.append(check, swatch, nombre, contador);
    return fila;
}

function cerrarMenuFiltroColor() {
    if (menuFiltroColor) {
        menuFiltroColor.remove();
        menuFiltroColor = null;
    }

    const boton = document.getElementById('btnFiltrarColor');
    if (boton) {
        boton.setAttribute('aria-expanded', 'false');
        boton.classList.remove('is-open');
    }
}

// --- EXPORTACIÓN (Excel .xlsx en Rust / PDF por impresión) ---
// Ambas exportaciones leen SOLO las filas visibles del DOM, así respetan
// automáticamente el filtro por color y cualquier otro ocultamiento.

const COLUMNAS_EXPORTACION = [
    'Ingrediente',
    'Código',
    'Unidad',
    'Cantidad',
    'Cantidad Total',
    'Comentarios'
];

// Columnas configuradas en "Exportación" que el usuario eligió exportar.
// Conserva el orden fijo del modal e ignora cualquier id desconocido.
function columnasExportacionActivas() {
    const seleccionadas = new Set(
        Array.isArray(ajustesProcesamiento?.columnasExportacion)
            ? ajustesProcesamiento.columnasExportacion
            : AJUSTES_POR_DEFECTO.columnasExportacion
    );

    return COLUMNAS_AJUSTES_EXPORTACION.filter(columna => seleccionadas.has(columna.id));
}

function incluirColoresExportacion() {
    return Boolean(ajustesProcesamiento?.incluirColoresExportacion);
}

// Color de fondo de una fila para exportar (hex) o null si no tiene color.
function colorFilaExportacion(fila) {
    const colorId = coloresIngredientes.get(fila.dataset.idFila);
    return colorId ? (COLORES_POR_ID.get(colorId) || null) : null;
}

// Aviso común cuando el usuario desmarcó todas las columnas.
function avisarSinColumnasExportacion() {
    alert(
        'No hay columnas seleccionadas para exportar.\n\n'
        + 'Elige al menos una en Ajustes → Exportación.'
    );
}

// Filas de datos que el usuario está viendo (sin `hidden` ni display: none)
function filasVisiblesTabla() {
    const tbody = document.getElementById('tablaConsolidadaBody');
    if (!tbody) return [];

    return Array.from(tbody.querySelectorAll('tr[data-id-fila]')).filter(fila => {
        if (fila.hidden) return false;
        return window.getComputedStyle(fila).display !== 'none';
    });
}

// Código elegido en la celda interactiva (select del diccionario o input manual)
function codigoDeFila(fila) {
    const celda = fila.children[1];
    if (!celda) return '';

    const select = celda.querySelector('select');
    if (select) {
        const valor = select.value;
        return valor && valor !== CODIGO_MANUAL ? valor : '';
    }

    const input = celda.querySelector('input');
    if (input) return input.value.trim();

    return (celda.innerText || '').trim();
}

// Texto numérico para exportar: siempre con punto decimal y sin artefactos de
// coma flotante (p. ej. 12.340000000000002). El formato visual no interviene.
function textoNumeroExportacion(numero) {
    if (!Number.isFinite(numero)) return '';
    return String(Number(numero.toFixed(6)));
}

// Cantidad de una fila para exportar. Se prioriza el estado en memoria (con el
// valor completo, sin redondear) para que "sin decimales" no altere el archivo.
// El texto se devuelve siempre con punto decimal: Excel lo interpreta igual.
function cantidadDeFila(fila) {
    const ingrediente = ingredientePorIdFila(fila.dataset.idFila);
    const desdeEstado = Number(ingrediente?.cantidad);
    if (ingrediente && Number.isFinite(desdeEstado)) {
        return textoNumeroExportacion(desdeEstado);
    }

    const input = fila.querySelector('.input-cantidad');
    if (input) {
        const desdeInput = parsearNumeroTabla(input.value);
        if (Number.isFinite(desdeInput)) return textoNumeroExportacion(desdeInput);
    }

    return (fila.children[3]?.innerText || '').trim();
}

// Cantidad total de una fila: mismo criterio que `cantidadDeFila`. Sin total
// calculado se exporta "—", igual que antes de hacer editable la columna.
function cantidadTotalDeFila(fila) {
    const ingrediente = ingredientePorIdFila(fila.dataset.idFila);
    const desdeEstado = Number(ingrediente?.cantidad_total);
    if (ingrediente && Number.isFinite(desdeEstado)) {
        return textoNumeroExportacion(desdeEstado);
    }

    const input = fila.querySelector('.input-cantidad-total');
    if (input) {
        const desdeInput = parsearNumeroTabla(input.value);
        if (Number.isFinite(desdeInput)) return textoNumeroExportacion(desdeInput);
        return '—';
    }

    return (fila.children[4]?.innerText || '').trim() || '—';
}

// Valores de una fila, en el orden de COLUMNAS_EXPORTACION
function datosFilaTabla(fila) {
    const comentario = fila.querySelector('.input-comentario');

    return [
        (fila.children[0]?.innerText || '').trim(),
        codigoDeFila(fila),
        (fila.children[2]?.innerText || '').trim(),
        cantidadDeFila(fila),
        cantidadTotalDeFila(fila),
        comentario ? comentario.value.trim() : (fila.children[5]?.innerText || '').trim()
    ];
}

function tituloExportacion() {
    const input = document.getElementById('tituloConsolidado');
    const titulo = (input?.value || '').trim();
    return titulo || 'Consolidado de ingredientes';
}

// Nombre de archivo seguro para Windows: sin caracteres prohibidos
function nombreArchivoExportacion(extension) {
    const base = tituloExportacion()
        .replace(/[\\/:*?"<>|]+/g, '-')
        .replace(/\s+/g, ' ')
        .trim() || 'consolidado';

    const hoy = new Date();
    const marca = [
        hoy.getFullYear(),
        String(hoy.getMonth() + 1).padStart(2, '0'),
        String(hoy.getDate()).padStart(2, '0')
    ].join('-');

    return `${base} ${marca}.${extension}`;
}

// --- EXPORTACIÓN A EXCEL (.xlsx real, generado en Rust) ---
// El frontend solo recolecta textos ya resueltos (nunca HTML de inputs) y los
// envía a Rust, que escribe el libro con rust_xlsxwriter.

// Columnas que Excel debe tratar como número: Cantidad y Cantidad Total.
// Se declaran explícitamente para no convertir códigos como "001" en 1.
const COLUMNAS_NUMERICAS_EXPORTACION = [3, 4];

async function exportarExcel() {
    const filas = filasVisiblesTabla();

    if (filas.length === 0) {
        alert('No hay filas visibles para exportar.\n\nRevisa el filtro por color.');
        return;
    }

    const columnas = columnasExportacionActivas();
    if (columnas.length === 0) {
        avisarSinColumnasExportacion();
        return;
    }

    const incluirColores = incluirColoresExportacion();

    // Diálogo nativo "Guardar como".
    let ruta;
    try {
        ruta = await window.__TAURI__.dialog.save({
            title: 'Guardar resumen como Excel',
            defaultPath: nombreArchivoExportacion('xlsx'),
            filters: [{ name: 'Libro de Excel', extensions: ['xlsx'] }]
        });
    } catch (error) {
        console.error('No se pudo abrir el diálogo de guardado:', error);
        return;
    }

    // El usuario canceló: no se hace nada.
    if (!ruta) return;

    // El diálogo no añade la extensión por sí solo.
    if (!/\.xlsx$/i.test(ruta)) ruta += '.xlsx';

    // Se envían todas las columnas y Rust descarta las no elegidas. Así el
    // orden de `columnasNumericas` sigue apuntando a los índices originales.
    const datos = [
        COLUMNAS_EXPORTACION,
        ...filas.map(datosFilaTabla)
    ];

    // Arreglo alineado con las filas de datos: hex del color o null.
    const coloresFilas = filas.map(fila =>
        incluirColores ? colorFilaExportacion(fila) : null
    );

    try {
        await invoke('exportar_excel', {
            datos,
            columnasNumericas: COLUMNAS_NUMERICAS_EXPORTACION,
            incluirColores,
            columnas: columnas.map(columna => columna.id),
            coloresFilas,
            ruta
        });

        console.log(
            `[export] Excel generado con ${filas.length} fila(s) y ` +
            `${columnas.length} columna(s) (colores: ${incluirColores ? 'sí' : 'no'}): ${ruta}`
        );
    } catch (error) {
        console.error('No se pudo generar el Excel:', error);
        await window.__TAURI__.dialog.message(
            `No se pudo guardar el Excel:\n\n${error}`,
            { title: 'Error al exportar', kind: 'error' }
        );
    }
}

// Fecha de hoy en DD/MM/AAAA. `es-CL` separa con guiones ("15-11-2026"),
// así que se normalizan los separadores al formato del reporte.
function fechaCabeceraImpresion(fecha = new Date()) {
    return fecha
        .toLocaleDateString('es-CL', {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric'
        })
        .replace(/[-.]/g, '/');
}

// Rellena #print-header (oculto en pantalla) y devuelve una copia lista para
// incrustar en la hoja de impresión. La copia pierde el id y la clase que lo
// oculta, para no duplicar identificadores ni heredar el display: none.
function construirCabeceraImpresion() {
    const cabecera = document.getElementById('print-header');
    if (!cabecera) return null;

    cabecera.textContent = '';

    const titulo = document.createElement('h1');
    titulo.className = 'print-header-title';
    titulo.textContent = tituloExportacion();

    const meta = document.createElement('p');
    meta.className = 'print-header-meta';
    meta.textContent = `Fecha: ${fechaCabeceraImpresion()}`;

    cabecera.append(titulo, meta);

    const copia = cabecera.cloneNode(true);
    copia.removeAttribute('id');
    copia.classList.remove('ocultar-en-pantalla');

    return copia;
}

// Hoja de impresión: cabecera del reporte + tabla en texto plano (sin inputs).
// Las columnas no elegidas se marcan con `.ocultar-en-exportacion` (la regla
// vive en @media print) y, si el usuario lo pidió, cada fila conserva su color.
function construirHojaImpresion(filas, { columnas, incluirColores }) {
    const hoja = document.createElement('section');
    hoja.className = 'solo-impresion';

    const cabecera = construirCabeceraImpresion();
    if (cabecera) hoja.appendChild(cabecera);

    const tabla = document.createElement('table');
    tabla.className = 'print-table';

    // `columnas` es un Set de ids estables (ingrediente, codigo, …).
    const visibles = columnas instanceof Set ? columnas : new Set();

    const thead = document.createElement('thead');
    const filaCabecera = document.createElement('tr');
    COLUMNAS_AJUSTES_EXPORTACION.forEach((columna, indice) => {
        const th = document.createElement('th');
        th.textContent = COLUMNAS_EXPORTACION[indice];
        if (!visibles.has(columna.id)) {
            th.classList.add('ocultar-en-exportacion');
        }
        filaCabecera.appendChild(th);
    });
    thead.appendChild(filaCabecera);

    const tbody = document.createElement('tbody');
    filas.forEach(fila => {
        const tr = document.createElement('tr');

        if (incluirColores) {
            const color = colorFilaExportacion(fila);
            if (color) tr.style.backgroundColor = color;
        }

        datosFilaTabla(fila).forEach((valor, indice) => {
            const td = document.createElement('td');
            td.textContent = valor;

            const columna = COLUMNAS_AJUSTES_EXPORTACION[indice];
            if (!columna || !visibles.has(columna.id)) {
                td.classList.add('ocultar-en-exportacion');
            }

            tr.appendChild(td);
        });

        tbody.appendChild(tr);
    });

    tabla.append(thead, tbody);
    hoja.appendChild(tabla);

    return hoja;
}

function exportarPdf() {
    const filas = filasVisiblesTabla();

    if (filas.length === 0) {
        alert('No hay filas visibles para exportar.\n\nRevisa el filtro por color.');
        return;
    }

    const columnas = columnasExportacionActivas();
    if (columnas.length === 0) {
        avisarSinColumnasExportacion();
        return;
    }

    const incluirColores = incluirColoresExportacion();

    // Se elimina cualquier hoja previa (p. ej. si se canceló una impresión)
    document.querySelectorAll('.solo-impresion').forEach(hoja => hoja.remove());

    const hoja = construirHojaImpresion(filas, {
        columnas: new Set(columnas.map(columna => columna.id)),
        incluirColores
    });
    document.body.appendChild(hoja);

    // Con esta clase, @media print oculta toda la app y deja solo la hoja.
    // `imprimiendo-con-color` desactiva el forzado a blanco y negro y activa
    // `print-color-adjust: exact` para que el motor de impresión respete los
    // fondos de fila.
    document.body.classList.add('imprimiendo');
    document.body.classList.toggle('imprimiendo-con-color', incluirColores);

    let temporizador = null;

    const limpiar = () => {
        if (temporizador) clearTimeout(temporizador);
        window.removeEventListener('afterprint', limpiar);
        document.body.classList.remove('imprimiendo', 'imprimiendo-con-color');

        // Restaura la visibilidad de las columnas ocultadas para exportar y
        // retira la hoja temporal (la tabla real nunca se oculta).
        hoja.querySelectorAll('.ocultar-en-exportacion').forEach(celda => {
            celda.classList.remove('ocultar-en-exportacion');
        });
        hoja.remove();

        // La cabecera se vacía para que un Ctrl+P posterior no muestre
        // datos de una exportación anterior.
        const cabecera = document.getElementById('print-header');
        if (cabecera) cabecera.textContent = '';
    };

    window.addEventListener('afterprint', limpiar);

    // Espera un frame para que el navegador aplique estilos y pintado
    requestAnimationFrame(() => {
        window.print();

        // Respaldo por si `afterprint` no se dispara en algún WebView
        temporizador = setTimeout(limpiar, 30000);
    });

    console.log(
        `[export] PDF preparado con ${filas.length} fila(s) y ` +
        `${columnas.length} columna(s) (colores: ${incluirColores ? 'sí' : 'no'}).`
    );
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
    if (filas.length === 0) {
        reaplicarFiltroColor();
        return;
    }

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

    // Tras repintar la tabla se vuelve a aplicar el filtro activo, si lo hay
    reaplicarFiltroColor();
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

// --- ELIMINACIÓN DE ARCHIVOS DE LA LISTA ---
// La selección reutiliza las casillas `.chk-file` de cada archivo. El botón
// "Eliminar seleccionados" se habilita solo cuando hay al menos una marcada.
function archivosSeleccionadosParaEliminar() {
    return Array.from(
        document.querySelectorAll('#fileList .excel-file-details')
    ).filter(detalle => detalle.querySelector('.chk-file')?.checked);
}

function actualizarBotonEliminarSeleccionados() {
    const boton = document.getElementById('btnEliminarSeleccionados');
    if (!boton) return;

    const cantidad = archivosSeleccionadosParaEliminar().length;
    boton.disabled = cantidad === 0;
    boton.title = cantidad === 0
        ? 'Marca la casilla de uno o más archivos para poder eliminarlos'
        : `Elimina de la lista ${cantidad === 1 ? 'el archivo marcado' : `los ${cantidad} archivos marcados`}`;
}

// Limpia del Store los datos que dependían de los archivos eliminados:
//  - vinculaciones archivo → grupo (se borran las entradas de esas rutas),
//  - colores de ingredientes que solo aportaban esos archivos.
function limpiarDatosDeArchivosEliminados(rutas) {
    const eliminadas = new Set(rutas);
    if (eliminadas.size === 0) return;

    let vinculacionesCambiadas = false;
    eliminadas.forEach(ruta => {
        if (vinculacionesArchivosGrupos.delete(ruta)) vinculacionesCambiadas = true;
    });
    if (vinculacionesCambiadas) persistirVinculaciones();

    // Sin los datos crudos de la última consolidación no se puede saber qué
    // ingredientes venían de cada archivo; se dejan los colores intactos.
    if (!coloresCargados || !Array.isArray(ingredientesPorArchivo)) return;

    const nombresRestantes = new Set();
    const nombresEliminados = new Set();

    ingredientesPorArchivo.forEach(({ ruta, datos }) => {
        if (!Array.isArray(datos)) return;
        const destino = eliminadas.has(ruta) ? nombresEliminados : nombresRestantes;

        datos.forEach(ing => {
            const nombre = claveNombreIngrediente(ing);
            if (nombre) destino.add(nombre);
        });
    });

    if (nombresEliminados.size === 0) return;

    let coloresEliminados = 0;
    nombresEliminados.forEach(nombre => {
        // El ingrediente sigue existiendo en otro archivo: su color se conserva.
        if (nombresRestantes.has(nombre)) return;

        coloresIngredientes.forEach((_, clave) => {
            const corte = clave.lastIndexOf(SEPARADOR_PK_COLOR);
            const nombreClave = corte >= 0 ? clave.slice(0, corte) : clave;

            if (nombreClave === nombre) {
                coloresIngredientes.delete(clave);
                coloresEliminados++;
            }
        });
    });

    if (coloresEliminados > 0) {
        console.log(`[colores] Colores huérfanos eliminados: ${coloresEliminados}`);
        persistirColoresFilas();
    }
}

async function eliminarArchivosSeleccionados() {
    const detalles = archivosSeleccionadosParaEliminar();
    if (detalles.length === 0) return;

    const cantidad = detalles.length;
    const mensaje = cantidad === 1
        ? '¿Estás seguro de que deseas eliminar el archivo seleccionado de la lista?\n\n'
            + 'Esta acción no se puede deshacer. El archivo original no se borra del disco.'
        : `¿Estás seguro de que deseas eliminar los ${cantidad} archivos seleccionados de la lista?\n\n`
            + 'Esta acción no se puede deshacer. Los archivos originales no se borran del disco.';

    const confirmar = await window.__TAURI__.dialog.ask(mensaje, {
        title: 'Eliminar archivos seleccionados',
        kind: 'warning',
        okLabel: 'Eliminar',
        cancelLabel: 'Cancelar'
    });

    if (!confirmar) return;

    const boton = document.getElementById('btnEliminarSeleccionados');
    if (boton) boton.disabled = true;

    const rutasEliminadas = [];
    const errores = [];

    for (const detalle of detalles) {
        const ruta = detalle.dataset.ruta;
        if (!ruta) continue;

        try {
            await invoke('eliminar_archivo_reciente', { ruta });
            detalle.remove();
            rutasEliminadas.push(ruta);
        } catch (error) {
            console.error('Error al eliminar el archivo de la lista:', error);
            const nombre = ruta.split(/[\\/]/).pop();
            errores.push(`${nombre}: ${error}`);
        }
    }

    if (rutasEliminadas.length > 0) {
        limpiarDatosDeArchivosEliminados(rutasEliminadas);

        // Las hojas de los archivos borrados ya no existen en el DOM. Se
        // recalcula con la selección restante; si no queda ninguna hoja
        // marcada, la tabla y los totales se vacían.
        procesarHojasDebounced.cancelar();
        desmarcarHojaDebounced.cancelar();
        ejecutarProcesamientoHojas(++idSeleccionHojas, { silencioso: true });
    }

    actualizarBotonEliminarSeleccionados();

    if (errores.length > 0) {
        await window.__TAURI__.dialog.message(
            `No se pudieron eliminar ${errores.length} archivo(s):\n\n${errores.join('\n')}`,
            { title: 'Error al eliminar', kind: 'error' }
        );
    }
}

async function eliminarArchivoDeLista(detalles) {
    const ruta = detalles.dataset.ruta;
    const nombre = ruta.split(/[\\/]/).pop();
    const teniaHojasMarcadas = Boolean(detalles.querySelector('.chk-sheet:checked'));

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

        // Un archivo eliminado no debe conservar vinculaciones ni colores que
        // solo dependían de él.
        limpiarDatosDeArchivosEliminados([ruta]);
        actualizarBotonEliminarSeleccionados();

        // Sus hojas ya no forman parte de la selección: se programa un único
        // reprocesamiento (debounced) para recalcular con lo que quede.
        if (teniaHojasMarcadas) desmarcarHoja();
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

// --- EDICIÓN MANUAL DE LA CANTIDAD ---
// La cantidad base de cada fila vive en `ingredientesConsolidados`. Al editarla
// se marca `modificadoManualmente` y se conserva `cantidadOriginal` (la lectura
// del Excel) para poder restaurarla desde el menú contextual.

// Formato de números activo para la UI. `formatoNumerosVista` solo existe
// mientras el modal previsualiza un cambio sin guardar.
function formatoNumerosActivo() {
    return formatoNumerosVista
        || ajustesProcesamiento?.formatoNumeros
        || AJUSTES_POR_DEFECTO.formatoNumeros;
}

// Agrupa la parte entera con el separador indicado (sin tocar el signo).
function agruparEntero(numero, separadorMiles) {
    const signo = numero < 0 ? '-' : '';
    const digitos = String(Math.abs(Math.trunc(numero)));
    return signo + digitos.replace(/\B(?=(\d{3})+(?!\d))/g, separadorMiles);
}

// Da formato visual a una cantidad según el ajuste. Nunca se usa para
// calcular ni para exportar: solo para pintar inputs y tooltips.
//  - punto:        1,234.56
//  - coma:         1.234,56
//  - sin-decimales: 1,235
function formatearNumeroTabla(valor) {
    const numero = Number(valor);
    if (!Number.isFinite(numero)) return '';

    const formato = formatoNumerosActivo();

    if (formato === 'sin-decimales') {
        return agruparEntero(Math.round(numero), ',');
    }

    const [entero, decimal] = Math.abs(numero).toFixed(2).split('.');
    const signo = numero < 0 && Number(`${entero}.${decimal}`) !== 0 ? '-' : '';
    const separadorMiles = formato === 'coma' ? '.' : ',';
    const separadorDecimal = formato === 'coma' ? ',' : '.';

    return `${signo}${entero.replace(/\B(?=(\d{3})+(?!\d))/g, separadorMiles)}`
        + `${separadorDecimal}${decimal}`;
}

// Convierte el texto mostrado (con punto o coma) al número real. Acepta los
// tres formatos de la app y también valores pegados desde Excel. Devuelve NaN
// si no hay un número reconocible.
function parsearNumeroTabla(valor) {
    const texto = String(valor ?? '').trim();
    if (texto === '') return NaN;

    const limpio = texto.replace(/[^\d.,+-]/g, '');
    if (!limpio) return NaN;

    const tieneComa = limpio.includes(',');
    const tienePunto = limpio.includes('.');
    let normalizado = limpio;

    if (tieneComa && tienePunto) {
        // Con ambos separadores, el último es el decimal.
        normalizado = limpio.lastIndexOf(',') > limpio.lastIndexOf('.')
            ? limpio.replace(/\./g, '').replace(',', '.')
            : limpio.replace(/,/g, '');
    } else if (tieneComa) {
        // La coma es decimal en "coma"; en los demás formatos separa miles.
        normalizado = formatoNumerosActivo() === 'coma'
            ? limpio.replace(',', '.')
            : limpio.replace(/,/g, '');
    } else if (tienePunto && formatoNumerosActivo() === 'coma') {
        // En "coma" el punto solo puede ser separador de miles, salvo que
        // parezca un decimal tecleado a la inglesa ("1.5").
        const partes = limpio.split('.');
        const pareceMiles = partes.length > 2
            || (partes.length === 2 && partes[1].length === 3 && partes[0].length > 0);
        normalizado = pareceMiles ? limpio.replace(/\./g, '') : limpio;
    }

    const numero = Number.parseFloat(normalizado);
    return Number.isFinite(numero) ? numero : NaN;
}

function formatearCantidad(valor) {
    const texto = formatearNumeroTabla(valor);
    return texto === '' ? '0' : texto;
}

// Repinta Cantidad y Total de las filas ya dibujadas sin tocar los datos.
// Se usa al guardar/restablecer el formato y al previsualizarlo en el modal.
function reformatearCantidadesTabla() {
    const tbody = document.getElementById('tablaConsolidadaBody');
    if (!tbody) return;

    tbody.querySelectorAll('tr[data-id-fila]').forEach(fila => {
        const ingrediente = ingredientePorIdFila(fila.dataset.idFila);
        if (!ingrediente) return;

        const inputCantidad = fila.querySelector('.input-cantidad');
        if (inputCantidad) {
            inputCantidad.value = formatearCantidad(ingrediente.cantidad);
        }

        const inputTotal = fila.querySelector('.input-cantidad-total');
        if (inputTotal) {
            inputTotal.value = valorTotalTexto(ingrediente);
        }
    });
}

// Busca la fila de estado por su pk de color (nombre normalizado + unidad),
// que es el id estable que ya usa la tabla para los colores.
function ingredientePorIdFila(idFila) {
    if (!idFila) return null;
    return ingredientesConsolidados.find(ing => pkColorFila(ing) === idFila) || null;
}

function tituloInputCantidad(ingrediente) {
    if (ingrediente?.modificadoManualmente) {
        return `Cantidad modificada manualmente (original: ${formatearCantidad(ingrediente.cantidadOriginal)}). ` +
            'Clic derecho en la fila para restaurar.';
    }

    return 'Cantidad editable. Clic derecho en la fila para restaurar el valor original.';
}

function crearCeldaCantidad(item) {
    const td = document.createElement('td');
    td.className = 'celda-cantidad';

    // El ítem que llega tras "Calcular" viene de Rust y no trae las banderas
    // de edición: se consulta el estado en memoria por id de fila.
    const estado = ingredientePorIdFila(pkColorFila(item)) || item;

    const input = document.createElement('input');
    input.type = 'text';
    input.inputMode = 'decimal';
    input.autocomplete = 'off';
    input.className = 'input-cantidad';
    input.value = formatearCantidad(estado.cantidad);
    input.title = tituloInputCantidad(estado);

    if (estado.modificadoManualmente) {
        input.classList.add('modificada-manualmente');
    }

    td.appendChild(input);
    return td;
}

// --- EDICIÓN MANUAL DE LA CANTIDAD TOTAL ---
// La cantidad total es el resultado de `cantidad × proporción`. El usuario
// puede fijarla a mano (p. ej. "1 kg extra de queso"); mientras la bandera
// `totalModificadoManualmente` esté activa, ningún cálculo la sobrescribe.

// Mismo factor que usa `calcular_total` en Rust, pero calculado en JS para
// poder recalcular una sola fila sin repintar toda la tabla.
function factorCalculoActual() {
    const sumaProporciones = seccionesActuales.reduce(
        (total, seccion) => total + (Number(seccion?.proporcion) || 0),
        0
    );
    const sumaAlumnos = seccionesActuales.reduce(
        (total, seccion) => total + (Number(seccion?.alumnos) || 0),
        0
    );

    if (sumaProporciones > 0) return sumaProporciones / 100;
    if (sumaAlumnos > 0) return sumaAlumnos;
    return null;
}

// Factor efectivo guardado en la última fila calculada; si no existe, se usa
// el de las proporciones actuales del panel.
function factorConocido(ingrediente) {
    const guardado = ingrediente?.factorTotal;

    if (guardado !== undefined && guardado !== null) {
        const numero = Number(guardado);
        if (Number.isFinite(numero)) return numero;
    }

    return factorCalculoActual();
}

function valorTotalTexto(ingrediente) {
    const valor = ingrediente?.cantidad_total;
    if (valor === undefined || valor === null) return '';

    return formatearNumeroTabla(valor);
}

function tituloInputTotal(ingrediente) {
    return ingrediente?.totalModificadoManualmente
        ? 'Modificado manualmente'
        : 'Cantidad total editable. Clic derecho en la fila para restaurarla.';
}

function crearCeldaCantidadTotal(item) {
    const td = document.createElement('td');
    td.className = 'celda-cantidad-total';

    const estado = ingredientePorIdFila(pkColorFila(item)) || item;

    const input = document.createElement('input');
    input.type = 'text';
    input.inputMode = 'decimal';
    input.autocomplete = 'off';
    input.className = 'input-cantidad-total';
    input.placeholder = '—';

    input.value = estado.totalModificadoManualmente
        ? valorTotalTexto(estado)
        : (item.cantidad_total !== undefined ? valorTotalTexto(item) : '');
    input.title = tituloInputTotal(estado);

    if (estado.totalModificadoManualmente) {
        input.classList.add('total-modificado-manualmente');
    }

    td.appendChild(input);
    return td;
}

// Vuelca un valor manual de "Cantidad Total" al estado de la fila.
function aplicarTotalManual(input, { confirmar = false } = {}) {
    const fila = input.closest('tr');
    const ingrediente = ingredientePorIdFila(fila?.dataset.idFila);

    if (!ingrediente) return;

    const valor = parsearNumeroTabla(input.value);

    if (!Number.isFinite(valor)) {
        if (confirmar) {
            input.value = valorTotalTexto(ingrediente);
            input.title = tituloInputTotal(ingrediente);
        }
        return;
    }

    const anterior = Number(ingrediente.cantidad_total);

    // Sin cambio real no se marca como modificado.
    if (valor === anterior && !ingrediente.totalModificadoManualmente) return;

    ingrediente.cantidad_total = valor;
    ingrediente.totalModificadoManualmente = true;

    input.classList.add('total-modificado-manualmente');
    input.title = tituloInputTotal(ingrediente);
}

// Refresca todas las filas visibles con esa pk (la tabla puede estar duplicada).
function pintarTotalFila(ingrediente) {
    if (!ingrediente) return;

    const idFila = pkColorFila(ingrediente);

    document.querySelectorAll('#tablaConsolidadaBody tr[data-id-fila]').forEach(fila => {
        if (fila.dataset.idFila !== idFila) return;

        const input = fila.querySelector('.input-cantidad-total');
        if (!input) return;

        input.value = valorTotalTexto(ingrediente);
        input.classList.toggle(
            'total-modificado-manualmente',
            Boolean(ingrediente.totalModificadoManualmente)
        );
        input.title = tituloInputTotal(ingrediente);
    });
}

// Si cambia la cantidad base, un total fijado a mano deja de tener sentido:
// se descarta y vuelve a derivarse con el factor conocido. Los totales que no
// estaban fijados también se mantienen sincronizados.
function actualizarTotalTrasCambioCantidad(ingrediente) {
    const teniaTotalManual = Boolean(ingrediente?.totalModificadoManualmente);

    if (!ingrediente) return;

    if (teniaTotalManual) {
        ingrediente.totalModificadoManualmente = false;
    }

    // Sin un total previo y sin edición manual no hay nada que recalcular.
    if (!teniaTotalManual && ingrediente.cantidad_total === undefined) return;

    const factor = factorConocido(ingrediente);

    if (factor !== null && Number.isFinite(factor)) {
        ingrediente.cantidad_total = (Number(ingrediente.cantidad) || 0) * factor;
    } else if (teniaTotalManual) {
        delete ingrediente.cantidad_total;
    } else {
        return;
    }

    pintarTotalFila(ingrediente);
}

// Quita la fijación manual y recalcula el total con el factor vigente.
function restaurarTotalOriginal(idFila) {
    const ingrediente = ingredientePorIdFila(idFila);
    if (!ingrediente || !ingrediente.totalModificadoManualmente) return;

    ingrediente.totalModificadoManualmente = false;

    const factor = factorConocido(ingrediente);

    if (factor !== null && Number.isFinite(factor)) {
        ingrediente.cantidad_total = (Number(ingrediente.cantidad) || 0) * factor;
    } else {
        delete ingrediente.cantidad_total;
    }

    pintarTotalFila(ingrediente);
}

// Actualiza el estado en memoria con lo escrito en la celda. Con `confirmar`
// (evento change) se rechazan valores vacíos o inválidos devolviendo el último
// valor válido; durante la escritura (evento input) se ignoran sin molestar.
function aplicarCantidadManual(input, { confirmar = false } = {}) {
    const fila = input.closest('tr');
    const ingrediente = ingredientePorIdFila(fila?.dataset.idFila);

    if (!ingrediente) return;

    const valor = parsearNumeroTabla(input.value);

    if (!Number.isFinite(valor)) {
        if (confirmar) {
            input.value = formatearCantidad(ingrediente.cantidad);
            input.title = tituloInputCantidad(ingrediente);
        }
        return;
    }

    const valorAnterior = Number(ingrediente.cantidad) || 0;

    // Sin cambio real no se toca nada: la bandera nunca se activa por
    // renderizar la tabla ni por volver a pintar los inputs con su valor.
    if (valor === valorAnterior) return;

    // Red de seguridad: si la fila no pasó por el pintado inicial, el valor
    // anterior a la primera edición es la lectura original del Excel.
    if (ingrediente.cantidadOriginal === undefined) {
        ingrediente.cantidadOriginal = valorAnterior;
    }

    ingrediente.cantidad = valor;

    // Solo cuenta como edición manual una diferencia real frente al dato del
    // Excel: si el usuario vuelve a escribir el valor original, la fila deja
    // de considerarse modificada.
    ingrediente.modificadoManualmente =
        valor !== (Number(ingrediente.cantidadOriginal) || 0);

    // La cantidad base cambió: un total fijado a mano se descarta y se vuelve
    // a derivar (el total es una función de la cantidad, no un valor suelto).
    actualizarTotalTrasCambioCantidad(ingrediente);

    input.classList.toggle('modificada-manualmente', ingrediente.modificadoManualmente);
    input.title = tituloInputCantidad(ingrediente);
}

// Vuelve a la cantidad leída del Excel y quita la bandera de modificación.
function restaurarCantidadOriginal(idFila) {
    const ingrediente = ingredientePorIdFila(idFila);
    if (!ingrediente || !ingrediente.modificadoManualmente) return;

    ingrediente.cantidad = Number(ingrediente.cantidadOriginal) || 0;
    ingrediente.modificadoManualmente = false;

    // Restaurar la cantidad también devuelve el total a su valor derivado.
    actualizarTotalTrasCambioCantidad(ingrediente);

    // La tabla puede tener más de una fila con la misma pk.
    document.querySelectorAll('#tablaConsolidadaBody tr[data-id-fila]').forEach(fila => {
        if (fila.dataset.idFila !== idFila) return;

        const input = fila.querySelector('.input-cantidad');
        if (!input) return;

        input.value = formatearCantidad(ingrediente.cantidad);
        input.classList.remove('modificada-manualmente');
        input.title = tituloInputCantidad(ingrediente);
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
            <td class="celda-cantidad"></td>
            <td class="celda-cantidad-total"></td>
            <td>
                <input type="text" class="input-comentario" placeholder="Escribe un comentario..." style="width: 100%; border: 1px solid #ccc; border-radius: 4px; padding: 4px; font-size: 12px;">
            </td>
        `;
        tr.children[1].replaceWith(crearCeldaCodigo(item));
        tr.children[3].replaceWith(crearCeldaCantidad(item));
        tr.children[4].replaceWith(crearCeldaCantidadTotal(item));
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
        const estado = ingredientePorIdFila(pkColorFila(item));

        if (estado) {
            const base = Number(item.cantidad) || 0;

            // Factor efectivo del cálculo (cantidad -> total). Sirve para
            // recalcular el total si después cambia la cantidad base.
            estado.factorTotal = base > 0 ? item.cantidad_total / base : null;

            // Solo se sincroniza el total derivado si el usuario no lo fijó.
            if (!estado.totalModificadoManualmente) {
                estado.cantidad_total = item.cantidad_total;
            }
        }

        const tr = document.createElement('tr');
        tr.dataset.idFila = pkColorFila(item);
        tr.innerHTML = `
            <td><strong>${item.nombre}</strong></td>
            <td></td>
            <td>${item.unidad}</td>
            <td class="celda-cantidad"></td>
            <td class="celda-cantidad-total"></td>
            <td>
                <input type="text" class="input-comentario" placeholder="Escribe un comentario..." style="width: 100%; border: 1px solid #ccc; border-radius: 4px; padding: 4px; font-size: 12px;">
            </td>
        `;
        tr.children[1].replaceWith(crearCeldaCodigo(item));
        tr.children[3].replaceWith(crearCeldaCantidad(item));
        tr.children[4].replaceWith(crearCeldaCantidadTotal(item));
        tbody.appendChild(tr);
    });

    migrarColoresLegacy(datos);
    aplicarColoresGuardados(tbody);
    asegurarColoresCargados(tbody, datos);
}
