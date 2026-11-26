use serde::{Deserialize, Serialize};
use serde_json::json; // Para construir el Value
use std::sync::Mutex;
use tauri_plugin_store::StoreExt; // <-- Importante
use calamine::{open_workbook, Data, Range, Reader, Xlsx};
use std::collections::HashMap;

// 1. Definimos cómo se ve una sección (sin cambios)
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Seccion {
    pub id: u32,
    pub nombre: String,
    pub alumnos: u32,
    pub proporcion: f64,
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
    let mut id_lock = state
        .contador_id
        .lock()
        .map_err(|_| "Error al bloquear ID")?;
    let mut secciones_lock = state
        .secciones
        .lock()
        .map_err(|_| "Error al bloquear secciones")?;

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

/// Elimina todos los grupos guardados de grupos.json.
#[tauri::command]
pub fn eliminar_todos_los_grupos(app: tauri::AppHandle) -> Result<(), String> {
    let store = app.store("grupos.json").map_err(|e| e.to_string())?;

    store.clear();
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
        let proporcion_calculada = (seccion.alumnos as f64 / max_alumnos as f64) * 100.0;

        // Redondeamos a 1 decimal para que se vea limpio en la UI (ej. 50.0, 33.3)
        seccion.proporcion = (proporcion_calculada * 10.0).round() / 10.0;
    }

    Ok(secciones)
}

// --- 5. IMPORTACIÓN DE GRUPOS DESDE EXCEL ---
// El Excel del cliente trae una tabla con las columnas:
//   codigo | Asignatura | secciones | alumnos x seccion
// `secciones` resume cuántas secciones hay de cada jornada ("5D / 2V" = 5
// diurnas y 2 vespertinas) y `alumnos x seccion` es el alumnado de cada una.

/// Filas que se revisan buscando la fila de encabezados (arriba suele haber
/// títulos y logos).
const FILAS_ESCANEO_IMPORTACION: usize = 40;

/// Tope defensivo: un texto como "99999D" no debe crear miles de secciones.
const MAX_SECCIONES_POR_GRUPO: u32 = 500;

/// Largo máximo de una celda que puede considerarse encabezado. Las hojas de
/// horarios meten párrafos completos en una celda ("GAD402 - ...\n\nSección :
/// ...\n\nAlumnos: 17"); sin este límite, su "Alumnos:" se confundiría con la
/// columna de alumnado.
const MAX_LARGO_CABECERA: usize = 40;

// Configuración persistida en config.json (misma que el resto de ajustes).
const STORE_CONFIG: &str = "config.json";
const CLAVE_MAPEO_GRUPOS: &str = "mapeo_grupos";

/// Sinónimos de encabezados para la importación de grupos.
///
/// Cada lista reemplaza las palabras que antes estaban fijas en
/// `clasificar_cabecera`: codigo, Asignatura, secciones y alumnos.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct MapeoGrupos {
    pub codigo: Vec<String>,
    pub asignatura: Vec<String>,
    pub secciones: Vec<String>,
    pub alumnos: Vec<String>,
}

impl Default for MapeoGrupos {
    fn default() -> Self {
        Self {
            codigo: vec!["codigo".to_string(), "cod".to_string(), "clave".to_string()],
            asignatura: vec![
                "asignatura".to_string(),
                "materia".to_string(),
                "ramo".to_string(),
                "curso".to_string(),
            ],
            secciones: vec!["secciones".to_string(), "seccion".to_string()],
            alumnos: vec![
                "alumnos x seccion".to_string(),
                "alumnos".to_string(),
                "alumno".to_string(),
            ],
        }
    }
}

impl MapeoGrupos {
    /// Normaliza las listas para compararlas contra las cabeceras del Excel.
    fn normalizado(&self) -> Self {
        Self {
            codigo: normalizar_lista_sinonimos(&self.codigo),
            asignatura: normalizar_lista_sinonimos(&self.asignatura),
            secciones: normalizar_lista_sinonimos(&self.secciones),
            alumnos: normalizar_lista_sinonimos(&self.alumnos),
        }
    }
}

fn normalizar_lista_sinonimos(valores: &[String]) -> Vec<String> {
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

/// Valida que las cuatro listas tengan al menos un sinónimo utilizable.
fn validar_mapeo_grupos(mapeo: &MapeoGrupos) -> Result<(), String> {
    let mut faltantes: Vec<&str> = Vec::new();

    if mapeo.codigo.is_empty() {
        faltantes.push("Código");
    }
    if mapeo.asignatura.is_empty() {
        faltantes.push("Asignatura");
    }
    if mapeo.secciones.is_empty() {
        faltantes.push("Secciones");
    }
    if mapeo.alumnos.is_empty() {
        faltantes.push("Alumnos");
    }

    if faltantes.is_empty() {
        return Ok(());
    }

    Err(format!(
        "El Mapeo de Grupos necesita al menos un sinónimo para: {}. \
         Agrégalos en Ajustes → Mapeo de Grupos y vuelve a importar.",
        faltantes.join(", ")
    ))
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
pub struct SeccionImportada {
    /// Jornada de la sección: "D" (diurno) o "V" (vespertino).
    pub tipo: String,
    /// Alumnos de esa sección (el mismo valor para todas las de su fila).
    pub alumnos: u32,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
pub struct GrupoImportado {
    /// `[codigo] - [Asignatura]`, por ejemplo "GAD402 - Taller de Administración".
    pub nombre: String,
    pub codigo: String,
    pub asignatura: String,
    pub secciones: Vec<SeccionImportada>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TipoColumna {
    Codigo,
    Asignatura,
    Secciones,
    Alumnos,
}

#[derive(Debug, Clone, Copy)]
struct ColumnasImportacion {
    fila_cabecera: usize,
    codigo: usize,
    asignatura: usize,
    secciones: usize,
    alumnos: usize,
}

/// Minúsculas, sin tildes, espacios colapsados y sin puntuación final. Se usa
/// solo para comparar encabezados y para detectar nombres repetidos.
fn normalizar_cabecera(texto: &str) -> String {
    let sin_tildes: String = texto
        .chars()
        .map(|c| match c {
            'á' | 'Á' => 'a',
            'é' | 'É' => 'e',
            'í' | 'Í' => 'i',
            'ó' | 'Ó' => 'o',
            'ú' | 'Ú' | 'ü' | 'Ü' => 'u',
            otro => otro,
        })
        .collect();

    sin_tildes
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim_end_matches(|c: char| matches!(c, '.' | ',' | ';' | ':'))
        .trim()
        .to_string()
}

/// ¿La cabecera normalizada contiene el sinónimo como palabra/frase completa?
/// Se acotan ambos lados con espacios para no confundir "cod" con "codigo".
fn coincide_sinonimo(cabecera_normalizada: &str, sinonimos: &[String]) -> bool {
    if sinonimos.is_empty() {
        return false;
    }

    let acotada = format!(" {cabecera_normalizada} ");

    sinonimos.iter().any(|sinonimo| {
        !sinonimo.is_empty() && acotada.contains(&format!(" {sinonimo} "))
    })
}

/// Clasifica una celda de encabezado en una de las cuatro columnas que
/// necesita la importación, usando los sinónimos configurados por el usuario.
/// El orden importa: "alumnos x sección" debe ser alumnado (no secciones) y
/// "Código Asignatura" debe ser código.
///
/// Solo se aceptan etiquetas cortas de una línea. Las celdas de una hoja de
/// horarios contienen párrafos con "\n" y la frase "Alumnos: 17"; si se
/// aceptaran, esa celda secuestraría la columna de alumnado de la tabla real
/// (que puede estar más a la derecha en la misma fila).
fn clasificar_cabecera(texto: &str, mapeo: &MapeoGrupos) -> Option<TipoColumna> {
    if texto.contains('\n') || texto.contains('\r') {
        return None;
    }

    let cabecera = normalizar_cabecera(texto);
    if cabecera.is_empty() || cabecera.chars().count() > MAX_LARGO_CABECERA {
        return None;
    }

    if coincide_sinonimo(&cabecera, &mapeo.alumnos) {
        return Some(TipoColumna::Alumnos);
    }
    if coincide_sinonimo(&cabecera, &mapeo.secciones) {
        return Some(TipoColumna::Secciones);
    }
    if coincide_sinonimo(&cabecera, &mapeo.codigo) {
        return Some(TipoColumna::Codigo);
    }
    if coincide_sinonimo(&cabecera, &mapeo.asignatura) {
        return Some(TipoColumna::Asignatura);
    }

    None
}

/// Busca la primera fila con las cuatro columnas reconocidas.
fn detectar_columnas_importacion(
    filas: &[Vec<String>],
    mapeo: &MapeoGrupos,
) -> Option<ColumnasImportacion> {
    for (indice_fila, fila) in filas.iter().enumerate() {
        let mut codigo = None;
        let mut asignatura = None;
        let mut secciones = None;
        let mut alumnos = None;

        for (indice_columna, celda) in fila.iter().enumerate() {
            match clasificar_cabecera(celda, mapeo) {
                Some(TipoColumna::Codigo) if codigo.is_none() => codigo = Some(indice_columna),
                Some(TipoColumna::Asignatura) if asignatura.is_none() => {
                    asignatura = Some(indice_columna)
                }
                Some(TipoColumna::Secciones) if secciones.is_none() => {
                    secciones = Some(indice_columna)
                }
                Some(TipoColumna::Alumnos) if alumnos.is_none() => alumnos = Some(indice_columna),
                _ => {}
            }
        }

        if let (Some(codigo), Some(asignatura), Some(secciones), Some(alumnos)) =
            (codigo, asignatura, secciones, alumnos)
        {
            return Some(ColumnasImportacion {
                fila_cabecera: indice_fila,
                codigo,
                asignatura,
                secciones,
                alumnos,
            });
        }
    }

    None
}

/// Texto limpio de una celda (colapsa espacios y quita extremos).
fn texto_celda(fila: &[Data], indice: usize) -> String {
    fila.get(indice)
        .map(|celda| {
            celda
                .to_string()
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
        })
        .unwrap_or_default()
}

fn leer_numero(chars: &[char], inicio: usize) -> (u32, usize) {
    let mut numero: u32 = 0;
    let mut i = inicio;

    while i < chars.len() && chars[i].is_ascii_digit() {
        numero = numero
            .saturating_mul(10)
            .saturating_add(chars[i] as u32 - '0' as u32);
        i += 1;
    }

    (numero, i)
}

fn leer_palabra(chars: &[char], inicio: usize) -> (String, usize) {
    let mut palabra = String::new();
    let mut i = inicio;

    while i < chars.len() && chars[i].is_alphabetic() {
        palabra.push(chars[i]);
        i += 1;
    }

    (palabra, i)
}

/// Primer entero que aparece en el texto (sirve para "16 alumnos").
fn primer_entero(texto: &str) -> Option<u32> {
    let chars: Vec<char> = texto.chars().collect();

    for (i, c) in chars.iter().enumerate() {
        if c.is_ascii_digit() {
            return Some(leer_numero(&chars, i).0);
        }
    }

    None
}

/// Interpreta la columna `secciones` y devuelve (diurnas, vespertinas).
///
/// Formatos admitidos: "5D / 2V", "5 D, 2 V", "D5/V2", "5 diurnas y 2
/// vespertinas". Si el texto no indica jornada, se devuelve (0, 0) y
/// `secciones_desde_texto` lo interpreta como cantidad de secciones diurnas.
fn parsear_secciones(texto: &str) -> (u32, u32) {
    let chars: Vec<char> = normalizar_cabecera(texto).to_uppercase().chars().collect();
    let mut diurnas = 0u32;
    let mut vespertinas = 0u32;
    let mut i = 0usize;

    while i < chars.len() {
        let actual = chars[i];

        // "5D", "5 D", "5 diurnas"
        if actual.is_ascii_digit() {
            let (cantidad, fin_numero) = leer_numero(&chars, i);

            let mut j = fin_numero;
            while j < chars.len() && chars[j].is_whitespace() {
                j += 1;
            }

            if j < chars.len() && (chars[j] == 'D' || chars[j] == 'V') {
                if chars[j] == 'D' {
                    diurnas = diurnas.saturating_add(cantidad);
                } else {
                    vespertinas = vespertinas.saturating_add(cantidad);
                }
                i = j + 1;
                continue;
            }

            if j < chars.len() && chars[j].is_alphabetic() {
                let (palabra, fin_palabra) = leer_palabra(&chars, j);

                if palabra.starts_with("DIURN") {
                    diurnas = diurnas.saturating_add(cantidad);
                    i = fin_palabra;
                    continue;
                }
                if palabra.starts_with("VESPERT") {
                    vespertinas = vespertinas.saturating_add(cantidad);
                    i = fin_palabra;
                    continue;
                }
            }

            i = fin_numero;
            continue;
        }

        // "D5", "V 2"
        if actual == 'D' || actual == 'V' {
            let mut j = i + 1;
            while j < chars.len() && chars[j].is_whitespace() {
                j += 1;
            }

            if j < chars.len() && chars[j].is_ascii_digit() {
                let (cantidad, fin_numero) = leer_numero(&chars, j);

                if actual == 'D' {
                    diurnas = diurnas.saturating_add(cantidad);
                } else {
                    vespertinas = vespertinas.saturating_add(cantidad);
                }
                i = fin_numero;
                continue;
            }
        }

        i += 1;
    }

    (diurnas, vespertinas)
}

/// Convierte la celda de alumnos en un entero no negativo.
///
/// Se atiende el tipo real que entrega `calamine` en lugar de pasar siempre por
/// texto: los números de Excel llegan como `Data::Float` (o `Data::Int`) y deben
/// redondearse directamente. La versión anterior hacía `Data::to_string()` y
/// buscaba el primer tramo de dígitos, de modo que cualquier contenido textual
/// que no fuera un entero limpio (fechas, porcentajes, errores, celdas con
/// unidades) aportaba un número ajeno —de ahí los 0 y el 501—. Ahora:
/// * `Data::Int` → el valor tal cual.
/// * `Data::Float` → redondeado.
/// * `Data::String` → el primer entero del texto (respaldo para "16 alumnos").
/// * `Data::Empty` (y tipos sin sentido como fechas o errores) → 0.
fn numero_alumnos(celda: &Data) -> u32 {
    match celda {
        Data::Int(valor) => {
            if *valor <= 0 {
                0
            } else {
                (*valor).min(u32::MAX as i64) as u32
            }
        }
        Data::Float(valor) => {
            if !valor.is_finite() || *valor <= 0.0 {
                0
            } else {
                valor.round().min(u32::MAX as f64) as u32
            }
        }
        Data::String(texto) => primer_entero(texto).unwrap_or(0),
        Data::Bool(valor) => {
            if *valor {
                1
            } else {
                0
            }
        }
        Data::DurationIso(texto) => primer_entero(texto).unwrap_or(0),
        Data::DateTime(_) | Data::DateTimeIso(_) | Data::Error(_) | Data::Empty => 0,
    }
}

/// Genera una sección por cada cupo indicado en `secciones`.
fn secciones_desde_texto(texto: &str, alumnos: u32) -> Vec<SeccionImportada> {
    let (mut diurnas, vespertinas) = parsear_secciones(texto);

    // "7" sin D/V: se asume que son secciones diurnas.
    if diurnas == 0 && vespertinas == 0 {
        if let Some(total) = primer_entero(texto) {
            diurnas = total;
        }
    }

    let total = diurnas.saturating_add(vespertinas);
    if total == 0 || total > MAX_SECCIONES_POR_GRUPO {
        return Vec::new();
    }

    let mut secciones = Vec::with_capacity(total as usize);

    for _ in 0..diurnas {
        secciones.push(SeccionImportada {
            tipo: "D".to_string(),
            alumnos,
        });
    }
    for _ in 0..vespertinas {
        secciones.push(SeccionImportada {
            tipo: "V".to_string(),
            alumnos,
        });
    }

    secciones
}

/// Lee las filas de datos de una hoja ya identificada y fusiona los grupos
/// repetidos: el mismo nombre acumula las secciones de todas sus filas.
fn leer_grupos_de_hoja(
    range: &Range<Data>,
    columnas: &ColumnasImportacion,
    mapeo: &MapeoGrupos,
) -> Vec<GrupoImportado> {
    let mut grupos: HashMap<String, GrupoImportado> = HashMap::new();

    for fila in range.rows().skip(columnas.fila_cabecera + 1) {
        let codigo = texto_celda(fila, columnas.codigo);
        let asignatura = texto_celda(fila, columnas.asignatura);

        if codigo.is_empty() || asignatura.is_empty() {
            continue;
        }

        // Cabeceras repetidas en medio de la tabla.
        if clasificar_cabecera(&codigo, mapeo).is_some() {
            continue;
        }

        let alumnos = fila
            .get(columnas.alumnos)
            .map(numero_alumnos)
            .unwrap_or(0);
        let secciones = secciones_desde_texto(&texto_celda(fila, columnas.secciones), alumnos);

        if secciones.is_empty() {
            continue;
        }

        let nombre = format!("{codigo} - {asignatura}");
        let clave = normalizar_cabecera(&nombre);

        match grupos.get_mut(&clave) {
            Some(grupo) => grupo.secciones.extend(secciones),
            None => {
                grupos.insert(
                    clave,
                    GrupoImportado {
                        nombre,
                        codigo,
                        asignatura,
                        secciones,
                    },
                );
            }
        }
    }

    grupos.into_values().collect()
}

/// Núcleo sin `AppHandle`: se puede probar y reutilizar desde el comando.
fn importar_grupos_desde_ruta(
    ruta: &str,
    mapeo: &MapeoGrupos,
) -> Result<Vec<GrupoImportado>, String> {
    let ruta = ruta.trim();
    if ruta.is_empty() {
        return Err("No se indicó la ruta del archivo Excel.".to_string());
    }

    let mapeo = mapeo.normalizado();
    validar_mapeo_grupos(&mapeo)?;

    let mut workbook: Xlsx<_> =
        open_workbook(ruta).map_err(|e| format!("No se pudo abrir el archivo Excel: {e}"))?;

    let nombres_hojas = workbook.sheet_names().to_owned();

    // Se evalúan todas las hojas con la estructura esperada y se elige la que
    // tenga la tabla "más limpia": la que empieza más a la izquierda. Una hoja
    // de horarios puede llevar la misma tabla pegada a la derecha; en ese caso
    // la tabla real (que empieza en la columna A/B) debe ganar. El desempate es
    // por orden de hoja, así que se conserva la primera si hay copias.
    let mut mejor: Option<(usize, Vec<GrupoImportado>)> = None;
    let mut hoja_estructura_sin_filas: Option<String> = None;

    for nombre_hoja in nombres_hojas {
        let range = match workbook.worksheet_range(&nombre_hoja) {
            Ok(range) => range,
            Err(_) => continue,
        };

        let filas_encabezado: Vec<Vec<String>> = range
            .rows()
            .take(FILAS_ESCANEO_IMPORTACION)
            .map(|fila| fila.iter().map(|celda| celda.to_string()).collect())
            .collect();

        let columnas = match detectar_columnas_importacion(&filas_encabezado, &mapeo) {
            Some(columnas) => columnas,
            None => continue,
        };

        // Columna donde arranca la tabla reconocida. Cuanto más a la izquierda,
        // más probable es que sea la tabla real y no un bloque incrustado.
        let inicio = [
            columnas.codigo,
            columnas.asignatura,
            columnas.secciones,
            columnas.alumnos,
        ]
        .into_iter()
        .min()
        .unwrap_or(0);

        let mut grupos = leer_grupos_de_hoja(&range, &columnas, &mapeo);

        if grupos.is_empty() {
            if hoja_estructura_sin_filas.is_none() {
                hoja_estructura_sin_filas = Some(nombre_hoja);
            }
            continue;
        }

        grupos.sort_by_key(|grupo| normalizar_cabecera(&grupo.nombre));

        let reemplazar = match &mejor {
            None => true,
            Some((inicio_actual, _)) => inicio < *inicio_actual,
        };

        if reemplazar {
            mejor = Some((inicio, grupos));
        }
    }

    if let Some((_, grupos)) = mejor {
        return Ok(grupos);
    }

    if let Some(nombre_hoja) = hoja_estructura_sin_filas {
        return Err(format!(
            "La hoja «{nombre_hoja}» tiene las columnas esperadas, pero no contiene filas \
             de grupos válidas. Revisa que cada fila tenga código, asignatura y una cantidad \
             de secciones (por ejemplo \"5D / 2V\")."
        ));
    }

    Err(format!(
        "No se encontró ninguna hoja con las 4 columnas obligatorias. Se buscaron: \
         Código [{}], Asignatura [{}], Secciones [{}], Alumnos [{}]. \
         Revisa los encabezados del Excel o ajusta Ajustes → Mapeo de Grupos.",
        mapeo.codigo.join(", "),
        mapeo.asignatura.join(", "),
        mapeo.secciones.join(", "),
        mapeo.alumnos.join(", ")
    ))
}

/// Devuelve los sinónimos configurados para importar grupos.
#[tauri::command]
pub fn obtener_mapeo_grupos(app: tauri::AppHandle) -> Result<MapeoGrupos, String> {
    let store = app.store(STORE_CONFIG).map_err(|e| e.to_string())?;

    let Some(valor) = store.get(CLAVE_MAPEO_GRUPOS) else {
        return Ok(MapeoGrupos::default());
    };

    Ok(serde_json::from_value(valor).unwrap_or_default())
}

/// Guarda los sinónimos de columnas para la importación de grupos.
#[tauri::command]
pub fn guardar_mapeo_grupos(
    app: tauri::AppHandle,
    mapeo: MapeoGrupos,
) -> Result<(), String> {
    let store = app.store(STORE_CONFIG).map_err(|e| e.to_string())?;
    let valor = serde_json::to_value(&mapeo).map_err(|e| e.to_string())?;

    store.set(CLAVE_MAPEO_GRUPOS, valor);
    store.save().map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub fn importar_grupos_excel(
    app: tauri::AppHandle,
    ruta: String,
    sinonimos: Option<MapeoGrupos>,
) -> Result<Vec<GrupoImportado>, String> {
    let mapeo = match sinonimos {
        Some(mapeo) => mapeo,
        None => obtener_mapeo_grupos(app)?,
    };

    importar_grupos_desde_ruta(&ruta, &mapeo)
}

// --- Pruebas de la importación ---
#[cfg(test)]
mod pruebas_importacion {
    use super::*;

    #[test]
    fn interpreta_d_y_v_en_distintos_formatos() {
        assert_eq!(parsear_secciones("5D / 2V"), (5, 2));
        assert_eq!(parsear_secciones("5 D, 2 V"), (5, 2));
        assert_eq!(parsear_secciones("D5/V2"), (5, 2));
        assert_eq!(parsear_secciones("5 diurnas / 2 vespertinas"), (5, 2));
        assert_eq!(parsear_secciones("3V"), (0, 3));
    }

    #[test]
    fn genera_una_seccion_por_cupo() {
        let secciones = secciones_desde_texto("5D / 2V", 16);

        assert_eq!(secciones.len(), 7);
        assert_eq!(secciones.iter().filter(|s| s.tipo == "D").count(), 5);
        assert_eq!(secciones.iter().filter(|s| s.tipo == "V").count(), 2);
        assert!(secciones.iter().all(|s| s.alumnos == 16));
    }

    #[test]
    fn sin_marcador_usa_el_total_como_diurnas() {
        let secciones = secciones_desde_texto("7", 20);

        assert_eq!(secciones.len(), 7);
        assert!(secciones.iter().all(|s| s.tipo == "D" && s.alumnos == 20));
    }

    #[test]
    fn textos_invalidos_no_crean_secciones() {
        assert!(secciones_desde_texto("", 10).is_empty());
        assert!(secciones_desde_texto("999999D", 10).is_empty());
    }

    #[test]
    fn encabezados_se_reconocen_con_tildes_y_variantes() {
        let filas = vec![
            vec!["horario".to_string(), "lunes".to_string()],
            vec![
                "Código".to_string(),
                "Asignatura".to_string(),
                "Secciones".to_string(),
                "ALUMNOS X SECCIÓN".to_string(),
            ],
        ];

        let columnas =
            detectar_columnas_importacion(&filas, &MapeoGrupos::default())
                .expect("cabecera detectada");

        assert_eq!(columnas.fila_cabecera, 1);
        assert_eq!(
            (
                columnas.codigo,
                columnas.asignatura,
                columnas.secciones,
                columnas.alumnos
            ),
            (0, 1, 2, 3)
        );
    }

    #[test]
    fn codigo_asignatura_se_clasifica_como_codigo() {
        assert_eq!(
            clasificar_cabecera("Código Asignatura", &MapeoGrupos::default()),
            Some(TipoColumna::Codigo)
        );
        assert_eq!(
            clasificar_cabecera("Alumnos por sección", &MapeoGrupos::default()),
            Some(TipoColumna::Alumnos)
        );
    }

    #[test]
    fn alumnado_lee_el_tipo_de_celda() {
        // Números: se usan directamente, sin pasar por texto.
        assert_eq!(numero_alumnos(&Data::Float(16.0)), 16);
        assert_eq!(numero_alumnos(&Data::Int(23)), 23);

        // Decimales: se redondean al entero más cercano.
        assert_eq!(numero_alumnos(&Data::Float(16.4)), 16);
        assert_eq!(numero_alumnos(&Data::Float(16.6)), 17);

        // Texto: se conserva la extracción del primer entero.
        assert_eq!(numero_alumnos(&Data::String("16 alumnos".to_string())), 16);
        assert_eq!(numero_alumnos(&Data::String(String::new())), 0);

        // Vacío, negativo o no finito: 0 (nunca valores absurdos).
        assert_eq!(numero_alumnos(&Data::Empty), 0);
        assert_eq!(numero_alumnos(&Data::Float(-5.0)), 0);
        assert_eq!(numero_alumnos(&Data::Float(f64::NAN)), 0);
        assert_eq!(numero_alumnos(&Data::Float(f64::INFINITY)), 0);
    }

    #[test]
    fn lee_un_xlsx_real_y_fusiona_grupos_repetidos() {
        use rust_xlsxwriter::Workbook;

        let ruta = std::env::temp_dir().join(format!(
            "appgastronomia_grupos_prueba_{}.xlsx",
            std::process::id()
        ));

        let mut libro = Workbook::new();

        // Hoja que debe ignorarse (no tiene la estructura esperada).
        let horario = libro.add_worksheet();
        horario.set_name("Horario").unwrap();
        horario.write_string(0, 0, "Lunes").unwrap();

        let hoja = libro.add_worksheet();
        hoja.set_name("Grupos").unwrap();

        for (columna, texto) in [
            "codigo",
            "Asignatura",
            "secciones",
            "alumnos x seccion",
        ]
        .iter()
        .enumerate()
        {
            hoja.write_string(1, columna as u16, *texto).unwrap();
        }

        // Primera fila del grupo.
        hoja.write_string(2, 0, "GAD402").unwrap();
        hoja.write_string(2, 1, "Taller de Administración").unwrap();
        hoja.write_string(2, 2, "5D / 2V").unwrap();
        hoja.write_number(2, 3, 16).unwrap();

        // El mismo grupo vuelve a aparecer: sus secciones se fusionan.
        hoja.write_string(3, 0, "GAD402").unwrap();
        hoja.write_string(3, 1, "Taller de Administración").unwrap();
        hoja.write_string(3, 2, "1D").unwrap();
        hoja.write_number(3, 3, 10).unwrap();

        // Otro grupo con el alumnado escrito como texto: debe usar el respaldo
        // de `primer_entero` ("18 alumnos" → 18).
        hoja.write_string(4, 0, "MAT101").unwrap();
        hoja.write_string(4, 1, "Matemática").unwrap();
        hoja.write_string(4, 2, "2D").unwrap();
        hoja.write_string(4, 3, "18 alumnos").unwrap();

        libro.save(&ruta).unwrap();

        let grupos = importar_grupos_desde_ruta(ruta.to_str().unwrap(), &MapeoGrupos::default())
            .expect("la importación debe leer el archivo de prueba");
        let _ = std::fs::remove_file(&ruta);

        assert_eq!(grupos.len(), 2);
        assert_eq!(grupos[0].nombre, "GAD402 - Taller de Administración");
        assert_eq!(grupos[0].secciones.len(), 8);
        assert_eq!(
            grupos[0]
                .secciones
                .iter()
                .filter(|s| s.tipo == "D")
                .count(),
            6
        );
        assert_eq!(
            grupos[0]
                .secciones
                .iter()
                .filter(|s| s.tipo == "V")
                .count(),
            2
        );
        assert_eq!(grupos[0].secciones.last().unwrap().alumnos, 10);

        // Las siete secciones de la primera fila se escribieron como número (16)
        // en Excel; deben llegar con 16 alumnos, no con 0.
        assert!(
            grupos[0].secciones.iter().take(7).all(|s| s.alumnos == 16),
            "las secciones numéricas deben conservar sus alumnos: {:?}",
            grupos[0]
                .secciones
                .iter()
                .take(7)
                .map(|s| s.alumnos)
                .collect::<Vec<_>>()
        );

        // El alumnado escrito como texto también se interpreta.
        assert_eq!(grupos[1].nombre, "MAT101 - Matemática");
        assert_eq!(grupos[1].secciones.len(), 2);
        assert!(grupos[1].secciones.iter().all(|s| s.alumnos == 18));
    }

    #[test]
    fn las_celdas_de_horario_no_son_encabezados() {
        // Una celda de clase mezcla código, sección y "Alumnos: 16" en un
        // párrafo: no debe considerarse encabezado de alumnado.
        let parrafo =
            "GAD401 - Taller de Supervisión\n\nSección : D-AGA-N6-P1-C3\n\nAlumnos: 16";
        assert_eq!(
            clasificar_cabecera(parrafo, &MapeoGrupos::default()),
            None
        );

        // Una etiqueta desmesuradamente larga tampoco.
        let larga = format!("alumnos {}", "x".repeat(60));
        assert_eq!(
            clasificar_cabecera(&larga, &MapeoGrupos::default()),
            None
        );

        // Los encabezados reales siguen reconociéndose.
        assert_eq!(
            clasificar_cabecera("alumnos x seccion", &MapeoGrupos::default()),
            Some(TipoColumna::Alumnos)
        );
        assert_eq!(
            clasificar_cabecera("Alumnos por sección", &MapeoGrupos::default()),
            Some(TipoColumna::Alumnos)
        );
        assert_eq!(
            clasificar_cabecera("secciones", &MapeoGrupos::default()),
            Some(TipoColumna::Secciones)
        );
    }

    #[test]
    fn prefiere_la_tabla_real_sobre_la_incrustada_en_un_horario() {
        use rust_xlsxwriter::Workbook;

        let ruta = std::env::temp_dir().join(format!(
            "appgastronomia_horario_incrustado_{}.xlsx",
            std::process::id()
        ));

        let mut libro = Workbook::new();

        // Primera hoja: horario con la misma tabla pegada a la derecha y una
        // celda de clase que contiene "Alumnos:" en la columna A.
        let horario = libro.add_worksheet();
        horario.set_name("Horario").unwrap();
        horario
            .write_string(
                0,
                0,
                "GAD401 - Taller de Supervisión\n\nSección : D-AGA-N6-P1-C3\n\nAlumnos: 17",
            )
            .unwrap();
        horario.write_string(0, 8, "codigo").unwrap();
        horario.write_string(0, 9, "Asignatura").unwrap();
        horario.write_string(0, 10, "secciones").unwrap();
        horario.write_string(0, 11, "alumnos x seccion").unwrap();

        horario
            .write_string(1, 0, "GAH501 - Otra clase\n\nAlumnos: 30")
            .unwrap();
        horario.write_string(1, 8, "GAD401").unwrap();
        horario
            .write_string(1, 9, "Taller de Supervisión")
            .unwrap();
        horario.write_string(1, 10, "5D /2V").unwrap();
        horario.write_number(1, 11, 99).unwrap();

        // Segunda hoja: la tabla real, desde la columna A.
        let hoja = libro.add_worksheet();
        hoja.set_name("Grupos").unwrap();
        for (columna, texto) in [
            "codigo",
            "Asignatura",
            "secciones",
            "alumnos x seccion",
        ]
        .iter()
        .enumerate()
        {
            hoja.write_string(0, columna as u16, *texto).unwrap();
        }
        hoja.write_string(1, 0, "GAD401").unwrap();
        hoja.write_string(1, 1, "Taller de Supervisión").unwrap();
        hoja.write_string(1, 2, "5D /2V").unwrap();
        hoja.write_number(1, 3, 14).unwrap();

        libro.save(&ruta).unwrap();

        let grupos = importar_grupos_desde_ruta(ruta.to_str().unwrap(), &MapeoGrupos::default())
            .expect("la importación debe leer el archivo de prueba");
        let _ = std::fs::remove_file(&ruta);

        assert_eq!(grupos.len(), 1);
        assert_eq!(grupos[0].nombre, "GAD401 - Taller de Supervisión");
        assert_eq!(grupos[0].secciones.len(), 7);
        assert!(
            grupos[0].secciones.iter().all(|s| s.alumnos == 14),
            "debe ganar la tabla real (14) y no la incrustada (99) ni el 501 \
             del texto de la celda de horario: {:?}",
            grupos[0]
                .secciones
                .iter()
                .map(|s| s.alumnos)
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn el_mapeo_por_defecto_conserva_los_sinonimos_historicos() {
        let mapeo = MapeoGrupos::default();

        assert!(mapeo.codigo.contains(&"clave".to_string()));
        assert!(mapeo.asignatura.contains(&"materia".to_string()));
        assert!(mapeo.secciones.contains(&"seccion".to_string()));
        assert!(mapeo.alumnos.contains(&"alumnos x seccion".to_string()));
    }

    #[test]
    fn reconoce_columnas_con_sinonimos_personalizados() {
        let mut mapeo = MapeoGrupos::default();
        mapeo.codigo = vec!["clave".to_string()];
        mapeo.asignatura = vec!["modulo".to_string()];
        mapeo.secciones = vec!["n secciones".to_string()];
        mapeo.alumnos = vec!["estudiantes".to_string()];
        let mapeo = mapeo.normalizado();

        let filas = vec![vec![
            "Clave".to_string(),
            "Módulo".to_string(),
            "N Secciones".to_string(),
            "Estudiantes".to_string(),
        ]];

        let columnas = detectar_columnas_importacion(&filas, &mapeo)
            .expect("debe reconocer los sinónimos personalizados");

        assert_eq!(
            (
                columnas.codigo,
                columnas.asignatura,
                columnas.secciones,
                columnas.alumnos
            ),
            (0, 1, 2, 3)
        );
    }

    #[test]
    fn un_mapeo_sin_sinonimos_devuelve_error_claro() {
        let mut mapeo = MapeoGrupos::default();
        mapeo.alumnos.clear();

        let error = importar_grupos_desde_ruta("archivo-inexistente.xlsx", &mapeo)
            .expect_err("debe validar el mapeo antes de abrir el archivo");

        assert!(error.contains("Alumnos"), "error inesperado: {error}");
        assert!(
            error.contains("Mapeo de Grupos"),
            "error inesperado: {error}"
        );
    }
}
