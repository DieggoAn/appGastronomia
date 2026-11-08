use serde::{Deserialize, Serialize};
use tauri_plugin_store::StoreExt;

// Definimos cómo se ve un archivo en nuestra lista
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ArchivoReciente {
    pub ruta: String,
}

// Comando para guardar las rutas seleccionadas
#[tauri::command]
pub fn guardar_archivos_recientes(app: tauri::AppHandle, rutas: Vec<String>) -> Result<(), String> {
    let store = app.store("recientes.json").map_err(|e| e.to_string())?;
    
    // Obtenemos la lista actual (si existe) para no borrar lo anterior
    let mut archivos_guardados: Vec<ArchivoReciente> = Vec::new();
    if let Some(valor) = store.get("lista_archivos") {
        if let Ok(lista) = serde_json::from_value::<Vec<ArchivoReciente>>(valor) {
            archivos_guardados = lista;
        }
    }

    // Añadimos las nuevas rutas, evitando duplicados
    for ruta in rutas {
        if !archivos_guardados.iter().any(|a| a.ruta == ruta) {
            archivos_guardados.push(ArchivoReciente { ruta });
        }
    }

    // Guardamos de vuelta en el JSON
    let json_value = serde_json::to_value(archivos_guardados).map_err(|e| e.to_string())?;
    store.set("lista_archivos", json_value);
    store.save().map_err(|e| e.to_string())?;

    Ok(())
}

// Comando para pedirle a Rust la lista de archivos al iniciar la app
#[tauri::command]
pub fn obtener_archivos_recientes(app: tauri::AppHandle) -> Result<Vec<ArchivoReciente>, String> {
    let store = app.store("recientes.json").map_err(|e| e.to_string())?;
    
    if let Some(valor) = store.get("lista_archivos") {
        if let Ok(lista) = serde_json::from_value::<Vec<ArchivoReciente>>(valor) {
            return Ok(lista);
        }
    }
    
    // Si no hay archivos guardados o hay un error, devolvemos una lista vacía
    Ok(Vec::new())
}