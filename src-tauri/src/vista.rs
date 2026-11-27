use tauri_plugin_store::StoreExt;

// Mismo store que colores/vinculaciones: toda la configuración de la app vive
// en config.json. El plugin JS de store no está disponible sin bundler, así que
// las preferencias de vista se persisten con comandos de Rust.
const STORE_CONFIG: &str = "config.json";
const CLAVE_VISTA_COMPACTA: &str = "vista_compacta";
const CLAVE_GRUPOS_POR_PAGINA: &str = "grupos_por_pagina";

/// Cantidad de grupos visibles por página cuando el usuario no ha elegido otra.
const GRUPOS_POR_PAGINA_POR_DEFECTO: u32 = 10;
/// Tope defensivo: evita pintar miles de filas por un valor corrupto del store.
const GRUPOS_POR_PAGINA_MAX: u32 = 500;

fn normalizar_grupos_por_pagina(cantidad: u32) -> u32 {
    cantidad.clamp(1, GRUPOS_POR_PAGINA_MAX)
}

/// ¿El usuario dejó activada la vista compacta? Por defecto, no.
#[tauri::command]
pub fn obtener_vista_compacta(app: tauri::AppHandle) -> Result<bool, String> {
    let store = app.store(STORE_CONFIG).map_err(|e| e.to_string())?;

    let activa = store
        .get(CLAVE_VISTA_COMPACTA)
        .and_then(|valor| valor.as_bool())
        .unwrap_or(false);

    // La vista compacta de grupos se eliminó. Si una versión anterior dejó su
    // clave, se borra para no dejar basura en config.json.
    if store.delete("vista_compacta_grupos") {
        let _ = store.save();
    }

    Ok(activa)
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

/// Cuántos grupos se muestran por página. Por defecto, 10.
///
/// Cualquier valor fuera de rango (0, negativo, corrupto) se normaliza aquí
/// para que la interfaz siempre reciba una cantidad usable.
#[tauri::command]
pub fn obtener_grupos_por_pagina(app: tauri::AppHandle) -> Result<u32, String> {
    let store = app.store(STORE_CONFIG).map_err(|e| e.to_string())?;

    let cantidad = store
        .get(CLAVE_GRUPOS_POR_PAGINA)
        .and_then(|valor| valor.as_u64())
        .map(|valor| valor as u32)
        .unwrap_or(GRUPOS_POR_PAGINA_POR_DEFECTO);

    Ok(normalizar_grupos_por_pagina(cantidad))
}

/// Guarda cuántos grupos se muestran por página.
#[tauri::command]
pub fn guardar_grupos_por_pagina(
    app: tauri::AppHandle,
    cantidad: u32,
) -> Result<(), String> {
    let store = app.store(STORE_CONFIG).map_err(|e| e.to_string())?;

    let cantidad = normalizar_grupos_por_pagina(cantidad);
    store.set(CLAVE_GRUPOS_POR_PAGINA, serde_json::json!(cantidad));
    store.save().map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normaliza_los_grupos_por_pagina() {
        assert_eq!(normalizar_grupos_por_pagina(0), 1);
        assert_eq!(normalizar_grupos_por_pagina(10), 10);
        assert_eq!(normalizar_grupos_por_pagina(50), 50);
        assert_eq!(normalizar_grupos_por_pagina(501), GRUPOS_POR_PAGINA_MAX);
    }
}
