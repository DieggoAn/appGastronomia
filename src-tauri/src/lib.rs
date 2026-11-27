// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/

// 1. Declaramos el nuevo módulo
mod secciones;
mod recientes;
pub mod excel;
mod colores;
mod vinculaciones;
mod exportacion;
mod vista;
mod ajustes;
mod autoprocesado;

use tauri::Manager;

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
        .setup(|app| {
            // Aseguramos que la ventana principal arranque maximizada
            if let Some(ventana) = app.get_webview_window("main") {
                let _ = ventana.maximize();
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            // 3. Registramos el nuevo comando de Rust
            secciones::agregar_seccion,
            secciones::guardar_grupo,
            secciones::obtener_grupos_guardados,
            secciones::eliminar_grupo,
            secciones::eliminar_todos_los_grupos,
            secciones::auto_ajustar_proporciones,
            secciones::importar_grupos_excel,
            secciones::obtener_mapeo_grupos,
            secciones::guardar_mapeo_grupos,
            recientes::guardar_archivos_recientes,  
            recientes::obtener_archivos_recientes,
            recientes::eliminar_archivo_reciente,
            excel::obtener_hojas_excel,
            excel::procesar_hojas_excel,
            excel::consolidar_entre_archivos,
            excel::guardar_ruta_diccionario,
            excel::obtener_ruta_diccionario,
            excel::leer_diccionario,
            excel::asignar_codigos,
            excel::calcular_total,
            colores::obtener_colores_filas,
            colores::guardar_colores_filas,
            colores::obtener_version_colores_filas,
            colores::guardar_version_colores_filas,
            vinculaciones::obtener_vinculaciones,
            vinculaciones::guardar_vinculaciones,
            vinculaciones::descartar_vinculaciones_legacy,
            exportacion::exportar_excel,
            vista::obtener_vista_compacta,
            vista::guardar_vista_compacta,
            vista::obtener_grupos_por_pagina,
            vista::guardar_grupos_por_pagina,
            autoprocesado::obtener_auto_procesar,
            autoprocesado::guardar_auto_procesar,
            ajustes::obtener_ajustes_procesamiento,
            ajustes::guardar_ajustes_procesamiento,
            ajustes::obtener_mapeo_insumos,
            ajustes::guardar_mapeo_insumos,
            ajustes::abrir_carpeta_datos
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
