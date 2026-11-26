use calamine::{open_workbook, Data, Reader, Xlsx};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use tauri::Emitter;
use tauri_plugin_store::StoreExt;
use crate::ajustes::{MapeoInsumos, UnidadEquivalencia};
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
    // Sin puntuación final (. , ; :)
    normalizar_base(nombre)
        .trim_end_matches(|c: char| matches!(c, '.' | ',' | ';' | ':'))
        .trim_end()
        .to_string()
}

/// Minúsculas, sin tildes y con los espacios colapsados, pero **sin** tocar la
/// puntuación. Se usa para las claves y para los prefijos de columna, que
/// necesitan conservar el punto de "cant.".
fn normalizar_base(nombre: &str) -> String {
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
    sin_tildes
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
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

/// Suma la cantidad de una fila recorriendo las columnas de cantidad
/// detectadas en la cabecera (normalmente una sola).
///
/// Las celdas vacías y los índices que se salen del rango de la fila aportan
/// `0.0`, así que una fila con un solo valor se resuelve con el mismo código.
fn cantidad_de_fila(fila: &[Data], columnas: &[usize]) -> f64 {
    columnas
        .iter()
        .filter_map(|&indice| fila.get(indice))
        .map(cantidad_de_celda)
        .sum()
}

/// Nombre de columna del ingrediente, comparado contra los sinónimos que el
/// usuario configuró en Ajustes → Mapeo de Insumos.
fn es_columna_ingrediente(celda: &str, reglas: &ReglasColumnas) -> bool {
    contiene_sinonimo(&normalizar_cabecera(celda), &reglas.sinonimos_ingrediente)
}

/// Nombre de columna de la unidad de medida ("U/M", "UM", "Unidad"…),
/// comparado contra los sinónimos configurados.
fn es_columna_unidad(celda: &str, reglas: &ReglasColumnas) -> bool {
    contiene_sinonimo(&normalizar_cabecera(celda), &reglas.sinonimos_unidad)
}

/// Normaliza una cabecera con las mismas reglas que los nombres de ingredientes
/// (minúsculas, sin tildes, espacios colapsados, sin puntuación final) para
/// poder compararla por igualdad o contención.
fn normalizar_cabecera(celda: &str) -> String {
    clave_ingrediente(celda)
}

/// ¿La cabecera (ya normalizada) coincide con alguno de los sinónimos?
///
/// Se compara por palabra completa para que sinónimos cortos ("um", "u/m") no
/// se cuelen dentro de otras palabras ("número"). Los sinónimos de 4 caracteres
/// o más también aceptan prefijos ("ingrediente" → "ingredientes", "material"
/// → "materiales"), manteniendo la tolerancia del comportamiento anterior.
fn contiene_sinonimo(cabecera_normalizada: &str, sinonimos: &[String]) -> bool {
    sinonimos.iter().any(|sinonimo| {
        if sinonimo.is_empty() {
            return false;
        }

        if cabecera_normalizada == sinonimo {
            return true;
        }

        cabecera_normalizada
            .split(|c: char| !c.is_alphanumeric() && c != '/')
            .filter(|parte| !parte.is_empty())
            .any(|parte| {
                parte == sinonimo
                    || (sinonimo.chars().count() >= 4 && parte.starts_with(sinonimo.as_str()))
            })
    })
}

/// Reglas de lectura derivadas de la configuración de "Mapeo de Insumos".
///
/// Todas las listas se guardan ya normalizadas (minúsculas, sin tildes, sin
/// duplicados) para compararlas contra la cabecera normalizada de cada hoja.
/// Así el backend no conserva ninguna lista fija de columnas: la única fuente
/// de verdad es `MapeoInsumos`.
#[derive(Clone, Debug)]
pub struct ReglasColumnas {
    pub sinonimos_ingrediente: Vec<String>,
    pub sinonimos_unidad: Vec<String>,
    pub sinonimos_cantidad: Vec<String>,
    pub sinonimos_total: Vec<String>,
    pub palabras_fila_ignorada: Vec<String>,
    /// Pares (variante normalizada, unidad estándar visible). Incluye también
    /// la propia forma estándar como variante reconocida.
    pub unidades: Vec<(String, String)>,
    pub filas_cabecera_ignoradas: usize,
    pub filas_escaneo_cabecera: usize,
}

impl Default for ReglasColumnas {
    fn default() -> Self {
        Self::desde_mapeo(&MapeoInsumos::default())
            .expect("los valores por defecto deben ser reglas válidas")
    }
}

impl ReglasColumnas {
    /// Valida y normaliza el mapeo antes de leer un Excel. Si falta una lista
    /// esencial devuelve un error en español pensado para mostrarse en el modal.
    pub fn desde_mapeo(mapeo: &MapeoInsumos) -> Result<Self, String> {
        let reglas = Self {
            sinonimos_ingrediente: normalizar_lista_ajustes(&mapeo.sinonimos_ingrediente),
            sinonimos_unidad: normalizar_lista_ajustes(&mapeo.sinonimos_unidad),
            sinonimos_cantidad: normalizar_lista_ajustes(&mapeo.sinonimos_cantidad),
            sinonimos_total: normalizar_lista_ajustes(&mapeo.sinonimos_total),
            palabras_fila_ignorada: normalizar_lista_ajustes(&mapeo.palabras_fila_ignorada),
            unidades: normalizar_unidades(&mapeo.unidades),
            filas_cabecera_ignoradas: mapeo.filas_cabecera_ignoradas.min(1_000) as usize,
            filas_escaneo_cabecera: mapeo.filas_escaneo_cabecera.min(500) as usize,
        };

        let mut faltantes: Vec<&str> = Vec::new();

        if reglas.sinonimos_ingrediente.is_empty() {
            faltantes.push("sinónimos de ingrediente");
        }
        if reglas.sinonimos_unidad.is_empty() {
            faltantes.push("sinónimos de unidad");
        }
        if reglas.sinonimos_cantidad.is_empty() && reglas.sinonimos_total.is_empty() {
            faltantes.push("sinónimos de cantidad o de total");
        }
        if reglas.filas_escaneo_cabecera == 0 {
            faltantes.push("filas a examinar buscando la cabecera (mínimo 1)");
        }

        if !faltantes.is_empty() {
            return Err(format!(
                "Faltan reglas de lectura en Ajustes → Mapeo de Insumos: {}. \
                 Agrega al menos un valor en cada lista y vuelve a procesar.",
                faltantes.join("; ")
            ));
        }

        Ok(reglas)
    }

    /// Devuelve la forma estándar de una unidad de medida ("LT" → "Litro"),
    /// o la unidad original si no hay equivalencia configurada.
    pub fn unidad_normalizada(&self, unidad: &str) -> String {
        let original = unidad.trim();
        let clave = normalizar_cabecera(original);

        if clave.is_empty() {
            return original.to_string();
        }

        self.unidades
            .iter()
            .find(|(variante, _)| variante == &clave)
            .map(|(_, estandar)| estandar.clone())
            .unwrap_or_else(|| original.to_string())
    }
}

/// Construye el mapa variante normalizada → unidad estándar.
///
/// La propia forma estándar se registra como variante para que "Litro",
/// "LITRO" y "litro" también se reconozcan. Si una variante se repite entre
/// dos unidades, gana la primera (orden de la tabla configurada).
fn normalizar_unidades(unidades: &[UnidadEquivalencia]) -> Vec<(String, String)> {
    let mut mapa: Vec<(String, String)> = Vec::new();

    for unidad in unidades {
        let estandar = unidad.estandar.trim().to_string();
        if estandar.is_empty() {
            continue;
        }

        let estandar_normalizado = normalizar_cabecera(&estandar);
        if !estandar_normalizado.is_empty()
            && !mapa
                .iter()
                .any(|(clave, _)| clave == &estandar_normalizado)
        {
            mapa.push((estandar_normalizado, estandar.clone()));
        }

        for variante in &unidad.variantes {
            let clave = normalizar_cabecera(variante);
            if clave.is_empty() || mapa.iter().any(|(existente, _)| existente == &clave) {
                continue;
            }

            mapa.push((clave, estandar.clone()));
        }
    }

    mapa
}

/// Normaliza cada valor de una lista de ajustes y descarta vacíos y duplicados
/// (sin distinguir mayúsculas, tildes ni espacios sobrantes).
fn normalizar_lista_ajustes(valores: &[String]) -> Vec<String> {
    let mut normalizados: Vec<String> = Vec::new();

    for valor in valores {
        let normalizado = normalizar_cabecera(valor);
        if normalizado.is_empty() || normalizados.contains(&normalizado) {
            continue;
        }

        normalizados.push(normalizado);
    }

    normalizados
}

/// ¿La cabecera es la columna autoritativa de cantidad total?
///
/// **Filtro estricto**: se compara por igualdad exacta contra los sinónimos de
/// total configurados (por defecto "total" y "total cantidad"). Nada de
/// `contains("total")`, porque eso aceptaría "Costo Total", "Total Costo",
/// "Valor Total" o "Total Neto", que son dinero y nunca se procesan.
fn es_columna_total(celda: &str, reglas: &ReglasColumnas) -> bool {
    let normalizada = normalizar_cabecera(celda);

    reglas
        .sinonimos_total
        .iter()
        .any(|sinonimo| sinonimo == &normalizada)
}

/// ¿La cabecera es una columna de cantidad genérica? Se compara contra la
/// lista única de sinónimos configurados (por defecto "cantidad", "cant",
/// "ctdad", "peso" y "q").
fn es_columna_cantidad_generica(celda: &str, reglas: &ReglasColumnas) -> bool {
    contiene_sinonimo(&normalizar_cabecera(celda), &reglas.sinonimos_cantidad)
}

/// Columnas ya identificadas en la fila de cabecera de una hoja.
#[derive(Debug)]
struct ColumnasHoja {
    /// Índice de la fila donde están los encabezados.
    fila_cabecera: usize,
    /// Índice de la columna del nombre del ingrediente.
    nombre: usize,
    /// Índice de la columna de la unidad de medida.
    unidad: usize,
    /// Índice de la columna de cantidad. Siempre una sola: la total si existe
    /// o, si no, la primera que coincida con los sinónimos de cantidad.
    cantidad: Vec<usize>,
}

/// Busca la fila de cabecera dentro de las primeras `filas_escaneo_cabecera`
/// filas y devuelve los índices de sus columnas.
///
/// Una fila es cabecera si reúne las tres piezas: nombre, unidad y al menos
/// una columna de cantidad. Si ninguna fila las reúne, devuelve un error que
/// explica qué columna faltó y qué sinónimos están configurados, para que la
/// interfaz pueda mostrarlo tal cual.
///
/// Jerarquía de la cantidad (de mayor a menor prioridad):
/// 1. **Total exacto** → es la única fuente.
/// 2. **Primera columna de cantidad** → cualquiera de la lista unificada de
///    sinónimos ("cantidad", "cant", "ctdad", "peso", "q"…).
fn detectar_columnas(
    filas: &[Vec<String>],
    reglas: &ReglasColumnas,
) -> Result<ColumnasHoja, String> {
    // Mejor fila parcial vista: (piezas reconocidas, descripción del fallo).
    let mut mejor: Option<(usize, String)> = None;

    for (indice_fila, celdas) in filas.iter().enumerate() {
        let mut nombre: Option<usize> = None;
        let mut unidad: Option<usize> = None;
        let mut cantidad_generica: Option<usize> = None;
        // Columna "Total" autoritativa (prioridad 1).
        let mut cantidad_total: Option<usize> = None;

        for (j, celda) in celdas.iter().enumerate() {
            if nombre.is_none() && es_columna_ingrediente(celda, reglas) {
                nombre = Some(j);
            } else if unidad.is_none() && es_columna_unidad(celda, reglas) {
                unidad = Some(j);
            } else if cantidad_total.is_none() && es_columna_total(celda, reglas) {
                cantidad_total = Some(j);
            } else if cantidad_generica.is_none()
                && es_columna_cantidad_generica(celda, reglas)
            {
                cantidad_generica = Some(j);
            }
        }

        let hay_cantidad = cantidad_total.is_some() || cantidad_generica.is_some();

        let mut faltantes: Vec<&str> = Vec::new();
        if nombre.is_none() {
            faltantes.push("ingrediente");
        }
        if unidad.is_none() {
            faltantes.push("unidad");
        }
        if !hay_cantidad {
            faltantes.push("cantidad");
        }

        // Cabecera completa: se devuelve de inmediato.
        if faltantes.is_empty() {
            // "Total" manda; si no existe, se usa la primera columna de
            // cantidad reconocida por la lista unificada.
            let cantidad = cantidad_total
                .or(cantidad_generica)
                .map(|indice| vec![indice])
                .expect("hay cantidad");

            return Ok(ColumnasHoja {
                fila_cabecera: indice_fila,
                nombre: nombre.expect("hay nombre"),
                unidad: unidad.expect("hay unidad"),
                cantidad,
            });
        }

        // Fila parcial: se conserva la que reconoció más piezas para explicar
        // el fallo con el mejor contexto posible.
        let reconocidas = 3 - faltantes.len();
        if reconocidas > 0 {
            let motivo = format!(
                "fila {}: {}",
                indice_fila + 1,
                describir_faltantes(&faltantes, reglas)
            );

            if mejor
                .as_ref()
                .is_none_or(|(puntos, _)| reconocidas > *puntos)
            {
                mejor = Some((reconocidas, motivo));
            }
        }
    }

    Err(match mejor {
        Some((_, motivo)) => format!(
            "no se encontró una cabecera completa ({motivo}). \
             Revisa los sinónimos en Ajustes → Mapeo de Insumos."
        ),
        None => format!(
            "no se reconoció ninguna columna de ingrediente, unidad ni cantidad \
             en las {} filas revisadas (sinónimos actuales: ingrediente [{}], unidad [{}], \
             cantidad [{}]). Revisa Ajustes → Mapeo de Insumos.",
            filas.len(),
            reglas.sinonimos_ingrediente.join(", "),
            reglas.sinonimos_unidad.join(", "),
            reglas.sinonimos_cantidad.join(", ")
        ),
    })
}

/// Texto en español con las columnas que faltaron y los sinónimos vigentes.
fn describir_faltantes(faltantes: &[&str], reglas: &ReglasColumnas) -> String {
    let mut piezas: Vec<String> = Vec::new();

    for falta in faltantes {
        match *falta {
            "ingrediente" => piezas.push(format!(
                "falta la columna de ingrediente (sinónimos: {})",
                reglas.sinonimos_ingrediente.join(", ")
            )),
            "unidad" => piezas.push(format!(
                "falta la columna de unidad (sinónimos: {})",
                reglas.sinonimos_unidad.join(", ")
            )),
            "cantidad" => piezas.push(format!(
                "falta una columna de cantidad (sinónimos: [{}]; total: [{}])",
                reglas.sinonimos_cantidad.join(", "),
                reglas.sinonimos_total.join(", ")
            )),
            otro => piezas.push(format!("falta la columna de {otro}")),
        }
    }

    piezas.join("; ")
}

// --- 3. Comandos ---

#[tauri::command]
pub fn obtener_hojas_excel(ruta: String) -> Result<Vec<String>, String> {
    let workbook: Xlsx<_> =
        open_workbook(&ruta).map_err(|e| format!("Error abriendo Excel: {}", e))?;
    Ok(workbook.sheet_names().to_owned())
}

/// Resultado de leer una o varias hojas de un archivo.
///
/// `advertencias` incluye las hojas que no se pudieron leer o cuya cabecera no
/// se reconoció, para que la interfaz las muestre aunque el resto del archivo
/// sí se haya procesado.
/// Resultado aislado de una hoja. El frontend necesita este desglose para
/// aplicar el grupo vinculado a cada hoja por separado; `ingredientes` del
/// resultado general sigue siendo la consolidación de todo el archivo.
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ResultadoHojaProcesada {
    pub nombre: String,
    pub ingredientes: Vec<IngredienteConsolidado>,
    /// Filas de ingrediente válidas leídas de la hoja (antes de consolidar).
    #[serde(default)]
    pub filas_validas: usize,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ResultadoProcesamientoHojas {
    pub ingredientes: Vec<IngredienteConsolidado>,
    pub advertencias: Vec<String>,
    /// Hojas que aportaron al menos una fila válida. El frontend las cuenta
    /// para el indicador "X hojas procesadas" de la barra central: una hoja
    /// ilegible, sin columnas válidas o sin datos no debe sumar.
    #[serde(default)]
    pub hojas_procesadas: usize,
    /// Desglose por hoja (solo hojas con filas válidas). Mantiene el vínculo
    /// hoja → grupo independiente del resto del archivo.
    #[serde(default)]
    pub detalle_hojas: Vec<ResultadoHojaProcesada>,
}

// --- PROGRESO DE HOJAS ---
// El frontend escucha este evento para animar el spinner del panel izquierdo
// mientras el backend sigue leyendo hojas. El número visible del badge, en
// cambio, lo calcula el JS con la selección del usuario. Se emite desde este
// módulo porque es el único que sabe cuándo empieza y termina cada hoja.
const EVENTO_HOJAS_PROCESANDO: &str = "hojas-procesando";

/// Hojas pendientes de todas las lecturas activas. Es global a propósito: el
/// frontend puede lanzar un procesamiento nuevo antes de que termine el
/// anterior (autoprocesado), y el indicador debe reflejar el trabajo real del
/// backend, no una sola invocación.
static HOJAS_EN_PROCESO: AtomicUsize = AtomicUsize::new(0);

fn emitir_hojas_procesando(app: &tauri::AppHandle, cantidad: usize) {
    let _ = app.emit(EVENTO_HOJAS_PROCESANDO, cantidad);
}

fn sumar_hojas(app: &tauri::AppHandle, cantidad: usize) {
    if cantidad == 0 {
        return;
    }

    let total = HOJAS_EN_PROCESO.fetch_add(cantidad, Ordering::SeqCst) + cantidad;
    emitir_hojas_procesando(app, total);
}

fn restar_hoja(app: &tauri::AppHandle) {
    // `fetch_update` con `saturating_sub` evita que un desbalance deje el
    // contador en un valor imposible (nunca baja de 0).
    let anterior = HOJAS_EN_PROCESO
        .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |valor| {
            Some(valor.saturating_sub(1))
        })
        .unwrap_or_default();

    emitir_hojas_procesando(app, anterior.saturating_sub(1));
}

/// Descuenta la hoja al salir de su iteración, también en los `continue` de
/// error. Así cualquier salida nueva no puede olvidar actualizar el contador.
struct FinDeHoja<'a> {
    app: &'a tauri::AppHandle,
}

impl Drop for FinDeHoja<'_> {
    fn drop(&mut self) {
        restar_hoja(self.app);
    }
}

/// Lee las hojas indicadas aplicando las reglas configuradas por el usuario.
///
/// `mapeo` puede llegar desde el frontend (que ya lo tiene cargado) o ser
/// `None`, en cuyo caso se lee del Store (`config.json`, clave
/// `mapeo_insumos`). Así ninguna regla de detección queda fija en el backend.
#[tauri::command]
pub fn procesar_hojas_excel(
    app: tauri::AppHandle,
    ruta: String,
    nombres_hojas: Vec<String>,
    mapeo: Option<MapeoInsumos>,
) -> Result<ResultadoProcesamientoHojas, String> {
    let mapeo = match mapeo {
        Some(mapeo) => mapeo,
        None => crate::ajustes::obtener_mapeo_insumos(app.clone())?,
    };

    // Validación temprana: si falta una regla esencial se devuelve un error
    // legible en vez de fallar hoja por hoja.
    let reglas = ReglasColumnas::desde_mapeo(&mapeo)?;

    procesar_archivo_con_reglas(&ruta, nombres_hojas, &reglas, Some(&app))
}

/// Unidad aplicada cuando la fila no indica una. Antes era configurable desde
/// "Importación y Excel"; ahora es un valor fijo para no perder filas.
const UNIDAD_POR_DEFECTO: &str = "UNIDAD";

/// Suma una fila ya validada al mapa indicado, conservando la variante de
/// nombre con mejor puntuación. Se usa tanto para el total del archivo como
/// para el desglose por hoja.
fn acumular_ingrediente(
    mapa: &mut HashMap<String, IngredienteConsolidado>,
    nombre: &str,
    unidad: &str,
    cantidad: f64,
) {
    let clave_nombre = clave_ingrediente(nombre);
    let clave = format!("{}|{}", clave_nombre, unidad.to_lowercase());
    let entry = mapa
        .entry(clave.clone())
        .or_insert_with(|| IngredienteConsolidado {
            nombre: nombre_visible(nombre),
            unidad: unidad.to_string(),
            cantidad: 0.0,
            clave,
            clave_ingrediente: clave_nombre,
            opciones_codigo: Vec::new(),
            codigo_seleccionado: String::new(),
        });

    if puntuacion_nombre(nombre) > puntuacion_nombre(&entry.nombre) {
        entry.nombre = nombre_visible(nombre);
    }

    entry.cantidad += cantidad;
}

/// Núcleo de lectura separado del comando: así se puede probar con un `.xlsx`
/// real sin necesitar un `AppHandle` de Tauri.
fn procesar_archivo_con_reglas(
    ruta: &str,
    nombres_hojas: Vec<String>,
    reglas: &ReglasColumnas,
    app: Option<&tauri::AppHandle>,
) -> Result<ResultadoProcesamientoHojas, String> {
    if nombres_hojas.is_empty() {
        return Err("No hay hojas seleccionadas para procesar.".to_string());
    }

    let mut workbook: Xlsx<_> =
        open_workbook(ruta).map_err(|e| format!("Error abriendo Excel: {}", e))?;
    let mut mapa: HashMap<String, IngredienteConsolidado> = HashMap::new();
    let mut advertencias: Vec<String> = Vec::new();
    let mut hojas_procesadas: usize = 0;
    let mut detalle_hojas: Vec<ResultadoHojaProcesada> = Vec::new();

    // Se cuenta solo cuando el archivo se abrió bien: un error temprano no
    // debe dejar hojas contadas para siempre.
    if let Some(app) = app {
        sumar_hojas(app, nombres_hojas.len());
    }

    for nombre_hoja in nombres_hojas {
        // El guard descuenta la hoja al terminar la iteración, incluidos los
        // `continue` de hoja ilegible o columnas no reconocidas.
        let _fin_de_hoja = app.map(|app| FinDeHoja { app });

        let range = match workbook.worksheet_range(&nombre_hoja) {
            Ok(r) => r,
            Err(_) => {
                advertencias.push(format!(
                    "Hoja «{nombre_hoja}»: no se pudo leer su contenido."
                ));
                continue;
            }
        };

        // Solo se miran las primeras filas: arriba suelen venir logos y
        // títulos. `filas_cabecera_ignoradas` desplaza la ventana de búsqueda.
        let filas_cabecera: Vec<Vec<String>> = range
            .rows()
            .skip(reglas.filas_cabecera_ignoradas)
            .take(reglas.filas_escaneo_cabecera)
            .map(|row| {
                row.iter()
                    .map(|c| c.to_string().trim().to_lowercase())
                    .collect()
            })
            .collect();

        let columnas = match detectar_columnas(&filas_cabecera, &reglas) {
            Ok(columnas) => columnas,
            Err(motivo) => {
                advertencias.push(format!("Hoja «{nombre_hoja}»: {motivo}"));
                continue;
            }
        };

        let fila_inicial = reglas.filas_cabecera_ignoradas + columnas.fila_cabecera + 1;
        let mut filas_validas = 0usize;
        let mut mapa_hoja: HashMap<String, IngredienteConsolidado> = HashMap::new();

        for row in range.rows().skip(fila_inicial) {
            let nombre = row
                .get(columnas.nombre)
                .map(|c| c.to_string().trim().to_string())
                .unwrap_or_default();
            let mut um = row
                .get(columnas.unidad)
                .map(|c| c.to_string().trim().to_string())
                .unwrap_or_default();

            // Unidad fija para celdas que vienen vacías: ya no se configura
            // desde el modal, pero se conserva el comportamiento histórico.
            if um.is_empty() {
                um = UNIDAD_POR_DEFECTO.to_string();
            }

            if nombre.is_empty() || um.is_empty() {
                continue;
            }

            // Unificación de unidades: "LT", "lts" y "litro" pasan a la misma
            // forma estándar antes de consolidar por nombre + unidad.
            let um = reglas.unidad_normalizada(&um);

            // Cabeceras repetidas u otras filas que el usuario marcó como no
            // dato ("material", "descripción"…).
            let nombre_normalizado = clave_ingrediente(&nombre);
            if reglas
                .palabras_fila_ignorada
                .iter()
                .any(|palabra| nombre_normalizado.contains(palabra.as_str()))
            {
                continue;
            }

            // Cantidad de la columna detectada (total o la primera cantidad).
            let cantidad = cantidad_de_fila(row, &columnas.cantidad);

            // Se acumula dos veces: en la hoja (para el cálculo por hoja) y en
            // el total del archivo (para la tabla consolidada de siempre).
            acumular_ingrediente(&mut mapa_hoja, &nombre, &um, cantidad);
            acumular_ingrediente(&mut mapa, &nombre, &um, cantidad);
            filas_validas += 1;
        }

        // Solo suma la hoja si aportó al menos una fila válida: una hoja con
        // cabecera pero sin datos no alimenta la tabla.
        if filas_validas > 0 {
            hojas_procesadas += 1;

            if !mapa_hoja.is_empty() {
                let mut ingredientes_hoja: Vec<IngredienteConsolidado> =
                    mapa_hoja.into_values().collect();
                ingredientes_hoja
                    .sort_by(|a, b| clave_ingrediente(&a.nombre).cmp(&clave_ingrediente(&b.nombre)));

                detalle_hojas.push(ResultadoHojaProcesada {
                    nombre: nombre_hoja,
                    ingredientes: ingredientes_hoja,
                    filas_validas,
                });
            }
        }
    }

    let mut ingredientes: Vec<IngredienteConsolidado> = mapa.into_values().collect();
    ingredientes.sort_by(|a, b| clave_ingrediente(&a.nombre).cmp(&clave_ingrediente(&b.nombre)));

    if ingredientes.is_empty() {
        let detalle = if advertencias.is_empty() {
            "Las hojas seleccionadas no contienen filas de ingredientes válidas \
             (se necesita un nombre y una unidad en cada fila)."
                .to_string()
        } else {
            format!(
                "No se pudo leer ninguna hoja:\n- {}",
                advertencias.join("\n- ")
            )
        };

        return Err(detalle);
    }

    Ok(ResultadoProcesamientoHojas {
        ingredientes,
        advertencias,
        hojas_procesadas,
        detalle_hojas,
    })
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
    fn suma_una_o_varias_columnas_de_cantidad() {
        // La detección devuelve una sola columna, pero la suma sigue siendo
        // tolerante a varios índices (celdas vacías o fuera de rango).
        let fila = vec![
            Data::String("5".to_string()),
            Data::String("3".to_string()),
            Data::Empty,
            Data::String("2".to_string()),
        ];

        assert_eq!(cantidad_de_fila(&fila, &[0, 1, 3]), 10.0);
        assert_eq!(cantidad_de_fila(&fila, &[0]), 5.0);
        assert_eq!(cantidad_de_fila(&fila, &[0, 2, 99]), 5.0);
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
    fn detecta_la_primera_columna_de_cantidad_con_etiquetas() {
        let filas = vec![
            // Fila de título: contiene "ingrediente" pero no unidad ni cantidad
            vec!["listado de ingredientes del casino".to_string()],
            vec![
                "ingrediente".to_string(),
                "unidad".to_string(),
                "cantidad a".to_string(),
                "cantidad b".to_string(),
                "tp".to_string(),
                "ta".to_string(),
            ],
        ];

        let columnas =
            detectar_columnas(&filas, &ReglasColumnas::default()).expect("debe encontrar la cabecera");
        assert_eq!(columnas.fila_cabecera, 1);
        assert_eq!(columnas.nombre, 0);
        assert_eq!(columnas.unidad, 1);
        // Se usa la primera columna que coincide con la lista de cantidad.
        assert_eq!(columnas.cantidad, vec![2]);
    }

    #[test]
    fn detecta_cantidad_con_prefijo() {
        let filas = vec![vec![
            "ingrediente".to_string(),
            "u/m".to_string(),
            "cantidad a".to_string(),
            "cant. b".to_string(),
        ]];

        let columnas =
            detectar_columnas(&filas, &ReglasColumnas::default()).expect("debe encontrar la cabecera");
        assert_eq!(columnas.cantidad, vec![2]);
    }

    #[test]
    fn sin_total_usa_la_primera_cantidad() {
        // Comportamiento histórico: una sola columna, la primera con "cantidad"
        let filas = vec![vec![
            "ingrediente".to_string(),
            "unidad".to_string(),
            "cantidad".to_string(),
            "cantidad total".to_string(),
        ]];

        let columnas =
            detectar_columnas(&filas, &ReglasColumnas::default()).expect("debe encontrar la cabecera");
        assert_eq!(columnas.cantidad, vec![2]);
    }

    #[test]
    fn ignora_las_etiquetas_sueltas_sin_sinonimo() {
        // "a" ya no es una etiqueta de cantidad: solo cuenta la lista única.
        let filas = vec![vec![
            "ingrediente".to_string(),
            "unidad".to_string(),
            "cantidad".to_string(),
            "a".to_string(),
        ]];

        let columnas =
            detectar_columnas(&filas, &ReglasColumnas::default()).expect("debe encontrar la cabecera");
        assert_eq!(columnas.cantidad, vec![2]);
    }

    #[test]
    fn no_inventa_cabecera_si_falta_la_cantidad() {
        let filas = vec![vec![
            "ingrediente".to_string(),
            "unidad".to_string(),
            "comentarios".to_string(),
        ]];

        assert!(detectar_columnas(&filas, &ReglasColumnas::default()).is_err());
    }

    #[test]
    fn total_exacto_tiene_prioridad_sobre_otras_columnas() {
        let filas = vec![vec![
            "ingrediente".to_string(),
            "unidad".to_string(),
            "a".to_string(),
            "b".to_string(),
            "total".to_string(),
        ]];

        let columnas =
            detectar_columnas(&filas, &ReglasColumnas::default()).expect("debe encontrar la cabecera");

        // Solo la columna "Total": A y B se descartan por completo.
        assert_eq!(columnas.cantidad, vec![4]);
    }

    #[test]
    fn total_acepta_sus_variantes() {
        for cabecera in ["total", "TOTAL", "Total:", "Total  Cantidad", "TÓTAL", " Total "] {
            assert!(
                es_columna_total(cabecera, &ReglasColumnas::default()),
                "debería aceptar {cabecera:?}"
            );
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
                !es_columna_total(cabecera, &ReglasColumnas::default()),
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

        let columnas =
            detectar_columnas(&filas, &ReglasColumnas::default()).expect("debe encontrar la cabecera");

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

        let columnas =
            detectar_columnas(&filas, &ReglasColumnas::default()).expect("debe encontrar la cabecera");

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
        assert!(detectar_columnas(&filas, &ReglasColumnas::default()).is_err());
    }

    #[test]
    fn lectura_usa_solo_total_cuando_existe() {
        let filas = vec![vec![
            "ingrediente".to_string(),
            "unidad".to_string(),
            "a".to_string(),
            "total".to_string(),
        ]];
        let columnas =
            detectar_columnas(&filas, &ReglasColumnas::default()).expect("debe encontrar la cabecera");

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
        assert!(!es_columna_total(
            "Cantidad Total",
            &ReglasColumnas::default()
        ));

        // Aun así sigue funcionando por la vía genérica de siempre.
        let filas = vec![vec![
            "ingrediente".to_string(),
            "unidad".to_string(),
            "cantidad total".to_string(),
        ]];
        let columnas =
            detectar_columnas(&filas, &ReglasColumnas::default()).expect("debe encontrar la cabecera");
        assert_eq!(columnas.cantidad, vec![2]);
    }

    // --- Reglas dinámicas provenientes de los ajustes ---

    fn mapeo_con(cambiar: impl FnOnce(&mut MapeoInsumos)) -> MapeoInsumos {
        let mut mapeo = MapeoInsumos::default();
        cambiar(&mut mapeo);
        mapeo
    }

    #[test]
    fn usa_los_sinonimos_configurados_por_el_usuario() {
        let mapeo = mapeo_con(|mapeo| {
            mapeo.sinonimos_ingrediente = vec!["producto".to_string()];
            mapeo.sinonimos_unidad = vec!["medida".to_string()];
            mapeo.sinonimos_cantidad = vec!["qty".to_string()];
        });
        let reglas = ReglasColumnas::desde_mapeo(&mapeo).expect("reglas válidas");

        let filas = vec![vec![
            "producto".to_string(),
            "medida".to_string(),
            "qty".to_string(),
        ]];
        let columnas = detectar_columnas(&filas, &reglas).expect("debe detectar la cabecera");

        assert_eq!(columnas.nombre, 0);
        assert_eq!(columnas.unidad, 1);
        assert_eq!(columnas.cantidad, vec![2]);
    }

    #[test]
    fn los_sinonimos_anteriores_dejan_de_reconocerse() {
        let mapeo = mapeo_con(|mapeo| {
            mapeo.sinonimos_ingrediente = vec!["producto".to_string()];
        });
        let reglas = ReglasColumnas::desde_mapeo(&mapeo).expect("reglas válidas");

        // "ingrediente" ya no está configurado: la cabecera no se reconoce y
        // el error lo explica.
        let filas = vec![vec![
            "ingrediente".to_string(),
            "unidad".to_string(),
            "cantidad".to_string(),
        ]];
        let error = detectar_columnas(&filas, &reglas).expect_err("no debe detectar");

        assert!(error.contains("ingrediente"), "error inesperado: {error}");
    }

    #[test]
    fn una_lista_esencial_vacia_devuelve_error_controlado() {
        let mapeo = mapeo_con(|mapeo| {
            mapeo.sinonimos_ingrediente.clear();
        });

        let error = ReglasColumnas::desde_mapeo(&mapeo).expect_err("debe fallar");

        assert!(
            error.contains("sinónimos de ingrediente"),
            "error inesperado: {error}"
        );
        assert!(error.contains("Ajustes"), "error inesperado: {error}");
    }

    #[test]
    fn sin_ninguna_regla_de_cantidad_devuelve_error() {
        let mapeo = mapeo_con(|mapeo| {
            mapeo.sinonimos_cantidad.clear();
            mapeo.sinonimos_total.clear();
        });

        let error = ReglasColumnas::desde_mapeo(&mapeo).expect_err("debe fallar");

        assert!(
            error.contains("cantidad"),
            "error inesperado: {error}"
        );
    }

    #[test]
    fn la_lista_unica_reconoce_abreviaturas_de_cantidad() {
        let reglas = ReglasColumnas::default();

        for cabecera in ["Cantidad", "CANT.", "Ctdad", "Peso", "Q"] {
            assert!(
                es_columna_cantidad_generica(cabecera, &reglas),
                "debería reconocer {cabecera:?} como cantidad"
            );
        }

        // Las etiquetas sueltas ya no se consideran cantidad.
        for cabecera in ["A", "B", "TP", "TA", "Ingrediente", "Comentarios"] {
            assert!(
                !es_columna_cantidad_generica(cabecera, &reglas),
                "no debería reconocer {cabecera:?} como cantidad"
            );
        }
    }

    #[test]
    fn el_total_tambien_sale_de_los_ajustes() {
        let mapeo = mapeo_con(|mapeo| {
            mapeo.sinonimos_total = vec!["total final".to_string()];
        });
        let reglas = ReglasColumnas::desde_mapeo(&mapeo).expect("reglas válidas");

        assert!(es_columna_total("Total Final", &reglas));
        assert!(!es_columna_total("Total", &reglas));
    }

    #[test]
    fn el_error_de_cabecera_indica_la_columna_que_falta() {
        let filas = vec![vec![
            "ingrediente".to_string(),
            "unidad".to_string(),
            "comentarios".to_string(),
        ]];

        let error = detectar_columnas(&filas, &ReglasColumnas::default())
            .expect_err("no debe detectar");

        assert!(error.contains("cantidad"), "error inesperado: {error}");
        assert!(error.contains("sinónimos"), "error inesperado: {error}");
    }

    #[test]
    fn normaliza_tildes_y_mayusculas_de_los_sinonimos() {
        let mapeo = mapeo_con(|mapeo| {
            mapeo.sinonimos_ingrediente = vec!["  DESCRIPCIÓN  ".to_string()];
        });
        let reglas = ReglasColumnas::desde_mapeo(&mapeo).expect("reglas válidas");

        assert!(es_columna_ingrediente("Descripcion del insumo", &reglas));
    }

    #[test]
    fn los_sinonimos_cortos_no_coinciden_por_subcadena() {
        let reglas = ReglasColumnas::default();

        // "um" no debe aparecer dentro de "número".
        assert!(!es_columna_unidad("número de orden", &reglas));
        assert!(es_columna_unidad("UM", &reglas));
        assert!(es_columna_unidad("Unidad de medida", &reglas));

        // Los sinónimos largos conservan la tolerancia a plurales.
        assert!(es_columna_ingrediente("Ingredientes", &reglas));
        assert!(es_columna_ingrediente("Nombre del ingrediente", &reglas));
    }

    #[test]
    fn unifica_variantes_de_unidades() {
        let reglas = ReglasColumnas::default();

        assert_eq!(reglas.unidad_normalizada("LT"), "Litro");
        assert_eq!(reglas.unidad_normalizada("lts"), "Litro");
        assert_eq!(reglas.unidad_normalizada("litros"), "Litro");
        assert_eq!(reglas.unidad_normalizada("LITRO"), "Litro");
        assert_eq!(reglas.unidad_normalizada("KGS"), "Kilo");
        assert_eq!(reglas.unidad_normalizada("g"), "Gramo");
        assert_eq!(reglas.unidad_normalizada("UND"), "Unidad");

        // Una unidad sin equivalencia configurada se conserva.
        assert_eq!(reglas.unidad_normalizada("docena"), "docena");
    }

    #[test]
    fn las_equivalencias_de_unidades_son_configurables() {
        let mapeo = mapeo_con(|mapeo| {
            mapeo.unidades = vec![UnidadEquivalencia {
                estandar: "Bolsa".to_string(),
                variantes: vec!["bolsas".to_string(), "b".to_string()],
            }];
        });
        let reglas = ReglasColumnas::desde_mapeo(&mapeo).expect("reglas válidas");

        assert_eq!(reglas.unidad_normalizada("B"), "Bolsa");
        assert_eq!(reglas.unidad_normalizada("bolsas"), "Bolsa");
        // Al reemplazar la tabla, la equivalencia histórica de litro ya no aplica.
        assert_eq!(reglas.unidad_normalizada("LT"), "LT");
    }

    #[test]
    fn lee_un_xlsx_real_con_reglas_dinamicas() {
        use rust_xlsxwriter::Workbook;

        let ruta = std::env::temp_dir().join(format!(
            "appgastronomia_lectura_{}.xlsx",
            std::process::id()
        ));
        let ruta_texto = ruta.to_string_lossy().to_string();

        {
            let mut libro = Workbook::new();
            let hoja = libro.add_worksheet();

            // Fila 0: ruido, se ignora con `filas_cabecera_ignoradas = 1`.
            hoja.write_string(0, 0, "Reporte de bodega").unwrap();
            // Fila 1: cabecera con sinónimos personalizados.
            hoja.write_string(1, 0, "Producto").unwrap();
            hoja.write_string(1, 1, "Medida").unwrap();
            hoja.write_string(1, 2, "Qty").unwrap();
            // Datos.
            hoja.write_string(2, 0, "Harina").unwrap();
            hoja.write_string(2, 1, "kg").unwrap();
            hoja.write_number(2, 2, 2.5).unwrap();
            hoja.write_string(3, 0, "Sal").unwrap();
            hoja.write_string(3, 1, "g").unwrap();
            hoja.write_number(3, 2, 10.0).unwrap();
            // Cabecera repetida: debe descartarse por `palabras_fila_ignorada`.
            hoja.write_string(4, 0, "Material").unwrap();
            hoja.write_string(4, 1, "kg").unwrap();
            hoja.write_number(4, 2, 99.0).unwrap();

            libro.save(&ruta).expect("el xlsx de prueba debe guardarse");
        }

        let mapeo = mapeo_con(|mapeo| {
            mapeo.sinonimos_ingrediente = vec!["producto".to_string()];
            mapeo.sinonimos_unidad = vec!["medida".to_string()];
            mapeo.sinonimos_cantidad = vec!["qty".to_string()];
            mapeo.filas_cabecera_ignoradas = 1;
            mapeo.palabras_fila_ignorada = vec!["material".to_string()];
        });
        let reglas = ReglasColumnas::desde_mapeo(&mapeo).expect("reglas válidas");

        let resultado =
            procesar_archivo_con_reglas(&ruta_texto, vec!["Sheet1".to_string()], &reglas, None)
                .expect("debe leer el archivo");

        let _ = std::fs::remove_file(&ruta);

        assert!(
            resultado.advertencias.is_empty(),
            "advertencias inesperadas: {:?}",
            resultado.advertencias
        );
        assert_eq!(resultado.ingredientes.len(), 2);
        assert_eq!(resultado.hojas_procesadas, 1);
        assert_eq!(resultado.detalle_hojas.len(), 1);
        assert_eq!(resultado.detalle_hojas[0].nombre, "Sheet1");
        assert_eq!(resultado.detalle_hojas[0].ingredientes.len(), 2);
        assert_eq!(resultado.detalle_hojas[0].filas_validas, 2);

        let harina = resultado
            .ingredientes
            .iter()
            .find(|item| item.nombre == "Harina")
            .expect("debe estar Harina");
        assert_eq!(harina.unidad, "Kilo");
        assert!((harina.cantidad - 2.5).abs() < 1e-9);

        assert!(
            resultado
                .ingredientes
                .iter()
                .all(|item| !item.nombre.eq_ignore_ascii_case("Material")),
            "la cabecera repetida no debe llegar a los ingredientes"
        );
    }

    #[test]
    fn unifica_unidades_al_leer_un_xlsx() {
        use rust_xlsxwriter::Workbook;

        let ruta = std::env::temp_dir().join(format!(
            "appgastronomia_unidades_{}.xlsx",
            std::process::id()
        ));
        let ruta_texto = ruta.to_string_lossy().to_string();

        {
            let mut libro = Workbook::new();
            let hoja = libro.add_worksheet();

            hoja.write_string(0, 0, "Ingrediente").unwrap();
            hoja.write_string(0, 1, "Unidad").unwrap();
            hoja.write_string(0, 2, "Cantidad").unwrap();

            // La misma unidad escrita de tres formas distintas.
            for (indice, (unidad, cantidad)) in
                [("LT", 2.0), ("lts", 3.0), ("litro", 1.0)].iter().enumerate()
            {
                let fila = (indice + 1) as u32;
                hoja.write_string(fila, 0, "Aceite").unwrap();
                hoja.write_string(fila, 1, *unidad).unwrap();
                hoja.write_number(fila, 2, *cantidad).unwrap();
            }

            libro.save(&ruta).expect("el xlsx de prueba debe guardarse");
        }

        let reglas = ReglasColumnas::default();
        let resultado =
            procesar_archivo_con_reglas(&ruta_texto, vec!["Sheet1".to_string()], &reglas, None)
                .expect("debe leer el archivo");

        let _ = std::fs::remove_file(&ruta);

        assert!(resultado.advertencias.is_empty());
        assert_eq!(resultado.ingredientes.len(), 1);

        let aceite = &resultado.ingredientes[0];
        assert_eq!(aceite.nombre, "Aceite");
        assert_eq!(aceite.unidad, "Litro");
        assert!((aceite.cantidad - 6.0).abs() < 1e-9);
    }

    #[test]
    fn un_archivo_sin_cabecera_devuelve_error_con_el_motivo() {
        use rust_xlsxwriter::Workbook;

        let ruta = std::env::temp_dir().join(format!(
            "appgastronomia_sin_cabecera_{}.xlsx",
            std::process::id()
        ));
        let ruta_texto = ruta.to_string_lossy().to_string();

        {
            let mut libro = Workbook::new();
            let hoja = libro.add_worksheet();
            hoja.write_string(0, 0, "Foo").unwrap();
            hoja.write_string(0, 1, "Bar").unwrap();
            hoja.write_string(0, 2, "Baz").unwrap();
            libro.save(&ruta).expect("el xlsx de prueba debe guardarse");
        }

        let reglas = ReglasColumnas::default();
        let error =
            procesar_archivo_con_reglas(&ruta_texto, vec!["Sheet1".to_string()], &reglas, None)
                .expect_err("no debe leer nada");

        let _ = std::fs::remove_file(&ruta);

        assert!(
            error.contains("No se pudo leer ninguna hoja"),
            "error inesperado: {error}"
        );
        assert!(
            error.contains("Sheet1"),
            "el error debe indicar la hoja: {error}"
        );
    }
}