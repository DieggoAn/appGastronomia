use tauri_plugin_store::StoreExt;

// Mismo store que colores/vinculaciones: toda la configuración de la app vive
// en config.json. El plugin JS de store no está disponible sin bundler, así que
// el toggle de la vista compacta se persiste con estos dos comandos.
const STORE_CONFIG: &str = "config.json";
const CLAVE_VISTA_COMPACTA: &str = "vista_compacta";

/// ¿El usuario dejó activada la vista compacta? Por defecto, no.
#[tauri::command]
pub fn obtener_vista_compacta(app: tauri::AppHandle) -> Result<bool, String> {
    let store = app.store(STORE_CONFIG).map_err(|e| e.to_string())?;

    Ok(store
        .get(CLAVE_VISTA_COMPACTA)
        .and_then(|valor| valor.as_bool())
        .unwrap_or(false))
}

/// Guarda el estado del toggle para que sobreviva al reinicio.
#[tauri::command]
pub fn guardar_vista_compacta(
    app: tauri::AppHandle,
    activa: bool,
) -> Result<(), String> {
    let store = app.store(STORE_CONFIG).map_err(|e| e.to_string())?;

    store.set(CLAVE_VISTA_COMPACTA, serde_json::json!(activa));
    store.save().map_err(|e| e.to_string())?;
    Ok(())
}
