use serde::{Deserialize, Serialize};
use tauri::Manager;
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_store::StoreExt;

// Mismo store que el resto de la configuración de la app (config.json).
const STORE_CONFIG: &str = "config.json";
const CLAVE_AJUSTES: &str = "ajustes_procesamiento";

/// Preferencias que el usuario configura desde el modal "Ajustes de
/// Procesamiento". Por ahora solo se persisten: ninguna regla de cálculo,
/// tema ni exportación las consume todavía.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct AjustesProcesamiento {
    // --- Procesamiento ---
    /// Espera (ms) antes de procesar automáticamente las hojas marcadas.
    pub delay_autoprocesado_ms: u64,
    /// Sinónimos aceptados para la columna de ingrediente.
    pub sinonimos_ingrediente: Vec<String>,
    /// Sinónimos aceptados para la columna de unidad.
    pub sinonimos_unidad: Vec<String>,
    /// Sinónimos aceptados para la columna de cantidad.
    pub sinonimos_cantidad: Vec<String>,
    /// Filas de cabecera que se ignoran antes de leer los datos.
    pub filas_cabecera_ignoradas: u64,
    /// Unidad aplicada cuando el archivo no indica una.
    pub unidad_por_defecto: String,

    // --- Interfaz ---
    /// Tema visual de la app: "claro" u "oscuro".
    pub tema: String,
    /// Formato de números: "punto", "coma" o "sin-decimales".
    pub formato_numeros: String,

    // --- Exportación ---
    /// Prefijo del nombre de archivo sugerido al exportar.
    pub prefijo_exportacion: String,
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
            sinonimos_ingrediente: Vec::new(),
            sinonimos_unidad: Vec::new(),
            sinonimos_cantidad: Vec::new(),
            filas_cabecera_ignoradas: 0,
            unidad_por_defecto: "UNIDAD".to_string(),
            tema: "claro".to_string(),
            formato_numeros: "punto".to_string(),
            prefijo_exportacion: "Resumen_".to_string(),
            incluir_colores_exportacion: true,
            columnas_exportacion: columnas_exportacion_por_defecto(),
            ingredientes_no_encontrados: "omitir".to_string(),
        }
    }
}

/// Devuelve los ajustes guardados o los valores por defecto si todavía no
/// existe configuración (primer arranque).
#[tauri::command]
pub fn obtener_ajustes_procesamiento(
    app: tauri::AppHandle,
) -> Result<AjustesProcesamiento, String> {
    let store = app.store(STORE_CONFIG).map_err(|e| e.to_string())?;

    let Some(valor) = store.get(CLAVE_AJUSTES) else {
        return Ok(AjustesProcesamiento::default());
    };

    // Un JSON viejo o incompleto no debe romper el arranque: cada campo
    // faltante cae en los valores por defecto del struct.
    Ok(serde_json::from_value(valor).unwrap_or_default())
}

/// Guarda los ajustes en config.json para que sobrevivan al reinicio.
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
    fn valores_por_defecto_razonables() {
        let ajustes = AjustesProcesamiento::default();

        assert_eq!(ajustes.delay_autoprocesado_ms, 500);
        assert!(ajustes.sinonimos_ingrediente.is_empty());
        assert!(ajustes.sinonimos_unidad.is_empty());
        assert!(ajustes.sinonimos_cantidad.is_empty());
        assert_eq!(ajustes.filas_cabecera_ignoradas, 0);
        assert_eq!(ajustes.unidad_por_defecto, "UNIDAD");
        assert_eq!(ajustes.tema, "claro");
        assert_eq!(ajustes.formato_numeros, "punto");
        assert_eq!(ajustes.prefijo_exportacion, "Resumen_");
        assert!(ajustes.incluir_colores_exportacion);
        assert_eq!(ajustes.columnas_exportacion.len(), 6);
        assert_eq!(ajustes.ingredientes_no_encontrados, "omitir");
    }

    #[test]
    fn json_incompleto_completa_con_defaults() {
        let valor = serde_json::json!({ "delayAutoprocesadoMs": 250 });
        let ajustes: AjustesProcesamiento =
            serde_json::from_value(valor).expect("el JSON parcial debe ser válido");

        assert_eq!(ajustes.delay_autoprocesado_ms, 250);
        assert!(ajustes.sinonimos_cantidad.is_empty());
        assert_eq!(ajustes.filas_cabecera_ignoradas, 0);
        assert_eq!(ajustes.unidad_por_defecto, "UNIDAD");
        assert_eq!(ajustes.tema, "claro");
        assert!(ajustes.incluir_colores_exportacion);
        assert_eq!(ajustes.columnas_exportacion.len(), 6);
    }

    #[test]
    fn serializa_con_claves_camel_case() {
        let valor = serde_json::to_value(AjustesProcesamiento::default())
            .expect("los ajustes deben serializar");

        assert_eq!(valor["delayAutoprocesadoMs"], serde_json::json!(500));
        assert!(valor.get("sinonimosIngrediente").is_some());
        assert!(valor.get("sinonimosUnidad").is_some());
        assert!(valor.get("sinonimosCantidad").is_some());
        assert!(valor.get("filasCabeceraIgnoradas").is_some());
        assert!(valor.get("unidadPorDefecto").is_some());
        assert!(valor.get("tema").is_some());
        assert!(valor.get("formatoNumeros").is_some());
        assert!(valor.get("prefijoExportacion").is_some());
        assert!(valor.get("incluirColoresExportacion").is_some());
        assert!(valor.get("columnasExportacion").is_some());
        assert!(valor.get("ingredientesNoEncontrados").is_some());
    }

    #[test]
    fn conserva_valores_no_predeterminados() {
        let valor = serde_json::json!({
            "filasCabeceraIgnoradas": 2,
            "unidadPorDefecto": "KILO",
            "tema": "oscuro",
            "formatoNumeros": "coma",
            "prefijoExportacion": "Informe_",
            "incluirColoresExportacion": false,
            "columnasExportacion": ["ingrediente", "total"],
            "ingredientesNoEncontrados": "similitud"
        });

        let ajustes: AjustesProcesamiento =
            serde_json::from_value(valor).expect("el JSON debe ser válido");

        assert_eq!(ajustes.filas_cabecera_ignoradas, 2);
        assert_eq!(ajustes.unidad_por_defecto, "KILO");
        assert_eq!(ajustes.tema, "oscuro");
        assert_eq!(ajustes.formato_numeros, "coma");
        assert_eq!(ajustes.prefijo_exportacion, "Informe_");
        assert!(!ajustes.incluir_colores_exportacion);
        assert_eq!(ajustes.columnas_exportacion, vec!["ingrediente", "total"]);
        assert_eq!(ajustes.ingredientes_no_encontrados, "similitud");
    }
}
