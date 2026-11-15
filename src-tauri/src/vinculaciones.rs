use std::collections::HashMap;
use tauri_plugin_store::StoreExt;

// Las vinculaciones viven en el mismo store que los colores y la ruta del
// diccionario: son pocos datos y así toda la configuración queda en un archivo.
const STORE_CONFIG: &str = "config.json";
const CLAVE_VINCULACIONES: &str = "vinculaciones_archivos_grupos";

/// Devuelve el mapa { ruta_archivo: [nombres_de_grupo] } guardado en disco.
/// Si no hay nada guardado o el contenido no es válido, devuelve un mapa vacío.
#[tauri::command]
pub fn obtener_vinculaciones(
    app: tauri::AppHandle,
) -> Result<HashMap<String, Vec<String>>, String> {
    let store = app.store(STORE_CONFIG).map_err(|e| e.to_string())?;

    let Some(valor) = store.get(CLAVE_VINCULACIONES) else {
        return Ok(HashMap::new());
    };

    let vinculaciones =
        serde_json::from_value::<HashMap<String, Vec<String>>>(valor).unwrap_or_default();

    Ok(vinculaciones)
}

/// Guarda el mapa completo de vinculaciones. El estado en JS es la fuente de
/// verdad, así que se sobrescribe entero. Un mapa vacío elimina la clave.
#[tauri::command]
pub fn guardar_vinculaciones(
    app: tauri::AppHandle,
    vinculaciones: HashMap<String, Vec<String>>,
) -> Result<(), String> {
    let store = app.store(STORE_CONFIG).map_err(|e| e.to_string())?;

    if vinculaciones.is_empty() {
        store.delete(CLAVE_VINCULACIONES);
    } else {
        let valor = serde_json::to_value(vinculaciones).map_err(|e| e.to_string())?;
        store.set(CLAVE_VINCULACIONES, valor);
    }

    store.save().map_err(|e| e.to_string())?;
    Ok(())
}
