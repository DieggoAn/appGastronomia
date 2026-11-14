// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/

// 1. Declaramos el nuevo módulo
mod secciones;
mod recientes;
mod excel;

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .manage(secciones::AppState::default())
        .invoke_handler(tauri::generate_handler![
            greet,
            // 3. Registramos el nuevo comando de Rust
            secciones::agregar_seccion,
            secciones::guardar_grupo,
            secciones::obtener_grupos_guardados,
            secciones::eliminar_grupo,
            secciones::auto_ajustar_proporciones,
            recientes::guardar_archivos_recientes,  
            recientes::obtener_archivos_recientes,
            recientes::eliminar_archivo_reciente,
            excel::obtener_hojas_excel,
            excel::procesar_hojas_excel,
            excel::consolidar_entre_archivos,
            excel::calcular_total    
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
