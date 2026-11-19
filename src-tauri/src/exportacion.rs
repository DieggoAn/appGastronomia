// Exportación de la tabla visible a un libro de Excel real (.xlsx).
//
// El trabajo pesado (zip + Office Open XML) lo hace `rust_xlsxwriter`, así que
// el frontend solo envía una matriz de textos ya extraídos del DOM.

use rust_xlsxwriter::{Color, Format, Workbook};

/// Ancho máximo (en píxeles) que puede alcanzar una columna con autofit.
/// Sin este límite, un comentario largo ensancharía la columna hasta 1790 px.
const ANCHO_MAXIMO_AUTOFIT: u32 = 320;

/// Ids de las columnas del frontend, en el mismo orden en que llegan en
/// `datos`. Debe coincidir con `COLUMNAS_AJUSTES_EXPORTACION` de main.js.
const COLUMNAS_TABLA: [&str; 6] = [
    "ingrediente",
    "codigo",
    "unidad",
    "cantidad",
    "total",
    "comentarios",
];

/// Traduce los ids elegidos por el usuario a índices de `datos`.
///
/// El orden del arreglo recibido se conserva (así el usuario ve las columnas
/// en el mismo orden en que las marcó) y los ids repetidos o vacíos se
/// ignoran.
fn indices_columnas(columnas: &[String]) -> Result<Vec<usize>, String> {
    let mut indices = Vec::new();

    for columna in columnas {
        let id = columna.trim().to_lowercase();
        if id.is_empty() {
            continue;
        }

        let indice = COLUMNAS_TABLA
            .iter()
            .position(|nombre| *nombre == id)
            .ok_or_else(|| format!("Columna desconocida para exportar: {columna}"))?;

        if !indices.contains(&indice) {
            indices.push(indice);
        }
    }

    if indices.is_empty() {
        return Err("Selecciona al menos una columna para exportar.".to_string());
    }

    Ok(indices)
}

/// Convierte "#RRGGBB" (o "RRGGBB") en un color de Excel. Un valor inválido
/// se ignora (la fila queda sin fondo) en lugar de romper la exportación.
fn color_desde_hex(valor: &str) -> Option<Color> {
    let hex = valor.trim().trim_start_matches('#');

    if hex.len() != 6 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }

    u32::from_str_radix(hex, 16).ok().map(Color::RGB)
}

/// Genera un .xlsx en `ruta` a partir de `datos`.
///
/// - `datos[0]` son los encabezados (se escriben en negrita y con fondo gris).
/// - `columnas_numericas` indica los índices **originales** de columna que
///   deben escribirse como número (Cantidad y Cantidad Total). Los códigos y
///   demás textos se escriben siempre como texto para no perder ceros.
/// - `columnas` son los ids de las columnas que el usuario eligió exportar;
///   se escriben en ese orden y el resto se descarta.
/// - `incluir_colores` + `colores_filas` aplican el color de fondo de cada
///   fila (`#RRGGBB`) a todas sus celdas. El arreglo va alineado con las filas
///   de datos (sin contar el encabezado); `None` deja la fila sin color.
#[tauri::command]
pub fn exportar_excel(
    datos: Vec<Vec<String>>,
    columnas_numericas: Vec<usize>,
    incluir_colores: bool,
    columnas: Vec<String>,
    colores_filas: Vec<Option<String>>,
    ruta: String,
) -> Result<(), String> {
    if datos.is_empty() {
        return Err("No hay datos para exportar.".to_string());
    }

    let indices = indices_columnas(&columnas)?;

    let mut libro = Workbook::new();
    let hoja = libro.add_worksheet();
    hoja.set_name("Consolidado")
        .map_err(|error| format!("No se pudo nombrar la hoja: {error}"))?;

    let formato_cabecera = Format::new()
        .set_bold()
        .set_background_color(Color::RGB(0xD9D9D9));

    // Fila 0: solo los encabezados elegidos, con formato.
    for (destino, &origen) in indices.iter().enumerate() {
        let valor = datos[0].get(origen).map(String::as_str).unwrap_or("");
        hoja.write_string_with_format(0, destino as u16, valor, &formato_cabecera)
            .map_err(|error| format!("No se pudo escribir el encabezado: {error}"))?;
    }

    // Filas de datos.
    for (indice_fila, fila) in datos.iter().enumerate().skip(1) {
        let fila_excel = indice_fila as u32;

        // Un formato con fondo por fila cuando el usuario pidió conservar los
        // colores. Se reutiliza para todas las celdas de esa fila.
        let formato_color = if incluir_colores {
            colores_filas
                .get(indice_fila - 1)
                .and_then(|color| color.as_deref())
                .and_then(color_desde_hex)
                .map(|color| Format::new().set_background_color(color))
        } else {
            None
        };

        for (destino, &origen) in indices.iter().enumerate() {
            let valor = fila.get(origen).map(String::as_str).unwrap_or("");
            let columna_excel = destino as u16;

            // Solo las columnas declaradas como numéricas se convierten; el
            // resto se escribe como texto para conservar el formato original.
            let es_numerica = columnas_numericas.contains(&origen);

            if let (true, Ok(numero)) = (es_numerica, valor.trim().parse::<f64>()) {
                match &formato_color {
                    Some(formato) => hoja.write_number_with_format(
                        fila_excel,
                        columna_excel,
                        numero,
                        formato,
                    ),
                    None => hoja.write_number(fila_excel, columna_excel, numero),
                }
                .map_err(|error| format!("No se pudo escribir una cifra: {error}"))?;
                continue;
            }

            match &formato_color {
                Some(formato) => hoja.write_string_with_format(
                    fila_excel,
                    columna_excel,
                    valor,
                    formato,
                ),
                None => hoja.write_string(fila_excel, columna_excel, valor),
            }
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

        exportar_excel(
            datos,
            vec![3],
            true,
            vec![
                "ingrediente".to_string(),
                "codigo".to_string(),
                "unidad".to_string(),
                "cantidad".to_string(),
            ],
            vec![Some("#FFF3BF".to_string())],
            ruta_texto.clone(),
        )
        .expect("el xlsx debe generarse");

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

    #[test]
    fn filtra_las_columnas_elegidas_y_conserva_su_orden() {
        let ruta = std::env::temp_dir().join("appgastronomia_export_columnas_test.xlsx");
        let ruta_texto = ruta.to_string_lossy().to_string();

        let datos = vec![
            vec![
                "Ingrediente".to_string(),
                "Código".to_string(),
                "Unidad".to_string(),
                "Cantidad".to_string(),
                "Cantidad Total".to_string(),
                "Comentarios".to_string(),
            ],
            vec![
                "Harina".to_string(),
                "001".to_string(),
                "kg".to_string(),
                "2".to_string(),
                "2".to_string(),
                "sin gluten".to_string(),
            ],
        ];

        exportar_excel(
            datos,
            vec![3, 4],
            false,
            vec!["cantidad".to_string(), "ingrediente".to_string()],
            vec![None],
            ruta_texto.clone(),
        )
        .expect("el xlsx debe generarse");

        let mut libro: Xlsx<_> =
            open_workbook(&ruta_texto).expect("el xlsx debe abrirse");
        let hoja = libro
            .worksheet_range_at(0)
            .expect("debe existir la hoja")
            .expect("la hoja debe leerse");

        // Solo las dos columnas pedidas, en el orden solicitado.
        assert_eq!(
            hoja.get_value((0, 0)),
            Some(&Data::String("Cantidad".to_string()))
        );
        assert_eq!(
            hoja.get_value((0, 1)),
            Some(&Data::String("Ingrediente".to_string()))
        );
        assert_eq!(hoja.get_value((1, 0)), Some(&Data::Float(2.0)));
        assert_eq!(
            hoja.get_value((1, 1)),
            Some(&Data::String("Harina".to_string()))
        );
        assert!(hoja.get_value((0, 2)).is_none());

        let _ = std::fs::remove_file(&ruta);
    }

    #[test]
    fn valida_las_columnas_y_los_colores() {
        assert_eq!(
            indices_columnas(&["total".to_string(), "ingrediente".to_string()])
                .expect("ids válidos"),
            vec![4, 0]
        );
        assert_eq!(
            indices_columnas(&["unidad".to_string(), "unidad".to_string()])
                .expect("ids válidos"),
            vec![2]
        );
        assert!(indices_columnas(&[]).is_err());
        assert!(indices_columnas(&["inexistente".to_string()]).is_err());

        assert!(matches!(
            color_desde_hex("#F8D7DA"),
            Some(Color::RGB(0xF8D7DA))
        ));
        assert!(matches!(
            color_desde_hex("fff3bf"),
            Some(Color::RGB(0xFFF3BF))
        ));
        assert!(color_desde_hex("#12345").is_none());
        assert!(color_desde_hex("no-es-color").is_none());
    }
}
