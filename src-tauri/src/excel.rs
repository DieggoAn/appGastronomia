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

// --- 2.c Detección de columnas ---

/// Suma la cantidad de una fila recorriendo **todas** las columnas de cantidad
/// detectadas en la cabecera (A, B, C, TP, TA, o una única "Cantidad").
///
/// Las celdas vacías y los índices que se salen del rango de la fila aportan
/// `0.0`, así que una fila con un solo valor, con dos o con cinco se resuelve
/// con el mismo código: no hay ramas especiales por cantidad de columnas.
fn cantidad_de_fila(fila: &[Data], columnas: &[usize]) -> f64 {
    columnas
        .iter()
        .filter_map(|&indice| fila.get(indice))
        .map(cantidad_de_celda)
        .sum()
}

/// Nombre de columna del ingrediente: "Ingrediente", "Descripción", "Material"…
fn es_columna_ingrediente(celda: &str) -> bool {
    celda.contains("ingrediente")
        || celda.contains("descripción")
        || celda.contains("descripcion")
        || celda.contains("material")
}

/// Nombre de columna de la unidad de medida: "U/M", "UM", "Unidad"…
fn es_columna_unidad(celda: &str) -> bool {
    celda == "u/m" || celda == "um" || celda.contains("unidad")
}

/// Normaliza una cabecera con las mismas reglas que los nombres de ingredientes
/// (minúsculas, sin tildes, espacios colapsados, sin puntuación final) para
/// poder compararla por **igualdad exacta**.
fn normalizar_cabecera(celda: &str) -> String {
    clave_ingrediente(celda)
}

/// Palabras que convierten un "total" en un dato monetario y no en una
/// cantidad de ingredientes.
const PALABRAS_MONETARIAS: [&str; 8] = [
    "costo", "coste", "precio", "valor", "monto", "importe", "neto", "bruto",
];

/// ¿La cabecera (ya normalizada) es monetaria? "Costo Total", "Valor Total",
/// "Total $", "Precio unitario"…
///
/// Se usa para dos cosas: descartar esas columnas como cantidad y clasificar
/// "Costo Total" aparte, para que nunca se confunda con "Total".
fn es_columna_monetaria(cabecera_normalizada: &str) -> bool {
    PALABRAS_MONETARIAS
        .iter()
        .any(|palabra| cabecera_normalizada.contains(palabra))
        || cabecera_normalizada.contains('$')
        || cabecera_normalizada.contains('€')
        || cabecera_normalizada.contains('£')
}

/// ¿La cabecera es la columna autoritativa de cantidad total?
///
/// **Filtro estricto**: solo `"total"` o `"total cantidad"`, comparados por
/// igualdad exacta. Nada de `contains("total")`, porque eso aceptaría
/// "Costo Total", "Total Costo", "Valor Total", "Total Neto" o "Total $",
/// que son dinero y no cantidad.
///
/// Nota: `"cantidad total"` **no** entra aquí a propósito. Es el nombre que usa
/// la propia app al exportar (junto a "Cantidad"), y ese valor ya viene
/// multiplicado por los grupos: reimportarlo como cantidad base volvería a
/// escalarlo. Sin "total" exacto, cae en la lógica anterior.
fn es_columna_total(celda: &str) -> bool {
    let normalizada = normalizar_cabecera(celda);

    // Cualquier palabra monetaria descarta la columna antes de comparar.
    if es_columna_monetaria(&normalizada) {
        return false;
    }

    matches!(normalizada.as_str(), "total" | "total cantidad")
}

/// Detecta si una celda de cabecera es una columna de cantidad **parcial**
/// —A, B, C, TP, TA— y devuelve su etiqueta canónica.
///
/// Acepta la letra sola y también variantes con prefijo: `"A"`, `"Cantidad A"`,
/// `"Cant. B"`, `"CANTIDAD (TP)"`, `"CantidadA"`, `"A:"`.
///
/// Se espera la celda ya recortada y en minúsculas (se normaliza en
/// `detectar_columnas`). Devolver la etiqueta permite deduplicar: si una hoja
/// trae "A" y "Cantidad A", se usa la primera y no se suma dos veces.
fn etiqueta_cantidad_parcial(celda: &str) -> Option<&'static str> {
    let mut resto = celda.trim();

    // Prefijos habituales. "cantidad" se prueba primero: si se probara "cant"
    // antes, "cantidad a" quedaría como "idad a" y no se reconocería.
    for prefijo in ["cantidad", "ctdad.", "ctdad", "cant.", "cant"] {
        if let Some(sin_prefijo) = resto.strip_prefix(prefijo) {
            resto = sin_prefijo;
            break;
        }
    }

    // Primera palabra y sin adornos: "a", "(a)", "a:", "a (kg)".
    let etiqueta = resto
        .split_whitespace()
        .next()
        .unwrap_or("")
        .trim_matches(|c: char| !c.is_alphanumeric());

    match etiqueta {
        "a" => Some("a"),
        "b" => Some("b"),
        "c" => Some("c"),
        "tp" => Some("tp"),
        "ta" => Some("ta"),
        _ => None,
    }
}

/// Columnas ya identificadas en la fila de cabecera de una hoja.
struct ColumnasHoja {
    /// Índice de la fila donde están los encabezados.
    fila_cabecera: usize,
    /// Índice de la columna del nombre del ingrediente.
    nombre: usize,
    /// Índice de la columna de la unidad de medida.
    unidad: usize,
    /// Índices de **todas** las columnas de cantidad (una o varias).
    cantidad: Vec<usize>,
}

/// Busca la fila de cabecera dentro de las primeras 15 filas y devuelve los
/// índices de sus columnas.
///
/// Una fila es cabecera si reúne las tres piezas: nombre, unidad y al menos
/// una columna de cantidad.
///
/// Jerarquía de la cantidad (de mayor a menor prioridad):
/// 1. **"Total" exacto** → es la única fuente; se ignoran A/B/C/TP/TA.
/// 2. **Desglose A/B/C/TP/TA** → se devuelven todas para sumarlas (y se
///    ignora cualquier "Cantidad" genérica, que suele ser el total ya hecho).
/// 3. **Primera columna que contenga "cantidad"** → comportamiento histórico.
///
/// Las columnas monetarias ("Costo Total", "Valor Total", "Total $"…) se
/// descartan siempre como cantidad y se registran aparte.
fn detectar_columnas(filas: &[Vec<String>]) -> Option<ColumnasHoja> {
    for (indice_fila, celdas) in filas.iter().enumerate() {
        let mut nombre: Option<usize> = None;
        let mut unidad: Option<usize> = None;
        let mut cantidad: Vec<usize> = Vec::new();
        let mut etiquetas: Vec<&'static str> = Vec::new();
        let mut cantidad_generica: Option<usize> = None;
        // Columna "Total" autoritativa (prioridad 1).
        let mut cantidad_total: Option<usize> = None;
        // Columna de dinero: nunca es cantidad, se conserva aparte.
        let mut columna_monetaria: Option<usize> = None;

        for (j, celda) in celdas.iter().enumerate() {
            if nombre.is_none() && es_columna_ingrediente(celda) {
                nombre = Some(j);
            } else if unidad.is_none() && es_columna_unidad(celda) {
                unidad = Some(j);
            } else if columna_monetaria.is_none()
                && es_columna_monetaria(&normalizar_cabecera(celda))
            {
                // Lo monetario se comprueba antes que "total", "a", "b"…, así
                // "Cantidad Costo" o "Costo Total" no se cuelan como cantidad.
                columna_monetaria = Some(j);
            } else if cantidad_total.is_none() && es_columna_total(celda) {
                cantidad_total = Some(j);
            } else if let Some(etiqueta) = etiqueta_cantidad_parcial(celda) {
                // Una columna por etiqueta: "A" y "Cantidad A" son la misma.
                if !etiquetas.contains(&etiqueta) {
                    etiquetas.push(etiqueta);
                    cantidad.push(j);
                }
            } else if cantidad_generica.is_none() && celda.contains("cantidad") {
                cantidad_generica = Some(j);
            }
        }

        // Sin nombre o sin unidad no es una cabecera de ingredientes.
        let (Some(nombre), Some(unidad)) = (nombre, unidad) else {
            continue;
        };

        // Prioridad 1: "Total" manda y descarta el desglose por completo.
        // Prioridad 2: suma de A/B/C/TP/TA.
        // Prioridad 3: primera "Cantidad" genérica.
        let cantidad = if let Some(indice) = cantidad_total {
            vec![indice]
        } else if !cantidad.is_empty() {
            cantidad
        } else if let Some(indice) = cantidad_generica {
            vec![indice]
        } else {
            // Tiene nombre y unidad pero ninguna cantidad: no es la cabecera.
            continue;
        };

        // Deja rastro de que la columna de dinero se vio y se ignoró para la
        // cantidad (queda disponible si algún día se calcula el valor).
        if let Some(indice) = columna_monetaria {
            eprintln!(
                "[excel] Columna monetaria ignorada para la cantidad: {:?}",
                celdas[indice]
            );
        }

        return Some(ColumnasHoja {
            fila_cabecera: indice_fila,
            nombre,
            unidad,
            cantidad,
        });
    }

    None
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

        // Detección automática de columnas (nombre, unidad y una o varias
        // columnas de cantidad). Solo se miran las primeras 15 filas: arriba
        // suelen venir logos y títulos.
        let filas_cabecera: Vec<Vec<String>> = range
            .rows()
            .take(15)
            .map(|row| {
                row.iter()
                    .map(|c| c.to_string().trim().to_lowercase())
                    .collect()
            })
            .collect();

        let Some(columnas) = detectar_columnas(&filas_cabecera) else {
            continue; // hoja sin cabecera reconocible: se omite entera
        };

        for row in range.rows().skip(columnas.fila_cabecera + 1) {
            let nombre = row
                .get(columnas.nombre)
                .map(|c| c.to_string().trim().to_string())
                .unwrap_or_default();
            let um = row
                .get(columnas.unidad)
                .map(|c| c.to_string().trim().to_string())
                .unwrap_or_default();

            // Suma de TODAS las columnas de cantidad detectadas (A, B, C,
            // TP, TA o una única "Cantidad"). Ver `cantidad_de_fila`.
            let cantidad = cantidad_de_fila(row, &columnas.cantidad);

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

    #[test]
    fn reconoce_columnas_de_cantidad_parcial() {
        for (celda, esperado) in [
            ("a", "a"),
            ("b", "b"),
            ("c", "c"),
            ("tp", "tp"),
            ("ta", "ta"),
            ("cantidad a", "a"),
            ("cantidad b", "b"),
            ("cant. c", "c"),
            ("cantidad (tp)", "tp"),
            ("cantidada", "a"),
            ("a:", "a"),
            ("a (kg)", "a"),
        ] {
            assert_eq!(
                etiqueta_cantidad_parcial(celda),
                Some(esperado),
                "no reconoció {celda:?}"
            );
        }

        // No son columnas de cantidad parcial.
        for celda in [
            "cantidad",
            "cantidad total",
            "ingrediente",
            "descripción",
            "unidad",
            "u/m",
            "comentarios",
        ] {
            assert_eq!(
                etiqueta_cantidad_parcial(celda),
                None,
                "confundió {celda:?} con una columna parcial"
            );
        }
    }

    #[test]
    fn suma_una_o_varias_columnas_de_cantidad() {
        // Fila: A = 5, B = 3, C vacía, TP = 2
        let fila = vec![
            Data::String("5".to_string()),
            Data::String("3".to_string()),
            Data::Empty,
            Data::String("2".to_string()),
        ];

        // A + B + TP = 10 (requisito del caso de negocio)
        assert_eq!(cantidad_de_fila(&fila, &[0, 1, 3]), 10.0);
        // Una sola columna con valor
        assert_eq!(cantidad_de_fila(&fila, &[0]), 5.0);
        // Celda vacía y un índice fuera de rango no rompen la suma
        assert_eq!(cantidad_de_fila(&fila, &[0, 2, 99]), 5.0);
        // Sin columnas detectadas
        assert_eq!(cantidad_de_fila(&fila, &[]), 0.0);
    }

    #[test]
    fn suma_columnas_con_decimales_mixtos() {
        // Coma y punto en la misma fila, y una celda numérica real de Excel
        let fila = vec![
            Data::String("0,4".to_string()),
            Data::Float(1.5),
            Data::String("1,1".to_string()),
        ];

        let total = cantidad_de_fila(&fila, &[0, 1, 2]);
        assert!((total - 3.0).abs() < 1e-9, "total inesperado: {total}");
    }

    #[test]
    fn detecta_desglose_abc_tp_ta() {
        let filas = vec![
            // Fila de título: contiene "ingrediente" pero no unidad ni cantidad
            vec!["listado de ingredientes del casino".to_string()],
            vec![
                "ingrediente".to_string(),
                "unidad".to_string(),
                "a".to_string(),
                "b".to_string(),
                "c".to_string(),
                "tp".to_string(),
                "ta".to_string(),
            ],
        ];

        let columnas = detectar_columnas(&filas).expect("debe encontrar la cabecera");
        assert_eq!(columnas.fila_cabecera, 1);
        assert_eq!(columnas.nombre, 0);
        assert_eq!(columnas.unidad, 1);
        assert_eq!(columnas.cantidad, vec![2, 3, 4, 5, 6]);
    }

    #[test]
    fn detecta_desglose_con_prefijo() {
        let filas = vec![vec![
            "ingrediente".to_string(),
            "u/m".to_string(),
            "cantidad a".to_string(),
            "cant. b".to_string(),
        ]];

        let columnas = detectar_columnas(&filas).expect("debe encontrar la cabecera");
        assert_eq!(columnas.cantidad, vec![2, 3]);
    }

    #[test]
    fn sin_desglose_usa_la_primera_cantidad() {
        // Comportamiento histórico: una sola columna, la primera con "cantidad"
        let filas = vec![vec![
            "ingrediente".to_string(),
            "unidad".to_string(),
            "cantidad".to_string(),
            "cantidad total".to_string(),
        ]];

        let columnas = detectar_columnas(&filas).expect("debe encontrar la cabecera");
        assert_eq!(columnas.cantidad, vec![2]);
    }

    #[test]
    fn con_desglose_ignora_la_cantidad_generica() {
        // "Cantidad" junto a "A" suele ser el total ya calculado: sumarlo
        // duplicaría la cifra, así que gana el desglose.
        let filas = vec![vec![
            "ingrediente".to_string(),
            "unidad".to_string(),
            "cantidad".to_string(),
            "a".to_string(),
        ]];

        let columnas = detectar_columnas(&filas).expect("debe encontrar la cabecera");
        assert_eq!(columnas.cantidad, vec![3]);
    }

    #[test]
    fn no_inventa_cabecera_si_falta_la_cantidad() {
        let filas = vec![vec![
            "ingrediente".to_string(),
            "unidad".to_string(),
            "comentarios".to_string(),
        ]];

        assert!(detectar_columnas(&filas).is_none());
    }

    #[test]
    fn total_exacto_tiene_prioridad_sobre_el_desglose() {
        let filas = vec![vec![
            "ingrediente".to_string(),
            "unidad".to_string(),
            "a".to_string(),
            "b".to_string(),
            "total".to_string(),
        ]];

        let columnas = detectar_columnas(&filas).expect("debe encontrar la cabecera");

        // Solo la columna "Total": A y B se descartan por completo.
        assert_eq!(columnas.cantidad, vec![4]);
    }

    #[test]
    fn total_acepta_sus_variantes() {
        for cabecera in ["total", "TOTAL", "Total:", "Total  Cantidad", "TÓTAL", " Total "] {
            assert!(es_columna_total(cabecera), "debería aceptar {cabecera:?}");
        }
    }

    #[test]
    fn total_rechaza_columnas_monetarias_y_parecidas() {
        for cabecera in [
            "Costo Total",
            "Total Costo",
            "Valor Total",
            "Total Neto",
            "Precio Total",
            "Total $",
            "Total Bruto",
            "Importe Total",
            "Cantidad Costo",
            "subtotal",
            "total general",
        ] {
            assert!(
                !es_columna_total(cabecera),
                "no debería aceptar {cabecera:?} como cantidad"
            );
        }
    }

    #[test]
    fn total_gana_a_costo_total_en_la_misma_hoja() {
        let filas = vec![vec![
            "ingrediente".to_string(),
            "unidad".to_string(),
            "costo total".to_string(),
            "total".to_string(),
        ]];

        let columnas = detectar_columnas(&filas).expect("debe encontrar la cabecera");

        assert_eq!(columnas.cantidad, vec![3]); // "total", nunca "costo total"
    }

    #[test]
    fn total_manda_sobre_la_cantidad_generica() {
        let filas = vec![vec![
            "ingrediente".to_string(),
            "u/m".to_string(),
            "cantidad".to_string(),
            "total".to_string(),
        ]];

        let columnas = detectar_columnas(&filas).expect("debe encontrar la cabecera");

        assert_eq!(columnas.cantidad, vec![3]);
    }

    #[test]
    fn solo_costo_total_no_sirve_como_cantidad() {
        let filas = vec![vec![
            "ingrediente".to_string(),
            "unidad".to_string(),
            "costo total".to_string(),
        ]];

        // Sin una cantidad real no hay cabecera: mejor omitir la hoja que
        // usar el dinero como kilos.
        assert!(detectar_columnas(&filas).is_none());
    }

    #[test]
    fn lectura_usa_solo_total_cuando_existe() {
        let filas = vec![vec![
            "ingrediente".to_string(),
            "unidad".to_string(),
            "a".to_string(),
            "total".to_string(),
        ]];
        let columnas = detectar_columnas(&filas).expect("debe encontrar la cabecera");

        // A = 5, Total = 8 → debe usarse 8 (ni 5 ni 13)
        let fila = vec![
            Data::String("Harina".to_string()),
            Data::String("kg".to_string()),
            Data::String("5".to_string()),
            Data::String("8".to_string()),
        ];

        assert_eq!(cantidad_de_fila(&fila, &columnas.cantidad), 8.0);
    }

    #[test]
    fn cantidad_total_no_se_confunde_con_el_total_estricto() {
        // Es el encabezado que exporta la propia app y ya viene multiplicado:
        // tratarlo como total volvería a escalarlo al reimportar.
        assert!(!es_columna_total("Cantidad Total"));

        // Aun así sigue funcionando por la vía genérica de siempre.
        let filas = vec![vec![
            "ingrediente".to_string(),
            "unidad".to_string(),
            "cantidad total".to_string(),
        ]];
        let columnas = detectar_columnas(&filas).expect("debe encontrar la cabecera");
        assert_eq!(columnas.cantidad, vec![2]);
    }
}