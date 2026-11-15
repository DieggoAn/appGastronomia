use std::collections::HashMap;
use tauri_plugin_store::StoreExt;

// Reutilizamos el mismo store que la ruta del diccionario: son pocos datos
// y así toda la configuración de la app queda en un único archivo.
const STORE_CONFIG: &str = "config.json";
const CLAVE_COLORES: &str = "colores_filas";
const CLAVE_VERSION: &str = "colores_filas_version";

// Esquema de claves de colores (la constante vive en JS: SCHEMA_VERSION_COLORES):
// v1: clave = solo nombre normalizado (o "nombre|unidad" en versiones intermedias).
// v2: clave = "nombre_normalizado::unidad_normalizada".

/// Devuelve el mapa { clave_fila: id_color } guardado en disco.
/// Si no hay nada guardado o el contenido no es válido, devuelve un mapa vacío.
#[tauri::command]
pub fn obtener_colores_filas(
    app: tauri::AppHandle,
) -> Result<HashMap<String, String>, String> {
    let store = app.store(STORE_CONFIG).map_err(|e| e.to_string())?;

    let Some(valor) = store.get(CLAVE_COLORES) else {
        return Ok(HashMap::new());
    };

    let colores =
        serde_json::from_value::<HashMap<String, String>>(valor).unwrap_or_default();

    Ok(colores)
}

/// Guarda el mapa completo de colores. El estado en JS es la fuente de verdad,
/// así que se sobrescribe entero (también sirve para limpiar filas huérfanas).
#[tauri::command]
pub fn guardar_colores_filas(
    app: tauri::AppHandle,
    colores: HashMap<String, String>,
) -> Result<(), String> {
    let store = app.store(STORE_CONFIG).map_err(|e| e.to_string())?;

    if colores.is_empty() {
        store.delete(CLAVE_COLORES);
    } else {
        let valor = serde_json::to_value(colores).map_err(|e| e.to_string())?;
        store.set(CLAVE_COLORES, valor);
    }

    store.save().map_err(|e| e.to_string())?;
    Ok(())
}

/// Versión del esquema de claves guardada en el store (0 si nunca se guardó).
#[tauri::command]
pub fn obtener_version_colores_filas(app: tauri::AppHandle) -> Result<u32, String> {
    let store = app.store(STORE_CONFIG).map_err(|e| e.to_string())?;

    Ok(store
        .get(CLAVE_VERSION)
        .and_then(|valor| valor.as_u64())
        .map(|v| v as u32)
        .unwrap_or(0))
}

/// Marca la versión del esquema para que la migración no se repita.
#[tauri::command]
pub fn guardar_version_colores_filas(
    app: tauri::AppHandle,
    version: u32,
) -> Result<(), String> {
    let store = app.store(STORE_CONFIG).map_err(|e| e.to_string())?;

    store.set(CLAVE_VERSION, serde_json::json!(version));
    store.save().map_err(|e| e.to_string())?;
    Ok(())
}
