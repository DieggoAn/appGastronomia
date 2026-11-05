// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/

// 1. Declaramos el nuevo módulo
mod secciones; 

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        // 2. Inicializamos el estado global para manejar las secciones
        .manage(secciones::AppState::default()) 
        .invoke_handler(tauri::generate_handler![
            greet, 
            // 3. Registramos el nuevo comando de Rust
            secciones::agregar_seccion 
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}