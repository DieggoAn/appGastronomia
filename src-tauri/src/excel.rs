use calamine::{open_workbook, DataType, Reader, Xlsx};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use crate::secciones::Seccion; // Para el comando calcular_total

// --- 1. Structs (SIEMPRE al principio) ---

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct IngredienteConsolidado {
    pub nombre: String,
    pub unidad: String,
    pub cantidad: f32,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct IngredienteConTotal {
    pub nombre: String,
    pub unidad: String,
    pub cantidad: f32,
    pub cantidad_total: f32,
}

// --- 2. Comandos ---

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
                .map(|c| {
                    c.as_f64().unwrap_or_else(|| {
                        c.to_string()
                            .replace(',', ".")
                            .parse::<f64>()
                            .unwrap_or(0.0)
                    })
                })
                .unwrap_or(0.0) as f32;

            if nombre.is_empty() || um.is_empty() {
                continue;
            }
            if nombre.to_lowercase().contains("material")
                || nombre.to_lowercase().contains("descripción")
            {
                continue;
            }

            let clave = format!("{}|{}", nombre.to_lowercase(), um.to_lowercase());
            let entry = mapa.entry(clave).or_insert_with(|| IngredienteConsolidado {
                nombre: nombre.clone(),
                unidad: um.clone(),
                cantidad: 0.0,
            });
            entry.cantidad += cantidad;
        }
    }

    let mut resultado: Vec<IngredienteConsolidado> = mapa.into_values().collect();
    resultado.sort_by(|a, b| a.nombre.to_lowercase().cmp(&b.nombre.to_lowercase()));
    Ok(resultado)
}

#[tauri::command]
pub fn calcular_total(
    ingredientes: Vec<IngredienteConsolidado>,
    secciones: Vec<Seccion>,
) -> Result<Vec<IngredienteConTotal>, String> {
    let suma_proporciones: f32 = secciones.iter().map(|s| s.proporcion).sum();
    let suma_alumnos: f32 = secciones.iter().map(|s| s.alumnos as f32).sum();

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
    })
    .collect();

    resultado.sort_by(|a, b| a.nombre.to_lowercase().cmp(&b.nombre.to_lowercase()));
    Ok(resultado)
}