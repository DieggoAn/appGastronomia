use serde::{Deserialize, Serialize};
use serde_json::json; // Para construir el Value
use std::sync::Mutex;
use tauri_plugin_store::StoreExt; // <-- Importante

// 1. Definimos cómo se ve una sección (sin cambios)
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Seccion {
    pub id: u32,
    pub nombre: String,
    pub alumnos: u32,
    pub proporcion: f32,
}

// 2. Estado global (sin cambios)
pub struct AppState {
    pub secciones: Mutex<Vec<Seccion>>,
    pub contador_id: Mutex<u32>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            secciones: Mutex::new(Vec::new()),
            contador_id: Mutex::new(1),
        }
    }
}

// 3. Comando existente (sin cambios)
#[tauri::command]
pub fn agregar_seccion(state: tauri::State<'_, AppState>) -> Result<Vec<Seccion>, String> {
    let mut id_lock = state.contador_id.lock().map_err(|_| "Error al bloquear ID")?;
    let mut secciones_lock = state.secciones.lock().map_err(|_| "Error al bloquear secciones")?;

    let nueva_seccion = Seccion {
        id: *id_lock,
        nombre: "Nueva Sección".to_string(),
        alumnos: 0,
        proporcion: 0.0,
    };

    secciones_lock.push(nueva_seccion);
    *id_lock += 1;

    Ok(secciones_lock.clone())
}

// 4. NUEVO COMANDO: Guardar grupo en JSON
#[tauri::command]
pub fn guardar_grupo(
    app: tauri::AppHandle, // Inyectamos AppHandle para acceder al Store
    nombre_grupo: String,
    secciones: Vec<Seccion>,
) -> Result<(), String> {
    // Obtenemos (o creamos) el store apuntando al archivo JSON
    let store = app.store("grupos.json").map_err(|e| e.to_string())?;

    // Construimos un objeto JSON con los datos del grupo
    // El plugin espera serde_json::Value, así que usamos json!()
    let grupo_json = json!({
        "nombre": nombre_grupo,
        "secciones": secciones,
    });

    // Guardamos bajo una clave única (podrías usar un ID de grupo o un timestamp)
    let clave = format!("grupo_{}", nombre_grupo); // Simplificado por ahora
    store.set(clave, grupo_json);

    // Persistimos a disco
    // (Si usas autoSave en JS no es estrictamente necesario, pero es buena práctica)
    store.save().map_err(|e| e.to_string())?;

    Ok(())
}

// Añade esto al final de tu secciones.rs

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct GrupoGuardado {
    pub nombre: String,
    pub secciones: Vec<Seccion>,
    // Si luego quieres más datos, se añaden aquí
}

#[tauri::command]
pub fn obtener_grupos_guardados(app: tauri::AppHandle) -> Result<Vec<GrupoGuardado>, String> {
    // 1. Obtenemos el store
    let store = app.store("grupos.json").map_err(|e| e.to_string())?;
    
    let mut grupos = Vec::new();

    // 2. Iteramos sobre todas las claves del store
    for (_, value) in store.entries() {
        // Intentamos deserializar cada valor al struct GrupoGuardado
        if let Ok(grupo) = serde_json::from_value::<GrupoGuardado>(value) {
            grupos.push(grupo);
        }
    }

    Ok(grupos)
}

#[tauri::command]
pub fn eliminar_grupo(app: tauri::AppHandle, nombre_grupo: String) -> Result<(), String> {
    let store = app.store("grupos.json").map_err(|e| e.to_string())?;
    
    // El plugin usa el nombre del grupo como clave en el JSON (ej. "grupo_Nombre")
    let clave = format!("grupo_{}", nombre_grupo);
    
    // Eliminamos la clave del store
    store.delete(clave);
    
    // Guardamos los cambios en disco
    store.save().map_err(|e| e.to_string())?;
    
    Ok(())
}

#[tauri::command]
pub fn auto_ajustar_proporciones(mut secciones: Vec<Seccion>) -> Result<Vec<Seccion>, String> {
    // 1. Buscar el valor máximo de alumnos (evitando el 0)
    let max_alumnos = secciones.iter().map(|s| s.alumnos).max().unwrap_or(0);

    // 2. Si no hay alumnos o todos son 0, evitamos dividir por cero
    if max_alumnos == 0 {
        for seccion in secciones.iter_mut() {
            seccion.proporcion = 0.0;
        }
        return Ok(secciones);
    }

    // 3. Calcular la proporción para cada sección
    for seccion in secciones.iter_mut() {
        // Regla de tres: (alumnos / max_alumnos) * 100
        let proporcion_calculada = (seccion.alumnos as f32 / max_alumnos as f32) * 100.0;
        
        // Redondeamos a 1 decimal para que se vea limpio en la UI (ej. 50.0, 33.3)
        seccion.proporcion = (proporcion_calculada * 10.0).round() / 10.0;
    }

    Ok(secciones)
}