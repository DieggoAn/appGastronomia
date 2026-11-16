// Exportación de la tabla visible a un libro de Excel real (.xlsx).
//
// El trabajo pesado (zip + Office Open XML) lo hace `rust_xlsxwriter`, así que
// el frontend solo envía una matriz de textos ya extraídos del DOM.

use rust_xlsxwriter::{Color, Format, Workbook};

/// Ancho máximo (en píxeles) que puede alcanzar una columna con autofit.
/// Sin este límite, un comentario largo ensancharía la columna hasta 1790 px.
const ANCHO_MAXIMO_AUTOFIT: u32 = 320;

/// Genera un .xlsx en `ruta` a partir de `datos`.
///
/// - `datos[0]` son los encabezados (se escriben en negrita y con fondo gris).
/// - `columnas_numericas` indica los índices de columna que deben escribirse
///   como número (Cantidad y Cantidad Total). Los códigos y demás textos se
///   escriben siempre como texto para no perder ceros a la izquierda.
#[tauri::command]
pub fn exportar_excel(
    datos: Vec<Vec<String>>,
    columnas_numericas: Vec<usize>,
    ruta: String,
) -> Result<(), String> {
    if datos.is_empty() {
        return Err("No hay datos para exportar.".to_string());
    }

    let mut libro = Workbook::new();
    let hoja = libro.add_worksheet();
    hoja.set_name("Consolidado")
        .map_err(|error| format!("No se pudo nombrar la hoja: {error}"))?;

    let formato_cabecera = Format::new()
        .set_bold()
        .set_background_color(Color::RGB(0xD9D9D9));

    // Fila 0: encabezados con formato.
    for (columna, valor) in datos[0].iter().enumerate() {
        hoja.write_string_with_format(0, columna as u16, valor, &formato_cabecera)
            .map_err(|error| format!("No se pudo escribir el encabezado: {error}"))?;
    }

    // Filas de datos.
    for (indice_fila, fila) in datos.iter().enumerate().skip(1) {
        for (indice_columna, valor) in fila.iter().enumerate() {
            let fila_excel = indice_fila as u32;
            let columna_excel = indice_columna as u16;

            // Solo las columnas declaradas como numéricas se convierten; el
            // resto se escribe como texto para conservar el formato original.
            if columnas_numericas.contains(&indice_columna) {
                if let Ok(numero) = valor.trim().parse::<f64>() {
                    hoja.write_number(fila_excel, columna_excel, numero)
                        .map_err(|error| format!("No se pudo escribir una cifra: {error}"))?;
                    continue;
                }
            }

            hoja.write_string(fila_excel, columna_excel, valor)
                .map_err(|error| format!("No se pudo escribir una celda: {error}"))?;
        }
    }

    // Encabezado siempre visible al desplazarse.
    hoja.set_freeze_panes(1, 0)
        .map_err(|error| format!("No se pudo fijar la cabecera: {error}"))?;

    // Ancho automático de columnas, con un tope razonable.
    hoja.set_autofit_max_width(ANCHO_MAXIMO_AUTOFIT);
    hoja.autofit();

    libro
        .save(&ruta)
        .map_err(|error| format!("No se pudo guardar el archivo: {error}"))?;

    Ok(())
}

#[cfg(test)]
mod pruebas {
    use super::*;
    use calamine::{open_workbook, Data, Reader, Xlsx};

    #[test]
    fn genera_un_xlsx_legible() {
        let ruta = std::env::temp_dir().join("appgastronomia_export_test.xlsx");
        let ruta_texto = ruta.to_string_lossy().to_string();

        let datos = vec![
            vec![
                "Ingrediente".to_string(),
                "Código".to_string(),
                "Unidad".to_string(),
                "Cantidad".to_string(),
            ],
            vec![
                "Piña".to_string(),
                "001".to_string(),
                "kg".to_string(),
                "1.50".to_string(),
            ],
        ];

        exportar_excel(datos, vec![3], ruta_texto.clone()).expect("el xlsx debe generarse");

        // Se vuelve a abrir con calamine (ya es dependencia) para comprobar
        // que Excel podrá leerlo, que las tildes llegan intactas y que la
        // columna numérica se escribió como número.
        let mut libro: Xlsx<_> =
            open_workbook(&ruta_texto).expect("el xlsx debe abrirse");
        let hoja = libro
            .worksheet_range_at(0)
            .expect("debe existir la hoja")
            .expect("la hoja debe leerse");

        assert_eq!(
            hoja.get_value((0, 0)),
            Some(&Data::String("Ingrediente".to_string()))
        );
        assert_eq!(
            hoja.get_value((1, 0)),
            Some(&Data::String("Piña".to_string()))
        );
        assert_eq!(
            hoja.get_value((1, 1)),
            Some(&Data::String("001".to_string()))
        );
        assert_eq!(hoja.get_value((1, 3)), Some(&Data::Float(1.5)));

        let _ = std::fs::remove_file(&ruta);
    }
}
