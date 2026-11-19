use serde::{Deserialize, Serialize};
use tauri::Manager;
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_store::StoreExt;

// Mismo store que el resto de la configuración de la app (config.json).
const STORE_CONFIG: &str = "config.json";

// Dos claves separadas: preferencias generales y reglas de lectura de Excel.
const CLAVE_AJUSTES: &str = "ajustes_procesamiento";
const CLAVE_MAPEO: &str = "mapeo_insumos";

/// Preferencias generales de la aplicación (pestañas "General" y
/// "Exportación"). No contiene ninguna regla de lectura de Excel: todo eso vive
/// en `MapeoInsumos`.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct AjustesProcesamiento {
    // --- Procesamiento general ---
    /// Espera (ms) antes de procesar automáticamente las hojas marcadas.
    pub delay_autoprocesado_ms: u64,

    // --- Interfaz ---
    /// Tema visual de la app: "claro" u "oscuro".
    pub tema: String,
    /// Formato de números: "punto", "coma" o "sin-decimales".
    pub formato_numeros: String,

    // --- Exportación ---
    /// ¿Se incluyen los colores de fila en la exportación?
    pub incluir_colores_exportacion: bool,
    /// Columnas elegidas para exportar (ids estables, no etiquetas).
    pub columnas_exportacion: Vec<String>,

    // --- Sistema ---
    /// Qué hacer con un ingrediente que no está en el diccionario:
    /// "omitir", "blanco" o "similitud".
    pub ingredientes_no_encontrados: String,
}

/// Columnas exportables por defecto. Los ids deben coincidir con los que usa
/// el frontend para armar los checkboxes.
fn columnas_exportacion_por_defecto() -> Vec<String> {
    ["ingrediente", "codigo", "unidad", "cantidad", "total", "comentarios"]
        .iter()
        .map(|id| (*id).to_string())
        .collect()
}

impl Default for AjustesProcesamiento {
    fn default() -> Self {
        Self {
            delay_autoprocesado_ms: 500,
            tema: "claro".to_string(),
            formato_numeros: "punto".to_string(),
            incluir_colores_exportacion: true,
            columnas_exportacion: columnas_exportacion_por_defecto(),
            ingredientes_no_encontrados: "omitir".to_string(),
        }
    }
}

/// Equivalencia de una unidad de medida: una forma estándar y todas las
/// variantes que deben unificarse a ella.
///
/// No convierte magnitudes (g ≠ kg): solo normaliza cómo se escribe la misma
/// unidad, para que "LT", "lts" y "litro" consolide en una sola fila.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct UnidadEquivalencia {
    pub estandar: String,
    pub variantes: Vec<String>,
}

/// Configuración segregada del tratamiento de Excel (pestaña
/// "Mapeo de Insumos"): sinónimos de columnas, normalización, filtros y
/// parámetros de cabecera.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct MapeoInsumos {
    /// Sinónimos aceptados para la columna de ingrediente.
    pub sinonimos_ingrediente: Vec<String>,
    /// Sinónimos aceptados para la columna de unidad.
    pub sinonimos_unidad: Vec<String>,
    /// Sinónimos aceptados para la columna de cantidad. Incluye las
    /// abreviaturas y variantes que antes vivían en listas separadas
    /// ("cant", "ctdad", "peso", "q"…).
    pub sinonimos_cantidad: Vec<String>,
    /// Sinónimos aceptados para la columna de cantidad total autoritativa.
    pub sinonimos_total: Vec<String>,
    /// Palabras que marcan una fila de datos que no es un ingrediente.
    pub palabras_fila_ignorada: Vec<String>,
    /// Equivalencias de unidades de medida (forma estándar + variantes).
    pub unidades: Vec<UnidadEquivalencia>,
    /// Filas de cabecera que se ignoran antes de leer los datos.
    pub filas_cabecera_ignoradas: u64,
    /// Cuántas filas se examinan buscando la fila de cabecera.
    pub filas_escaneo_cabecera: u64,
}

/// Equivalencias de unidades recomendadas. Solo unifican escrituras de la
/// misma unidad; no convierten entre magnitudes (g no se convierte a kg).
///
/// Se limitan a las unidades base que se usan en cocina: las medidas de
/// cuchara/taza/mililitro quedaron fuera para no ensuciar la tabla.
fn unidades_por_defecto() -> Vec<UnidadEquivalencia> {
    [
        ("Litro", vec!["litro", "litros", "lt", "lts", "l"]),
        (
            "Kilo",
            vec!["kilo", "kilos", "kg", "kgs", "kilogramo", "kilogramos"],
        ),
        ("Gramo", vec!["gramo", "gramos", "g", "gr", "grs"]),
        ("Unidad", vec!["unidad", "unidades", "un", "und", "u"]),
    ]
    .into_iter()
    .map(|(estandar, variantes)| UnidadEquivalencia {
        estandar: estandar.to_string(),
        variantes: variantes.into_iter().map(str::to_string).collect(),
    })
    .collect()
}

impl Default for MapeoInsumos {
    fn default() -> Self {
        Self {
            sinonimos_ingrediente: vec![
                "ingrediente".to_string(),
                "descripción".to_string(),
                "material".to_string(),
            ],
            sinonimos_unidad: vec!["u/m".to_string(), "um".to_string(), "unidad".to_string()],
            // Lista única de cantidad: los antiguos prefijos y etiquetas
            // parciales ahora son sinónimos normales.
            sinonimos_cantidad: [
                "cantidad",
                "cant.",
                "cant",
                "ctdad.",
                "ctdad",
                "peso",
                "q",
            ]
            .iter()
            .map(|sinonimo| (*sinonimo).to_string())
            .collect(),
            sinonimos_total: vec!["total".to_string(), "total cantidad".to_string()],
            palabras_fila_ignorada: vec!["material".to_string(), "descripción".to_string()],
            unidades: unidades_por_defecto(),
            filas_cabecera_ignoradas: 0,
            filas_escaneo_cabecera: 15,
        }
    }
}

impl MapeoInsumos {
    /// Rellena con los valores recomendados las listas de detección que una
    /// configuración heredada dejó vacías. No toca las listas que ya tienen
    /// contenido: respeta cualquier sinónimo que el usuario hubiera escrito.
    fn completar_listas_heredadas(&mut self) {
        let defecto = Self::default();

        if self.sinonimos_ingrediente.is_empty() {
            self.sinonimos_ingrediente = defecto.sinonimos_ingrediente;
        }
        if self.sinonimos_unidad.is_empty() {
            self.sinonimos_unidad = defecto.sinonimos_unidad;
        }
        if self.sinonimos_cantidad.is_empty() {
            self.sinonimos_cantidad = defecto.sinonimos_cantidad;
        }
        if self.sinonimos_total.is_empty() {
            self.sinonimos_total = defecto.sinonimos_total;
        }
        if self.palabras_fila_ignorada.is_empty() {
            self.palabras_fila_ignorada = defecto.palabras_fila_ignorada;
        }
        if self.filas_escaneo_cabecera == 0 {
            self.filas_escaneo_cabecera = defecto.filas_escaneo_cabecera;
        }
    }
}

/// Lee una lista de strings de un JSON, si la clave existe y es un array.
fn lista_de_valor(valor: &serde_json::Value, clave: &str) -> Option<Vec<String>> {
    valor.get(clave).and_then(|valor| valor.as_array()).map(|lista| {
        lista
            .iter()
            .filter_map(|item| item.as_str().map(str::to_string))
            .collect()
    })
}

/// Clave para comparar sinónimos de cantidad sin duplicar la misma abreviatura
/// escrita con o sin punto ("cant" y "cant.").
fn clave_sinonimo_cantidad(valor: &str) -> String {
    valor
        .trim()
        .to_lowercase()
        .trim_end_matches(|c: char| matches!(c, '.' | ',' | ';' | ':'))
        .to_string()
}

/// Agrega sinónimos de cantidad sin duplicar los que ya existen.
fn unir_sinonimos_cantidad(destino: &mut Vec<String>, extra: &[String]) {
    for valor in extra {
        let limpio = valor.trim();
        if limpio.is_empty() {
            continue;
        }

        let clave = clave_sinonimo_cantidad(limpio);
        let ya_existe = destino
            .iter()
            .any(|existente| clave_sinonimo_cantidad(existente) == clave);

        if !ya_existe {
            destino.push(limpio.to_string());
        }
    }
}

/// Convierte el JSON guardado bajo `mapeo_insumos` en la estructura actual.
/// Un JSON incompleto completa cada campo con su valor por defecto.
fn mapeo_desde_valor(valor: serde_json::Value) -> MapeoInsumos {
    let es_heredado = valor.get("sinonimosTotal").is_none();
    // Un mapeo guardado antes de existir la tabla de unidades no trae la clave:
    // se rellena con las equivalencias recomendadas. Un array vacío explícito
    // sí se respeta (el usuario decidió no unificar nada).
    let sin_unidades = valor.get("unidades").is_none();
    // Versión anterior a la lista única de cantidad: los prefijos vivían en su
    // propia clave. Se conservan como sinónimos para no perder esa detección.
    let prefijos_antiguos = lista_de_valor(&valor, "prefijosCantidad");

    let mut mapeo: MapeoInsumos = serde_json::from_value(valor).unwrap_or_default();

    if sin_unidades {
        mapeo.unidades = unidades_por_defecto();
    }

    if es_heredado {
        mapeo.completar_listas_heredadas();
    }

    if let Some(prefijos) = prefijos_antiguos {
        unir_sinonimos_cantidad(&mut mapeo.sinonimos_cantidad, &prefijos);
        // La lista unificada también incorpora las abreviaturas recomendadas
        // que antes no existían en esta versión.
        unir_sinonimos_cantidad(
            &mut mapeo.sinonimos_cantidad,
            &MapeoInsumos::default().sinonimos_cantidad,
        );
    }

    mapeo
}

/// Copia una lista de strings del JSON anterior si tiene contenido.
fn copiar_lista_heredada(valor: &serde_json::Value, clave: &str, destino: &mut Vec<String>) {
    let Some(lista) = valor.get(clave).and_then(|valor| valor.as_array()) else {
        return;
    };

    let valores: Vec<String> = lista
        .iter()
        .filter_map(|item| item.as_str().map(|texto| texto.to_string()))
        .collect();

    if !valores.is_empty() {
        *destino = valores;
    }
}

/// Migra la configuración plana que guardaba la versión anterior dentro de
/// `ajustes_procesamiento` (sinónimos, filtros y filas).
fn mapeo_desde_legado(valor: &serde_json::Value) -> MapeoInsumos {
    let mut mapeo = MapeoInsumos::default();

    copiar_lista_heredada(
        valor,
        "sinonimosIngrediente",
        &mut mapeo.sinonimos_ingrediente,
    );
    copiar_lista_heredada(valor, "sinonimosUnidad", &mut mapeo.sinonimos_unidad);
    copiar_lista_heredada(valor, "sinonimosCantidad", &mut mapeo.sinonimos_cantidad);
    copiar_lista_heredada(valor, "sinonimosTotal", &mut mapeo.sinonimos_total);
    copiar_lista_heredada(
        valor,
        "palabrasFilaIgnorada",
        &mut mapeo.palabras_fila_ignorada,
    );

    // Los prefijos de cantidad de la versión antigua se suman a la lista
    // única, junto con las abreviaturas recomendadas actuales.
    if let Some(prefijos) = lista_de_valor(valor, "prefijosCantidad") {
        unir_sinonimos_cantidad(&mut mapeo.sinonimos_cantidad, &prefijos);
    }
    unir_sinonimos_cantidad(
        &mut mapeo.sinonimos_cantidad,
        &MapeoInsumos::default().sinonimos_cantidad,
    );

    if let Some(filas) = valor.get("filasCabeceraIgnoradas").and_then(|v| v.as_u64()) {
        mapeo.filas_cabecera_ignoradas = filas;
    }

    if let Some(filas) = valor.get("filasEscaneoCabecera").and_then(|v| v.as_u64()) {
        mapeo.filas_escaneo_cabecera = filas;
    }

    mapeo
}

/// Devuelve los ajustes generales guardados o los valores por defecto si
/// todavía no existe configuración (primer arranque).
#[tauri::command]
pub fn obtener_ajustes_procesamiento(
    app: tauri::AppHandle,
) -> Result<AjustesProcesamiento, String> {
    let store = app.store(STORE_CONFIG).map_err(|e| e.to_string())?;

    let Some(valor) = store.get(CLAVE_AJUSTES) else {
        return Ok(AjustesProcesamiento::default());
    };

    // Un JSON viejo o incompleto no debe romper el arranque: los campos
    // desconocidos (las antiguas reglas de Excel) se ignoran y cada campo
    // faltante cae en los valores por defecto.
    let ajustes: AjustesProcesamiento =
        serde_json::from_value(valor.clone()).unwrap_or_default();

    // Si el Store todavía arrastra claves obsoletas (reglas de Excel de la
    // versión anterior), se reescribe con la estructura actual.
    if let Ok(limpio) = serde_json::to_value(&ajustes) {
        if limpio != valor {
            store.set(CLAVE_AJUSTES, limpio);
            let _ = store.save();
        }
    }

    Ok(ajustes)
}

/// Guarda los ajustes generales en config.json.
#[tauri::command]
pub fn guardar_ajustes_procesamiento(
    app: tauri::AppHandle,
    ajustes: AjustesProcesamiento,
) -> Result<(), String> {
    let store = app.store(STORE_CONFIG).map_err(|e| e.to_string())?;
    let valor = serde_json::to_value(&ajustes).map_err(|e| e.to_string())?;

    store.set(CLAVE_AJUSTES, valor);
    store.save().map_err(|e| e.to_string())?;
    Ok(())
}

/// Devuelve la configuración de mapeo de Excel.
///
/// Si todavía no existe la clave `mapeo_insumos`, migra las reglas que la
/// versión anterior guardaba dentro de `ajustes_procesamiento` y persiste el
/// resultado, para que la nueva estructura quede aislada desde el primer
/// arranque.
#[tauri::command]
pub fn obtener_mapeo_insumos(app: tauri::AppHandle) -> Result<MapeoInsumos, String> {
    let store = app.store(STORE_CONFIG).map_err(|e| e.to_string())?;

    if let Some(valor) = store.get(CLAVE_MAPEO) {
        let mapeo = mapeo_desde_valor(valor.clone());

        // Reescribe el Store si el JSON guardado trae claves que ya no existen
        // (etiquetas parciales, prefijos, palabras monetarias, asociaciones o
        // unidad por defecto) o si la migración cambió algún valor.
        if let Ok(limpio) = serde_json::to_value(&mapeo) {
            if limpio != valor {
                store.set(CLAVE_MAPEO, limpio);
                let _ = store.save();
            }
        }

        return Ok(mapeo);
    }

    let mapeo = store
        .get(CLAVE_AJUSTES)
        .map(|valor| mapeo_desde_legado(&valor))
        .unwrap_or_default();

    // Persistir la migración: si después se guardan los ajustes generales, el
    // JSON viejo pierde las reglas y no queremos depender de él.
    if let Ok(valor) = serde_json::to_value(&mapeo) {
        store.set(CLAVE_MAPEO, valor);
        let _ = store.save();
    }

    Ok(mapeo)
}

/// Guarda la configuración de mapeo de Excel en config.json.
#[tauri::command]
pub fn guardar_mapeo_insumos(
    app: tauri::AppHandle,
    mapeo: MapeoInsumos,
) -> Result<(), String> {
    let store = app.store(STORE_CONFIG).map_err(|e| e.to_string())?;
    let valor = serde_json::to_value(&mapeo).map_err(|e| e.to_string())?;

    store.set(CLAVE_MAPEO, valor);
    store.save().map_err(|e| e.to_string())?;
    Ok(())
}

/// Abre en el explorador la carpeta donde vive config.json (app_data_dir,
/// que en Windows está dentro de %APPDATA%).
#[tauri::command]
pub fn abrir_carpeta_datos(app: tauri::AppHandle) -> Result<(), String> {
    let carpeta = app.path().app_data_dir().map_err(|e| e.to_string())?;

    // Puede no existir antes del primer guardado: la creamos para que el
    // explorador no falle al abrirla.
    std::fs::create_dir_all(&carpeta).map_err(|e| e.to_string())?;

    app.opener()
        .open_path(carpeta.to_string_lossy().to_string(), None::<String>)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ajustes_generales_por_defecto() {
        let ajustes = AjustesProcesamiento::default();

        assert_eq!(ajustes.delay_autoprocesado_ms, 500);
        assert_eq!(ajustes.tema, "claro");
        assert_eq!(ajustes.formato_numeros, "punto");
        assert!(ajustes.incluir_colores_exportacion);
        assert_eq!(ajustes.columnas_exportacion.len(), 6);
        assert_eq!(ajustes.ingredientes_no_encontrados, "omitir");
    }

    #[test]
    fn mapeo_por_defecto_reproduce_las_reglas_historicas() {
        let mapeo = MapeoInsumos::default();

        assert!(mapeo.sinonimos_ingrediente.contains(&"ingrediente".to_string()));
        assert!(mapeo.sinonimos_unidad.contains(&"unidad".to_string()));

        // Una sola lista de cantidad: incluye las abreviaturas que antes
        // estaban repartidas entre prefijos y etiquetas.
        for sinonimo in ["cantidad", "cant", "ctdad", "peso", "q"] {
            assert!(
                mapeo.sinonimos_cantidad.contains(&sinonimo.to_string()),
                "falta el sinónimo de cantidad {sinonimo:?}"
            );
        }

        assert_eq!(mapeo.sinonimos_total, vec!["total", "total cantidad"]);
        assert_eq!(mapeo.palabras_fila_ignorada.len(), 2);
        assert_eq!(mapeo.unidades.len(), 4);
        let litro = mapeo
            .unidades
            .iter()
            .find(|unidad| unidad.estandar == "Litro")
            .expect("debe existir la equivalencia de litro");
        assert!(litro.variantes.contains(&"lt".to_string()));
        assert!(litro.variantes.contains(&"lts".to_string()));
        assert_eq!(mapeo.filas_cabecera_ignoradas, 0);
        assert_eq!(mapeo.filas_escaneo_cabecera, 15);
    }

    #[test]
    fn json_incompleto_de_ajustes_completa_con_defaults() {
        let valor = serde_json::json!({ "delayAutoprocesadoMs": 250 });
        let ajustes: AjustesProcesamiento =
            serde_json::from_value(valor).expect("el JSON parcial debe ser válido");

        assert_eq!(ajustes.delay_autoprocesado_ms, 250);
        assert_eq!(ajustes.tema, "claro");
        assert!(ajustes.incluir_colores_exportacion);
        assert_eq!(ajustes.columnas_exportacion.len(), 6);
    }

    #[test]
    fn ignora_las_antiguas_claves_de_excel_en_los_ajustes_generales() {
        let valor = serde_json::json!({
            "tema": "oscuro",
            "sinonimosIngrediente": ["producto"],
            "filasCabeceraIgnoradas": 2,
            "unidadPorDefecto": "KILO"
        });

        let ajustes: AjustesProcesamiento =
            serde_json::from_value(valor).expect("el JSON debe ser válido");

        assert_eq!(ajustes.tema, "oscuro");
        assert_eq!(ajustes.delay_autoprocesado_ms, 500);
    }

    #[test]
    fn serializa_con_claves_camel_case() {
        let ajustes = serde_json::to_value(AjustesProcesamiento::default())
            .expect("los ajustes deben serializar");
        assert_eq!(ajustes["delayAutoprocesadoMs"], serde_json::json!(500));
        assert!(ajustes.get("tema").is_some());
        assert!(ajustes.get("formatoNumeros").is_some());
        assert!(ajustes.get("incluirColoresExportacion").is_some());
        assert!(ajustes.get("columnasExportacion").is_some());
        assert!(ajustes.get("ingredientesNoEncontrados").is_some());
        // El prefijo de exportación se eliminó: no debe volver al Store.
        assert!(ajustes.get("prefijoExportacion").is_none());
        assert!(ajustes.get("sinonimosIngrediente").is_none());

        let mapeo = serde_json::to_value(MapeoInsumos::default())
            .expect("el mapeo debe serializar");
        assert!(mapeo.get("sinonimosIngrediente").is_some());
        assert!(mapeo.get("sinonimosCantidad").is_some());
        assert!(mapeo.get("sinonimosTotal").is_some());
        assert!(mapeo.get("palabrasFilaIgnorada").is_some());
        assert!(mapeo.get("unidades").is_some());
        assert!(mapeo.get("filasCabeceraIgnoradas").is_some());
        assert!(mapeo.get("filasEscaneoCabecera").is_some());

        // Las claves de la versión anterior ya no se guardan.
        for obsoleta in [
            "etiquetasCantidadParcial",
            "prefijosCantidad",
            "palabrasMonetarias",
            "asociacionesIngredientes",
            "unidadPorDefecto",
        ] {
            assert!(
                mapeo.get(obsoleta).is_none(),
                "no debe guardarse la clave obsoleta {obsoleta:?}"
            );
        }
    }

    #[test]
    fn conserva_valores_no_predeterminados() {
        let valor = serde_json::json!({
            "tema": "oscuro",
            "formatoNumeros": "coma",
            "incluirColoresExportacion": false,
            "columnasExportacion": ["ingrediente", "total"],
            "ingredientesNoEncontrados": "similitud"
        });

        let ajustes: AjustesProcesamiento =
            serde_json::from_value(valor).expect("el JSON debe ser válido");

        assert_eq!(ajustes.tema, "oscuro");
        assert_eq!(ajustes.formato_numeros, "coma");
        assert!(!ajustes.incluir_colores_exportacion);
        assert_eq!(ajustes.columnas_exportacion, vec!["ingrediente", "total"]);
        assert_eq!(ajustes.ingredientes_no_encontrados, "similitud");
    }

    #[test]
    fn migra_las_reglas_planas_de_la_version_anterior() {
        // Forma exacta del `ajustes_procesamiento` antiguo.
        let legado = serde_json::json!({
            "sinonimosIngrediente": ["producto"],
            "sinonimosUnidad": [],
            "sinonimosCantidad": [],
            "prefijosCantidad": ["qty"],
            "filasCabeceraIgnoradas": 2,
            "unidadPorDefecto": "KILO",
            "delayAutoprocesadoMs": 500
        });

        let mapeo = mapeo_desde_legado(&legado);
        let defecto = MapeoInsumos::default();

        // Se conserva lo personalizado.
        assert_eq!(mapeo.sinonimos_ingrediente, vec!["producto"]);
        assert_eq!(mapeo.filas_cabecera_ignoradas, 2);

        // Las listas vacías del formato viejo se completan y los prefijos
        // antiguos pasan a la lista única de cantidad.
        assert_eq!(mapeo.sinonimos_unidad, defecto.sinonimos_unidad);
        assert_eq!(mapeo.sinonimos_total, defecto.sinonimos_total);
        assert!(mapeo.sinonimos_cantidad.contains(&"qty".to_string()));
        assert!(mapeo.sinonimos_cantidad.contains(&"cantidad".to_string()));
    }

    #[test]
    fn migra_desde_un_mapeo_nuevo_incompleto() {
        let valor = serde_json::json!({
            "sinonimosIngrediente": ["producto"],
            "sinonimosUnidad": [],
            "sinonimosCantidad": []
        });

        let mapeo = mapeo_desde_valor(valor);
        let defecto = MapeoInsumos::default();

        assert_eq!(mapeo.sinonimos_ingrediente, vec!["producto"]);
        assert_eq!(mapeo.sinonimos_unidad, defecto.sinonimos_unidad);
        assert_eq!(mapeo.sinonimos_total, defecto.sinonimos_total);
    }

    #[test]
    fn una_config_nueva_respeta_las_listas_vacias_intencionales() {
        let valor = serde_json::json!({
            "sinonimosTotal": [],
            "sinonimosCantidad": []
        });

        let mapeo = mapeo_desde_valor(valor);

        assert!(mapeo.sinonimos_total.is_empty());
        assert!(mapeo.sinonimos_cantidad.is_empty());
    }

    #[test]
    fn migra_los_prefijos_antiguos_a_la_lista_unica_de_cantidad() {
        let valor = serde_json::json!({
            "sinonimosCantidad": ["cantidad"],
            "sinonimosTotal": ["total"],
            "prefijosCantidad": ["qty", "cant."],
            "etiquetasCantidadParcial": ["a", "b"],
            "palabrasMonetarias": ["costo"],
            "asociacionesIngredientes": [
                { "alias": "azucar", "nombre": "Azúcar" }
            ],
            "unidadPorDefecto": "KILO"
        });

        let mapeo = mapeo_desde_valor(valor);

        for sinonimo in ["cantidad", "qty", "cant.", "peso", "q"] {
            assert!(
                mapeo.sinonimos_cantidad.contains(&sinonimo.to_string()),
                "falta el sinónimo migrado {sinonimo:?}"
            );
        }

        // Al guardar de nuevo, las claves eliminadas desaparecen del Store.
        let limpio = serde_json::to_value(&mapeo).expect("el mapeo debe serializar");
        for obsoleta in [
            "etiquetasCantidadParcial",
            "prefijosCantidad",
            "palabrasMonetarias",
            "asociacionesIngredientes",
            "unidadPorDefecto",
        ] {
            assert!(limpio.get(obsoleta).is_none(), "quedó {obsoleta:?}");
        }
    }

    #[test]
    fn un_mapeo_sin_unidades_recibe_las_equivalencias_recomendadas() {
        // Configuración guardada por la versión anterior a esta función.
        let valor = serde_json::json!({
            "sinonimosIngrediente": ["producto"],
            "sinonimosUnidad": ["medida"],
            "sinonimosCantidad": ["qty"],
            "sinonimosTotal": ["total"]
        });

        let mapeo = mapeo_desde_valor(valor);

        assert_eq!(mapeo.unidades, unidades_por_defecto());
    }

    #[test]
    fn respeta_una_tabla_de_unidades_vacia() {
        let valor = serde_json::json!({
            "sinonimosTotal": ["total"],
            "unidades": []
        });

        let mapeo = mapeo_desde_valor(valor);

        assert!(mapeo.unidades.is_empty());
    }

    #[test]
    fn serializa_equivalencias_de_unidades() {
        let mapeo = MapeoInsumos::default();
        let valor = serde_json::to_value(&mapeo).expect("el mapeo debe serializar");

        assert_eq!(
            valor["unidades"][0]["estandar"],
            serde_json::json!("Litro")
        );
        assert!(valor["unidades"][0]["variantes"]
            .as_array()
            .is_some_and(|variantes| variantes.contains(&serde_json::json!("lt"))));

        let vuelta: MapeoInsumos =
            serde_json::from_value(valor).expect("debe deserializar de vuelta");
        assert_eq!(vuelta.unidades, mapeo.unidades);
    }
}
