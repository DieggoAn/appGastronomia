use serde::{Deserialize, Serialize};
use std::sync::Mutex;

// 1. Definimos cómo se ve una sección
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Seccion {
    pub id: u32,
    pub nombre: String,
    pub alumnos: u32,
    pub proporcion: f32,
}

// 2. Definimos el estado que Tauri va a recordar
// Usamos Mutex para evitar problemas de concurrencia si haces varias llamadas rápido
pub struct AppState {
    pub secciones: Mutex<Vec<Seccion>>,
    pub contador_id: Mutex<u32>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            secciones: Mutex::new(Vec::new()),
            contador_id: Mutex::new(1), // Empezamos en 1
        }
    }
}

// 3. El comando que se llamará desde JS
#[tauri::command]
pub fn agregar_seccion(state: tauri::State<'_, AppState>) -> Result<Vec<Seccion>, String> {
    let mut id_lock = state.contador_id.lock().map_err(|_| "Error al bloquear ID")?;
    let mut secciones_lock = state.secciones.lock().map_err(|_| "Error al bloquear secciones")?;

    // Creamos la nueva sección con valores por defecto
    let nueva_seccion = Seccion {
        id: *id_lock,
        nombre: format!("Sección {}", *id_lock),
        alumnos: 0,
        proporcion: 0.0,
    };

    // La agregamos a la lista
    secciones_lock.push(nueva_seccion);
    
    // Incrementamos el ID para la próxima vez
    *id_lock += 1;

    // Retornamos la lista completa actualizada para que JS la dibuje
    Ok(secciones_lock.clone())
}