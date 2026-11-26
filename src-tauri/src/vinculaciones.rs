use std::collections::HashMap;
use tauri_plugin_store::StoreExt;

// Las vinculaciones viven en el mismo store que los colores y la ruta del
// diccionario: son pocos datos y así toda la configuración queda en un archivo.
const STORE_CONFIG: &str = "config.json";

/// Estructura vigente: { ruta_archivo: { nombre_hoja: [nombres_de_grupo] } }.
/// Cada hoja de un Excel se vincula de forma independiente; no existe ya una
/// vinculación a nivel de archivo.
const CLAVE_VINCULACIONES_HOJAS: &str = "vinculaciones_hojas_grupos";

/// Estructura antigua: { ruta_archivo: [nombres_de_grupo] }. Solo se conserva
/// para que el frontend pueda migrarla, porque es el único que conoce los
/// nombres de hoja de cada archivo.
const CLAVE_VINCULACIONES_LEGACY: &str = "vinculaciones_archivos_grupos";

pub type VinculacionesHojas = HashMap<String, HashMap<String, Vec<String>>>;
pub type VinculacionesLegacy = HashMap<String, Vec<String>>;

/// Resultado de la carga: los datos nuevos y, si existen, los antiguos para
/// que el frontend los distribuya entre las hojas del archivo.
#[derive(serde::Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct VinculacionesCargadas {
    pub hojas: VinculacionesHojas,
    pub legacy_archivos: VinculacionesLegacy,
}

/// Devuelve el mapa hoja → grupo guardado en disco. Si no hay nada guardado o
/// el contenido no es válido, devuelve estructuras vacías.
#[tauri::command]
pub fn obtener_vinculaciones(
    app: tauri::AppHandle,
) -> Result<VinculacionesCargadas, String> {
    let store = app.store(STORE_CONFIG).map_err(|e| e.to_string())?;

    let hojas = store
        .get(CLAVE_VINCULACIONES_HOJAS)
        .and_then(|valor| serde_json::from_value::<VinculacionesHojas>(valor).ok())
        .unwrap_or_default();

    let legacy_archivos = store
        .get(CLAVE_VINCULACIONES_LEGACY)
        .and_then(|valor| serde_json::from_value::<VinculacionesLegacy>(valor).ok())
        .unwrap_or_default();

    Ok(VinculacionesCargadas {
        hojas,
        legacy_archivos,
    })
}

/// Guarda el mapa completo de vinculaciones hoja → grupo. El estado en JS es la
/// fuente de verdad, así que se sobrescribe entero. Un mapa vacío elimina la
/// clave.
#[tauri::command]
pub fn guardar_vinculaciones(
    app: tauri::AppHandle,
    vinculaciones: VinculacionesHojas,
) -> Result<(), String> {
    let store = app.store(STORE_CONFIG).map_err(|e| e.to_string())?;

    if vinculaciones.is_empty() {
        store.delete(CLAVE_VINCULACIONES_HOJAS);
    } else {
        let valor = serde_json::to_value(vinculaciones).map_err(|e| e.to_string())?;
        store.set(CLAVE_VINCULACIONES_HOJAS, valor);
    }

    store.save().map_err(|e| e.to_string())?;
    Ok(())
}

/// Elimina la estructura antigua una vez que el frontend la distribuyó entre
/// las hojas. Es idempotente: si ya no existe, no hace nada.
#[tauri::command]
pub fn descartar_vinculaciones_legacy(app: tauri::AppHandle) -> Result<(), String> {
    let store = app.store(STORE_CONFIG).map_err(|e| e.to_string())?;

    if store.get(CLAVE_VINCULACIONES_LEGACY).is_some() {
        store.delete(CLAVE_VINCULACIONES_LEGACY);
        store.save().map_err(|e| e.to_string())?;
    }

    Ok(())
}
