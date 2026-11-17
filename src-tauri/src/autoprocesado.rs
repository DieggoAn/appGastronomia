use tauri_plugin_store::StoreExt;

// Mismo store que el resto de la configuración de la app (config.json).
const STORE_CONFIG: &str = "config.json";
const CLAVE_AUTO_PROCESAR: &str = "auto_procesar";

/// ¿El usuario dejó activado el auto-procesado? Por defecto, sí: la app
/// procesa hojas y recalcula totales sin pulsar el botón.
#[tauri::command]
pub fn obtener_auto_procesar(app: tauri::AppHandle) -> Result<bool, String> {
    let store = app.store(STORE_CONFIG).map_err(|e| e.to_string())?;

    Ok(store
        .get(CLAVE_AUTO_PROCESAR)
        .and_then(|valor| valor.as_bool())
        .unwrap_or(true))
}

/// Guarda el estado del checkbox para que sobreviva al reinicio.
#[tauri::command]
pub fn guardar_auto_procesar(
    app: tauri::AppHandle,
    activo: bool,
) -> Result<(), String> {
    let store = app.store(STORE_CONFIG).map_err(|e| e.to_string())?;

    store.set(CLAVE_AUTO_PROCESAR, serde_json::json!(activo));
    store.save().map_err(|e| e.to_string())?;
    Ok(())
}
