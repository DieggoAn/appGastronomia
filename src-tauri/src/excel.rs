use calamine::{open_workbook, Data, Reader, Xlsx};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use tauri_plugin_store::StoreExt;
use crate::secciones::Seccion; // Para el comando calcular_total

// --- 1. Structs (SIEMPRE al principio) ---

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct DiccionarioItem {
    pub codigo: String,
    pub descripcion: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct IngredienteConsolidado {
    pub nombre: String,
    pub unidad: String,
    pub cantidad: f64,
    /// Clave de consolidación (nombre normalizado + unidad). La usa Rust
    /// para agrupar filas equivalentes entre archivos.
    #[serde(default)]
    pub clave: String,
    /// Solo el nombre normalizado (sin unidad). El frontend la combina con
    /// la unidad para construir la pk de preferencias de UI (colores).
    #[serde(default)]
    pub clave_ingrediente: String,
    #[serde(default)]
    pub opciones_codigo: Vec<DiccionarioItem>,
    #[serde(default)]
    pub codigo_seleccionado: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct IngredienteConTotal {
    pub nombre: String,
    pub unidad: String,
    pub cantidad: f64,
    pub cantidad_total: f64,
    #[serde(default)]
    pub clave: String,
    #[serde(default)]
    pub clave_ingrediente: String,
    #[serde(default)]
    pub opciones_codigo: Vec<DiccionarioItem>,
    #[serde(default)]
    pub codigo_seleccionado: String,
}

// --- 2. Utilidades de normalización ---

/// Clave normalizada para agrupar ingredientes equivalentes.
/// Se conservan ñ/Ñ porque representan un sonido distinto y no son una "n" acentuada:
/// "piña" y "pina" deben seguir siendo ingredientes diferentes.
pub fn clave_ingrediente(nombre: &str) -> String {
    let mut sin_tildes = String::with_capacity(nombre.len());

    for c in nombre.chars() {
        let base = match c {
            'á' | 'Á' => 'a',
            'é' | 'É' => 'e',
            'í' | 'Í' => 'i',
            'ó' | 'Ó' => 'o',
            'ú' | 'Ú' | 'ü' | 'Ü' => 'u',
            // ñ/Ñ se deja intacta a propósito (piña ≠ pina)
            otro => otro,
        };
        sin_tildes.push(base);
    }

    // Minúsculas + espacios colapsados a uno solo
    let colapsado = sin_tildes
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");

    // Sin puntuación final (. , ; :)
    colapsado
        .trim_end_matches(|c: char| matches!(c, '.' | ',' | ';' | ':'))
        .trim_end()
        .to_string()
}

/// Nombre visible limpio: sin espacios sobrantes, sin puntuación final y
/// con los nombres TODO EN MAYÚSCULAS pasados a Tipo Título ("SAL" → "Sal").
fn nombre_visible(nombre: &str) -> String {
    let colapsado = nombre.split_whitespace().collect::<Vec<_>>().join(" ");
    let limpio = colapsado
        .trim_end_matches(|c: char| matches!(c, '.' | ',' | ';' | ':'))
        .trim_end();

    let es_todo_mayusculas = limpio.chars().any(|c| c.is_alphabetic())
        && limpio
            .chars()
            .all(|c| !c.is_alphabetic() || c.is_uppercase());

    if !es_todo_mayusculas {
        return limpio.to_string();
    }

    limpio
        .split(' ')
        .map(|palabra| {
            let mut chars = palabra.chars();
            match chars.next() {
                Some(primera) => {
                    primera.to_uppercase().collect::<String>() + &chars.as_str().to_lowercase()
                }
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Puntúa qué variante se ve "más bonita" para elegir el nombre visible:
/// las tildes/diéresis suman 2 y una inicial mayúscula suma 1.
pub fn puntuacion_nombre(nombre: &str) -> i32 {
    let mut puntuacion = 0;

    for c in nombre.chars() {
        match c {
            'á' | 'é' | 'í' | 'ó' | 'ú' | 'ü' | 'Á' | 'É' | 'Í' | 'Ó' | 'Ú' | 'Ü' => {
                puntuacion += 2
            }
            _ => {}
        }
    }

    // is_uppercase() cubre también Á, É, Í, Ó, Ú y Ñ
    if nombre.trim_start().chars().next().is_some_and(|c| c.is_uppercase()) {
        puntuacion += 1;
    }

    puntuacion
}

// --- 2.b Conversión de cantidades ---

/// Convierte a `f64` el texto de una celda de Excel.
///
/// Acepta coma o punto como separador decimal y también separadores de miles:
/// `"0,4"` → `0.4`, `"1.5"` → `1.5`, `"1.234,56"` → `1234.56`,
/// `"1,234.56"` → `1234.56`. Si el texto no es un número devuelve `0.0` y
/// registra una advertencia (nunca un valor truncado).
pub fn parsear_decimal(texto: &str) -> f64 {
    // Espacios normales, tabuladores y el espacio duro que a veces arrastra
    // Excel al copiar/pegar.
    let limpio: String = texto
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '\u{00A0}')
        .collect();

    if limpio.is_empty() {
        return 0.0;
    }

    let puntos = limpio.matches('.').count();
    let comas = limpio.matches(',').count();

    // Normalización del separador decimal.
    let normalizado = match (puntos, comas) {
        // "1.234,56": el último separador es la coma decimal.
        (p, c) if p > 0 && c > 0 => {
            if limpio.rfind(',') > limpio.rfind('.') {
                limpio.replace('.', "").replace(',', ".")
            } else {
                limpio.replace(',', "")
            }
        }
        // "1.234.567": varios puntos son separadores de miles.
        (p, 0) if p > 1 => limpio.replace('.', ""),
        // "1,234,567": varias comas son separadores de miles.
        (0, c) if c > 1 => limpio.replace(',', ""),
        // "0,4": coma decimal.
        (0, _) => limpio.replace(',', "."),
        // "0.4": ya está en formato válido para `f64`.
        _ => limpio,
    };

    normalizado.parse::<f64>().unwrap_or_else(|_| {
        eprintln!("[excel] Cantidad no numérica, se usa 0.0: {texto:?}");
        0.0
    })
}

/// Extrae la cantidad de una celda ya tipada por `calamine`.
///
/// Las celdas numéricas se convierten directamente; las de texto pasan por
/// `parsear_decimal`, que sí entiende la coma decimal. No se usa
/// `DataType::as_f64()` como atajo porque solo acepta el formato inglés
/// (`"0.4"`), no `"0,4"`, y no entiende los separadores de miles.
fn cantidad_de_celda(celda: &Data) -> f64 {
    match celda {
        Data::Int(valor) => *valor as f64,
        Data::Float(valor) => *valor,
        Data::Bool(valor) => {
            if *valor {
                1.0
            } else {
                0.0
            }
        }
        Data::Empty => 0.0,
        otro => parsear_decimal(&otro.to_string()),
    }
}

// --- 3. Comandos ---

#[tauri::command]
pub fn obtener_hojas_excel(ruta: String) -> Result<Vec<String>, String> {
    let workbook: Xlsx<_> =
        open_workbook(&ruta).map_err(|e| format!("Error abriendo Excel: {}", e))?;
    Ok(workbook.sheet_names().to_owned())
}

#[tauri::command]
pub fn procesar_hojas_excel(
    ruta: String,
    nombres_hojas: Vec<String>,
) -> Result<Vec<IngredienteConsolidado>, String> {
    let mut workbook: Xlsx<_> =
        open_workbook(&ruta).map_err(|e| format!("Error abriendo Excel: {}", e))?;
    let mut mapa: HashMap<String, IngredienteConsolidado> = HashMap::new();

    for nombre_hoja in nombres_hojas {
        let range = match workbook.worksheet_range(&nombre_hoja) {
            Ok(r) => r,
            Err(_) => continue,
        };

        // Detección automática de columnas
        let mut col_nombre: Option<usize> = None;
        let mut col_um: Option<usize> = None;
        let mut col_cantidad: Option<usize> = None;
        let mut fila_cabecera_idx: Option<usize> = None;

        for (i, row) in range.rows().take(15).enumerate() {
            let celdas: Vec<String> = row
                .iter()
                .map(|c| c.to_string().trim().to_lowercase())
                .collect();

            let tiene_ingrediente = celdas.iter().any(|c| {
                c.contains("ingrediente")
                    || c.contains("descripción")
                    || c.contains("descripcion")
                    || c.contains("material")
            });
            let tiene_um = celdas
                .iter()
                .any(|c| c == "u/m" || c == "um" || c.contains("unidad"));
            let tiene_cantidad = celdas.iter().any(|c| c.contains("cantidad"));

            if tiene_ingrediente && tiene_um && tiene_cantidad {
                fila_cabecera_idx = Some(i);
                for (j, celda) in celdas.iter().enumerate() {
                    if col_nombre.is_none()
                        && (celda.contains("ingrediente")
                            || celda.contains("descripción")
                            || celda.contains("descripcion")
                            || celda.contains("material"))
                    {
                        col_nombre = Some(j);
                    } else if col_um.is_none()
                        && (celda == "u/m" || celda == "um" || celda.contains("unidad"))
                    {
                        col_um = Some(j);
                    } else if col_cantidad.is_none() && celda.contains("cantidad") {
                        col_cantidad = Some(j);
                    }
                }
                break;
            }
        }

        let (col_nombre, col_um, col_cantidad, fila_cabecera_idx) =
            match (col_nombre, col_um, col_cantidad, fila_cabecera_idx) {
                (Some(n), Some(u), Some(c), Some(f)) => (n, u, c, f),
                _ => continue,
            };

        for row in range.rows().skip(fila_cabecera_idx + 1) {
            let nombre = row
                .get(col_nombre)
                .map(|c| c.to_string().trim().to_string())
                .unwrap_or_default();
            let um = row
                .get(col_um)
                .map(|c| c.to_string().trim().to_string())
                .unwrap_or_default();

            let cantidad = row
                .get(col_cantidad)
                .map(cantidad_de_celda)
                .unwrap_or(0.0);

            if nombre.is_empty() || um.is_empty() {
                continue;
            }
            if nombre.to_lowercase().contains("material")
                || nombre.to_lowercase().contains("descripción")
            {
                continue;
            }

            let clave_nombre = clave_ingrediente(&nombre);
            let clave = format!("{}|{}", clave_nombre, um.to_lowercase());
            let clave_fila = clave.clone();
            let entry = mapa.entry(clave).or_insert_with(|| IngredienteConsolidado {
                nombre: nombre_visible(&nombre),
                unidad: um.clone(),
                cantidad: 0.0,
                clave: clave_fila,
                clave_ingrediente: clave_nombre,
                opciones_codigo: Vec::new(),
                codigo_seleccionado: String::new(),
            });

            // Dejamos como nombre visible la variante con mejor puntuación
            // ("Azúcar" por encima de "azucar" o "AZÚCAR")
            if puntuacion_nombre(&nombre) > puntuacion_nombre(&entry.nombre) {
                entry.nombre = nombre_visible(&nombre);
            }

            entry.cantidad += cantidad;
        }
    }

    let mut resultado: Vec<IngredienteConsolidado> = mapa.into_values().collect();
    resultado.sort_by(|a, b| clave_ingrediente(&a.nombre).cmp(&clave_ingrediente(&b.nombre)));
    Ok(resultado)
}

/// Consolida los ingredientes de varios archivos en una sola lista:
/// suma cantidades equivalentes y ordena alfabéticamente de forma global.
///
/// Estrategia para unidades distintas: no se suman cantidades incompatibles.
/// Se usa "clave_ingrediente|unidad" como clave, así "Azúcar" en g y "azucar"
/// en kg quedan como dos filas separadas y el usuario decide.
#[tauri::command]
pub fn consolidar_entre_archivos(
    ingredientes: Vec<IngredienteConsolidado>,
) -> Result<Vec<IngredienteConsolidado>, String> {
    let mut mapa: HashMap<String, IngredienteConsolidado> = HashMap::new();

    for item in ingredientes {
        let nombre = item.nombre.trim().to_string();
        if nombre.is_empty() {
            continue;
        }

        let unidad = item.unidad.trim().to_string();
        let clave_nombre = clave_ingrediente(&nombre);
        let clave = format!("{}|{}", clave_nombre, unidad.to_lowercase());
        let clave_fila = clave.clone();

        let entry = mapa.entry(clave).or_insert_with(|| IngredienteConsolidado {
            nombre: nombre_visible(&nombre),
            unidad,
            cantidad: 0.0,
            clave: clave_fila,
            clave_ingrediente: clave_nombre,
            opciones_codigo: Vec::new(),
            codigo_seleccionado: String::new(),
        });

        // Conservamos la variante con mejor puntuación como nombre visible
        if puntuacion_nombre(&nombre) > puntuacion_nombre(&entry.nombre) {
            entry.nombre = nombre_visible(&nombre);
        }

        entry.cantidad += item.cantidad;
    }

    // Orden alfabético GLOBAL (por clave normalizada, estable entre acentos)
    let mut resultado: Vec<IngredienteConsolidado> = mapa.into_values().collect();
    resultado.sort_by(|a, b| clave_ingrediente(&a.nombre).cmp(&clave_ingrediente(&b.nombre)));

    Ok(resultado)
}

const STORE_DICCIONARIO: &str = "config.json";
const CLAVE_RUTA_DICCIONARIO: &str = "ruta_diccionario";

/// Guarda la ruta del diccionario maestro para restaurarla al iniciar.
/// Si la ruta llega vacía, se elimina la preferencia guardada.
#[tauri::command]
pub fn guardar_ruta_diccionario(app: tauri::AppHandle, ruta: String) -> Result<(), String> {
    let store = app
        .store(STORE_DICCIONARIO)
        .map_err(|e| e.to_string())?;

    let ruta = ruta.trim().to_string();

    if ruta.is_empty() {
        store.delete(CLAVE_RUTA_DICCIONARIO);
    } else {
        store.set(
            CLAVE_RUTA_DICCIONARIO,
            serde_json::Value::String(ruta),
        );
    }

    store.save().map_err(|e| e.to_string())?;
    Ok(())
}

/// Devuelve la ruta guardada del diccionario solo si el archivo sigue existiendo.
/// Si ya no existe, limpia la preferencia en silencio y devuelve None.
#[tauri::command]
pub fn obtener_ruta_diccionario(
    app: tauri::AppHandle,
) -> Result<Option<String>, String> {
    let store = app
        .store(STORE_DICCIONARIO)
        .map_err(|e| e.to_string())?;

    let ruta = store
        .get(CLAVE_RUTA_DICCIONARIO)
        .and_then(|valor| valor.as_str().map(|texto| texto.to_string()))
        .filter(|texto| !texto.trim().is_empty());

    if let Some(ruta) = ruta {
        if Path::new(&ruta).exists() {
            return Ok(Some(ruta));
        }

        store.delete(CLAVE_RUTA_DICCIONARIO);
        let _ = store.save();
    }

    Ok(None)
}

/// Lee el diccionario maestro: Columna A = código, Columna B = descripción.
/// Se ignoran las filas con código vacío (ruido al final del Excel).
#[tauri::command]
pub fn leer_diccionario(ruta: String) -> Result<Vec<DiccionarioItem>, String> {
    let mut workbook: Xlsx<_> =
        open_workbook(&ruta).map_err(|e| format!("Error abriendo diccionario: {}", e))?;

    let range = workbook
        .worksheet_range_at(0)
        .ok_or_else(|| "El diccionario no tiene hojas".to_string())?
        .map_err(|e| format!("Error leyendo diccionario: {}", e))?;

    let mut items: Vec<DiccionarioItem> = Vec::new();

    // Los datos reales empiezan en la fila 2 (se omite la cabecera)
    for row in range.rows().skip(1) {
        let codigo = row
            .get(0)
            .map(|c| c.to_string().trim().to_string())
            .unwrap_or_default();

        if codigo.is_empty() {
            continue;
        }

        let descripcion = row
            .get(1)
            .map(|c| c.to_string().trim().to_string())
            .unwrap_or_default();

        items.push(DiccionarioItem { codigo, descripcion });
    }

    Ok(items)
}

/// Asigna a cada ingrediente los códigos del diccionario cuya descripción
/// contenga el nombre normalizado del ingrediente (búsqueda lineal simple).
#[tauri::command]
pub fn asignar_codigos(
    ingredientes: Vec<IngredienteConsolidado>,
    diccionario: Vec<DiccionarioItem>,
) -> Result<Vec<IngredienteConsolidado>, String> {
    // Normalizamos el diccionario una sola vez para no repetir el trabajo por ingrediente
    let normalizado: Vec<(String, DiccionarioItem)> = diccionario
        .into_iter()
        .map(|item| (clave_ingrediente(&item.descripcion), item))
        .collect();

    let resultado = ingredientes
        .into_iter()
        .map(|mut ing| {
            let clave = clave_ingrediente(&ing.nombre);

            ing.opciones_codigo = if clave.is_empty() {
                Vec::new()
            } else {
                normalizado
                    .iter()
                    .filter(|(descripcion, _)| descripcion.contains(&clave))
                    .map(|(_, item)| item.clone())
                    .collect()
            };

            // Con una sola coincidencia no hay nada que elegir
            ing.codigo_seleccionado = if ing.opciones_codigo.len() == 1 {
                ing.opciones_codigo[0].codigo.clone()
            } else {
                String::new()
            };

            ing
        })
        .collect();

    Ok(resultado)
}

#[tauri::command]
pub fn calcular_total(
    ingredientes: Vec<IngredienteConsolidado>,
    secciones: Vec<Seccion>,
) -> Result<Vec<IngredienteConTotal>, String> {
    let suma_proporciones: f64 = secciones.iter().map(|s| s.proporcion).sum();
    let suma_alumnos: f64 = secciones.iter().map(|s| s.alumnos as f64).sum();

    let factor = if suma_proporciones > 0.0 {
        suma_proporciones / 100.0
    } else if suma_alumnos > 0.0 {
        suma_alumnos
    } else {
        return Err("No hay secciones con alumnos o proporciones definidas".to_string());
    };

    let mut resultado: Vec<IngredienteConTotal> = ingredientes
    .into_iter()
    .map(|ing| IngredienteConTotal {
        nombre: ing.nombre,
        unidad: ing.unidad,
        cantidad: ing.cantidad,
        cantidad_total: ing.cantidad * factor,
        clave: ing.clave,
        clave_ingrediente: ing.clave_ingrediente,
        opciones_codigo: ing.opciones_codigo,
        codigo_seleccionado: ing.codigo_seleccionado,
    })
    .collect();

    resultado.sort_by(|a, b| clave_ingrediente(&a.nombre).cmp(&clave_ingrediente(&b.nombre)));
    Ok(resultado)
}

#[cfg(test)]
mod pruebas {
    use super::*;

    #[test]
    fn parsea_punto_y_coma_decimal() {
        assert_eq!(parsear_decimal("0.4"), 0.4);
        assert_eq!(parsear_decimal("1.5"), 1.5);
        assert_eq!(parsear_decimal("0,4"), 0.4);
        assert_eq!(parsear_decimal("1,5"), 1.5);
        assert_eq!(parsear_decimal("  0,4  "), 0.4);
        assert_eq!(parsear_decimal("0,4\u{00A0}"), 0.4);
    }

    #[test]
    fn parsea_separadores_de_miles() {
        assert_eq!(parsear_decimal("1.234,56"), 1234.56);
        assert_eq!(parsear_decimal("1,234.56"), 1234.56);
        assert_eq!(parsear_decimal("1.234.567"), 1234567.0);
        assert_eq!(parsear_decimal("1,234,567"), 1234567.0);
    }

    #[test]
    fn devuelve_cero_si_no_es_numero() {
        assert_eq!(parsear_decimal(""), 0.0);
        assert_eq!(parsear_decimal("   "), 0.0);
        assert_eq!(parsear_decimal("sin dato"), 0.0);
    }

    #[test]
    fn celdas_tipadas_se_convierten_a_f64() {
        assert_eq!(cantidad_de_celda(&Data::Float(0.4)), 0.4);
        assert_eq!(cantidad_de_celda(&Data::Int(3)), 3.0);
        assert_eq!(cantidad_de_celda(&Data::String("1,5".to_string())), 1.5);
        assert_eq!(cantidad_de_celda(&Data::Empty), 0.0);
    }
}