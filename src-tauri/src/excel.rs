use calamine::{open_workbook, Reader, Xlsx};

// Comando que recibe una ruta y devuelve un array con los nombres de las hojas
#[tauri::command]
pub fn obtener_hojas_excel(ruta: String) -> Result<Vec<String>, String> {
    // open_workbook abre el archivo en modo lectura
    let workbook: Xlsx<_> = open_workbook(&ruta).map_err(|e| format!("Error abriendo Excel: {}", e))?;

    // sheet_names() devuelve una lista con los nombres de las hojas
    let nombres = workbook.sheet_names().to_owned();

    Ok(nombres)
}