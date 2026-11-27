//! Benchmark de procesamiento de Excel sin UI ni Tauri.
//!
//! Mide, con `std::time::Instant`, cuánto tarda cada fase del pipeline real:
//!
//! 1. Apertura del libro y listado de hojas (sin filtro por nombre).
//! 2. Lectura del XML de cada hoja (`worksheet_range`).
//! 3. Normalización/parseo de filas (mismo código que usa la app).
//! 4. Consolidación entre archivos.
//! 5. Cruce con el Diccionario Maestro (`asignar_codigos`).
//!
//! Uso:
//!
//! ```text
//! cargo run --release --bin benchmark -- --path "C:\ruta\excels" \
//!     --diccionario "C:\ruta\diccionario.xlsx"
//! ```
//!
//! Opciones:
//!   --path <ruta>          Archivo .xlsx/.xlsm o carpeta que los contenga (obligatorio).
//!   --diccionario <ruta>   Excel del Diccionario Maestro (opcional).
//!   --limite <n>           Máximo de hojas a procesar en toda la corrida.
//!   --repeticiones <n>     Cuántas veces repetir la medición (por defecto 1).
//!   --recursivo            Buscar Excel también en subcarpetas.
//!   -h, --help             Muestra esta ayuda.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use consolidador_de_ingredientes_lib::excel::{
    asignar_codigos, consolidar_entre_archivos, leer_diccionario, procesar_rango_hoja,
    DiccionarioItem, IngredienteConsolidado, ReglasColumnas,
};
use calamine::{open_workbook, Reader, Xlsx};

/// Extensiones que el benchmark intenta abrir con calamine (`Xlsx`).
const EXTENSIONES: [&str; 2] = ["xlsx", "xlsm"];

struct Opciones {
    ruta: PathBuf,
    diccionario: Option<PathBuf>,
    repeticiones: usize,
    limite: Option<usize>,
    recursivo: bool,
}

struct MedicionArchivo {
    ruta: PathBuf,
    hojas_totales: usize,
    hojas_seleccionadas: usize,
    hojas_con_datos: usize,
    /// Hojas que quedaron fuera porque la corrida ya llegó al límite.
    fuera_por_limite: usize,
    apertura: Duration,
    lectura: Duration,
    parseo: Duration,
    ingredientes: usize,
    advertencias: Vec<String>,
}

struct MedicionCorrida {
    archivos: Vec<MedicionArchivo>,
    limite: Option<usize>,
    consolidacion: Duration,
    cruce: Duration,
    ingredientes: usize,
    total: Duration,
}

fn main() {
    match ejecutar() {
        Ok(()) => {}
        Err(mensaje) => {
            eprintln!("Error: {mensaje}");
            std::process::exit(1);
        }
    }
}

fn ejecutar() -> Result<(), String> {
    let opciones = match leer_argumentos()? {
        Some(opciones) => opciones,
        None => return Ok(()), // Se pidió --help
    };

    let archivos = buscar_exceles(&opciones.ruta, opciones.recursivo)?;
    if archivos.is_empty() {
        return Err(format!(
            "No se encontraron archivos .xlsx/.xlsm en «{}».",
            opciones.ruta.display()
        ));
    }

    let reglas = ReglasColumnas::default();

    // El diccionario se lee una sola vez, fuera de la medición del pipeline.
    let diccionario = match &opciones.diccionario {
        Some(ruta) => {
            let inicio = Instant::now();
            let items = leer_diccionario(ruta.to_string_lossy().to_string())?;
            println!(
                "Diccionario: {} entradas leídas en {} ({})",
                items.len(),
                formatear_duracion(inicio.elapsed()),
                ruta.display()
            );
            items
        }
        None => {
            println!("Diccionario: no indicado (se omite la fase de cruce).");
            Vec::new()
        }
    };

    println!(
        "Hojas: se procesan todas las disponibles (sin filtro por nombre).\n\
         Archivos a procesar: {} (reglas: mapeo por defecto{}).\n",
        archivos.len(),
        match opciones.limite {
            Some(limite) => format!("; límite: {limite} hojas"),
            None => String::new(),
        }
    );

    let mut corridas: Vec<MedicionCorrida> = Vec::with_capacity(opciones.repeticiones);

    for indice in 0..opciones.repeticiones {
        if opciones.repeticiones > 1 {
            println!("--- Corrida {}/{} ---", indice + 1, opciones.repeticiones);
        }

        let corrida = medir_corrida(&archivos, &diccionario, &reglas, opciones.limite)?;
        imprimir_corrida(&corrida, indice == 0);
        corridas.push(corrida);
    }

    if corridas.len() > 1 {
        imprimir_resumen(&corridas);
    }

    Ok(())
}

// --- Argumentos ---

fn leer_argumentos() -> Result<Option<Opciones>, String> {
    let mut args = std::env::args().skip(1);
    let mut ruta: Option<PathBuf> = None;
    let mut diccionario: Option<PathBuf> = None;
    let mut repeticiones = 1usize;
    let mut limite: Option<usize> = None;
    let mut recursivo = false;

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--path" | "-p" => {
                let valor = args
                    .next()
                    .ok_or_else(|| "Falta el valor de --path.".to_string())?;
                ruta = Some(PathBuf::from(valor));
            }
            "--diccionario" | "-d" => {
                let valor = args
                    .next()
                    .ok_or_else(|| "Falta el valor de --diccionario.".to_string())?;
                diccionario = Some(PathBuf::from(valor));
            }
            "--limite" | "-l" => {
                let valor = args
                    .next()
                    .ok_or_else(|| "Falta el valor de --limite.".to_string())?;
                let numero = valor.parse::<usize>().map_err(|_| {
                    format!("--limite debe ser un número entero positivo: «{valor}»")
                })?;

                if numero == 0 {
                    return Err("--limite debe ser mayor que 0.".to_string());
                }

                limite = Some(numero);
            }
            "--repeticiones" | "-r" => {
                let valor = args
                    .next()
                    .ok_or_else(|| "Falta el valor de --repeticiones.".to_string())?;
                repeticiones = valor
                    .parse::<usize>()
                    .map_err(|_| format!("--repeticiones debe ser un número entero: «{valor}»"))?
                    .max(1);
            }
            "--recursivo" => recursivo = true,
            "-h" | "--help" => {
                imprimir_ayuda();
                return Ok(None);
            }
            otro => return Err(format!("Opción desconocida: «{otro}». Usa --help.")),
        }
    }

    let ruta = ruta.ok_or_else(|| {
        "Falta --path. Ejemplo: cargo run --release --bin benchmark -- --path \"C:\\excels\""
            .to_string()
    })?;

    if !ruta.exists() {
        return Err(format!("La ruta no existe: {}", ruta.display()));
    }

    Ok(Some(Opciones {
        ruta,
        diccionario,
        repeticiones,
        limite,
        recursivo,
    }))
}

fn imprimir_ayuda() {
    println!(
        "Benchmark de procesamiento de Excel (sin UI)\n\
         \n\
         Uso:\n\
         \x20 cargo run --release --bin benchmark -- --path <ruta> [opciones]\n\
         \n\
         Opciones:\n\
         \x20 --path, -p <ruta>          Archivo .xlsx/.xlsm o carpeta con ellos (obligatorio).\n\
         \x20 --diccionario, -d <ruta>   Excel del Diccionario Maestro (opcional).\n\
         \x20 --limite, -l <n>           Máximo de hojas a procesar (todas por defecto).\n\
         \x20 --repeticiones, -r <n>     Repetir la medición n veces (por defecto 1).\n\
         \x20 --recursivo                Incluir subcarpetas al buscar Excel.\n\
         \x20 -h, --help                 Esta ayuda.\n\
         \n\
         Se procesan todas las hojas del libro; no se filtra por nombre.\n\
         El límite se aplica después de listar las hojas."
    );
}

// --- Búsqueda de archivos ---

fn buscar_exceles(ruta: &Path, recursivo: bool) -> Result<Vec<PathBuf>, String> {
    if ruta.is_file() {
        if es_excel(ruta) {
            return Ok(vec![ruta.to_path_buf()]);
        }
        return Err(format!(
            "El archivo no parece Excel (.xlsx/.xlsm): {}",
            ruta.display()
        ));
    }

    if !ruta.is_dir() {
        return Err(format!("La ruta no es archivo ni carpeta: {}", ruta.display()));
    }

    let mut encontrados = Vec::new();
    recorrer_carpeta(ruta, recursivo, &mut encontrados)
        .map_err(|e| format!("No se pudo leer «{}»: {e}", ruta.display()))?;
    encontrados.sort();
    Ok(encontrados)
}

fn recorrer_carpeta(
    carpeta: &Path,
    recursivo: bool,
    encontrados: &mut Vec<PathBuf>,
) -> std::io::Result<()> {
    for entrada in std::fs::read_dir(carpeta)? {
        let entrada = entrada?;
        let ruta = entrada.path();

        if ruta.is_dir() {
            if recursivo {
                recorrer_carpeta(&ruta, true, encontrados)?;
            }
            continue;
        }

        if es_excel(&ruta) {
            encontrados.push(ruta);
        }
    }

    Ok(())
}

fn es_excel(ruta: &Path) -> bool {
    ruta.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| {
            let extension = extension.to_ascii_lowercase();
            EXTENSIONES.contains(&extension.as_str())
        })
        .unwrap_or(false)
}

// --- Medición ---

fn medir_corrida(
    archivos: &[PathBuf],
    diccionario: &[DiccionarioItem],
    reglas: &ReglasColumnas,
    limite: Option<usize>,
) -> Result<MedicionCorrida, String> {
    let inicio_corrida = Instant::now();
    let mut mediciones = Vec::with_capacity(archivos.len());
    let mut todos: Vec<IngredienteConsolidado> = Vec::new();

    // El límite es global para la corrida: al llegar a N hojas se dejan de
    // procesar las siguientes, aunque pertenezcan a otro archivo.
    let mut cupo = limite;

    for ruta in archivos {
        let (medicion, ingredientes) = medir_archivo(ruta, reglas, cupo)?;

        if let Some(restante) = cupo.as_mut() {
            *restante = restante.saturating_sub(medicion.hojas_seleccionadas);
        }

        todos.extend(ingredientes);
        mediciones.push(medicion);
    }

    // Igual que la app: consolidar entre archivos y después cruzar el diccionario.
    let inicio_consolidacion = Instant::now();
    let consolidado = consolidar_entre_archivos(todos)?;
    let consolidacion = inicio_consolidacion.elapsed();

    let inicio_cruce = Instant::now();
    let cruzado = if diccionario.is_empty() {
        consolidado
    } else {
        asignar_codigos(consolidado, diccionario.to_vec())?
    };
    let cruce = inicio_cruce.elapsed();

    Ok(MedicionCorrida {
        archivos: mediciones,
        limite,
        consolidacion,
        cruce,
        ingredientes: cruzado.len(),
        total: inicio_corrida.elapsed(),
    })
}

fn medir_archivo(
    ruta: &Path,
    reglas: &ReglasColumnas,
    limite: Option<usize>,
) -> Result<(MedicionArchivo, Vec<IngredienteConsolidado>), String> {
    let ruta_texto = ruta.to_string_lossy().to_string();

    // Fase 1: abrir el libro y listar todas sus hojas. No hay filtro por
    // nombre; el límite opcional recorta la lista antes de leer contenidos.
    let inicio_apertura = Instant::now();
    let mut libro: Xlsx<_> =
        open_workbook(&ruta_texto).map_err(|e| format!("{ruta_texto}: {e}"))?;

    let mut hojas: Vec<String> = libro.sheet_names().to_owned();
    let hojas_totales = hojas.len();

    let cupo = limite.unwrap_or(usize::MAX);
    let fuera_por_limite = hojas.len().saturating_sub(cupo);
    hojas.truncate(cupo);

    let hojas_seleccionadas = hojas.len();
    let apertura = inicio_apertura.elapsed();

    let mut mapa_archivo: HashMap<String, IngredienteConsolidado> = HashMap::new();
    let mut lectura = Duration::ZERO;
    let mut parseo = Duration::ZERO;
    let mut hojas_con_datos = 0usize;
    let mut advertencias = Vec::new();

    for nombre_hoja in &hojas {
        // Fase 2: leer el contenido de la hoja.
        let inicio_lectura = Instant::now();
        let range = match libro.worksheet_range(nombre_hoja) {
            Ok(range) => range,
            Err(error) => {
                lectura += inicio_lectura.elapsed();
                advertencias.push(format!("Hoja «{nombre_hoja}»: {error}"));
                continue;
            }
        };
        lectura += inicio_lectura.elapsed();

        // Fase 3: detectar cabecera, normalizar y consolidar filas.
        let inicio_parseo = Instant::now();
        let mut mapa_hoja: HashMap<String, IngredienteConsolidado> = HashMap::new();
        match procesar_rango_hoja(&range, reglas, &mut mapa_hoja, &mut mapa_archivo) {
            Ok(filas_validas) => {
                if filas_validas > 0 {
                    hojas_con_datos += 1;
                }
            }
            Err(motivo) => advertencias.push(format!("Hoja «{nombre_hoja}»: {motivo}")),
        }
        parseo += inicio_parseo.elapsed();
    }

    let ingredientes: Vec<IngredienteConsolidado> = mapa_archivo.into_values().collect();
    let medicion = MedicionArchivo {
        ruta: ruta.to_path_buf(),
        hojas_totales,
        hojas_seleccionadas,
        hojas_con_datos,
        fuera_por_limite,
        apertura,
        lectura,
        parseo,
        ingredientes: ingredientes.len(),
        advertencias,
    };

    Ok((medicion, ingredientes))
}

// --- Salida ---

fn imprimir_corrida(corrida: &MedicionCorrida, detalle: bool) {
    if detalle {
        for archivo in &corrida.archivos {
            imprimir_archivo(archivo);
        }
        println!();
    }

    let hojas_totales: usize = corrida.archivos.iter().map(|a| a.hojas_totales).sum();
    let hojas_procesadas: usize = corrida
        .archivos
        .iter()
        .map(|a| a.hojas_seleccionadas)
        .sum();
    let hojas_con_datos: usize = corrida.archivos.iter().map(|a| a.hojas_con_datos).sum();
    let por_limite: usize = corrida.archivos.iter().map(|a| a.fuera_por_limite).sum();

    println!(
        "Apertura y listado: {}\n\
         Lectura de Excel:   {}\n\
         Normalización:      {}\n\
         Consolidación:      {}\n\
         Cruce diccionario:  {}\n\
         Ingredientes:       {}",
        formatear_duracion(corrida.apertura()),
        formatear_duracion(corrida.lectura()),
        formatear_duracion(corrida.parseo()),
        formatear_duracion(corrida.consolidacion),
        formatear_duracion(corrida.cruce),
        corrida.ingredientes
    );

    println!("\nDiagnóstico:");
    println!("- Criterio: se procesan todas las hojas (sin filtro por nombre).");
    println!("- Hojas totales: {hojas_totales}");
    println!("- Hojas procesadas: {hojas_procesadas}");
    if let Some(limite) = corrida.limite {
        println!("- Hojas fuera del límite (--limite {limite}): {por_limite}");
    }
    println!("- Hojas con filas válidas: {hojas_con_datos}");

    println!(
        "\nHojas totales: {}, Hojas procesadas: {}, Tiempo total: {}",
        hojas_totales,
        hojas_procesadas,
        formatear_duracion(corrida.total)
    );
}

fn imprimir_archivo(archivo: &MedicionArchivo) {
    println!("· {}", archivo.ruta.display());
    if archivo.hojas_totales == 0 {
        println!("  (sin hojas)");
        return;
    }

    println!(
        "  Hojas totales: {}, Seleccionadas: {}, Con filas válidas: {}",
        archivo.hojas_totales, archivo.hojas_seleccionadas, archivo.hojas_con_datos
    );
    println!(
        "  Apertura: {} | Lectura: {} | Normalización: {} | Ingredientes: {}",
        formatear_duracion(archivo.apertura),
        formatear_duracion(archivo.lectura),
        formatear_duracion(archivo.parseo),
        archivo.ingredientes
    );

    if archivo.fuera_por_limite > 0 {
        println!(
            "  · {} hoja(s) quedaron fuera por el límite.",
            archivo.fuera_por_limite
        );
    }

    for advertencia in &archivo.advertencias {
        println!("  Aviso: {advertencia}");
    }
}

fn imprimir_resumen(corridas: &[MedicionCorrida]) {
    let totales: Vec<Duration> = corridas.iter().map(|c| c.total).collect();
    let media = totales.iter().sum::<Duration>() / totales.len() as u32;
    let minimo = totales.iter().min().copied().unwrap_or_default();

    println!("\n--- Resumen de {} corridas ---", corridas.len());
    println!("Media: {}", formatear_duracion(media));
    println!("Mejor: {}", formatear_duracion(minimo));
}

fn formatear_duracion(duracion: Duration) -> String {
    let milisegundos = duracion.as_secs_f64() * 1_000.0;

    if milisegundos >= 1_000.0 {
        format!("{:.3} s", duracion.as_secs_f64())
    } else {
        format!("{milisegundos:.1} ms")
    }
}

impl MedicionCorrida {
    fn apertura(&self) -> Duration {
        sumar_duraciones(self.archivos.iter().map(|a| a.apertura))
    }

    fn lectura(&self) -> Duration {
        sumar_duraciones(self.archivos.iter().map(|a| a.lectura))
    }

    fn parseo(&self) -> Duration {
        sumar_duraciones(self.archivos.iter().map(|a| a.parseo))
    }
}

fn sumar_duraciones(duraciones: impl Iterator<Item = Duration>) -> Duration {
    duraciones.fold(Duration::ZERO, |acc, duracion| acc + duracion)
}
