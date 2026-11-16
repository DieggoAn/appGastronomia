# Appgastronomia — Guía técnica para la presentación

> **Cómo usar este documento:** las secciones 1 a 5 son el contenido que debes dominar. La sección 7 es un guion cronometrado para exponer. La sección 8 son las preguntas que probablemente te hagan, con la respuesta corta lista. La sección 9 es lo que conviene reconocer como limitación (decirlo tú antes de que te lo pregunten suma puntos).

**Frase de apertura (30 segundos):**

> "Appgastronomia es una aplicación de escritorio para consolidar planillas de ingredientes de cocina. El usuario carga varios Excel, la app detecta sola las columnas de ingrediente, unidad y cantidad, suma lo que se repite entre archivos, y le permite asignar grupos de comensales con porcentajes para calcular cuánto comprar. Todo el procesamiento de archivos y la matemática corre en Rust; la interfaz es HTML/CSS/JS puro sobre un WebView, sin frameworks."

---

# 1. Stack tecnológico

## 1.1 Las tres capas

| Capa | Tecnología | Rol concreto en esta app | Por qué esta elección |
|---|---|---|---|
| Contenedor | **Tauri 2** | Empaqueta la app como ejecutable nativo de Windows (≈ unos MB) usando el WebView2 ya instalado en el sistema, en vez de incrustar un Chromium completo. También es el puente de comunicación JS ↔ Rust y el sistema de permisos. | Electron habría pesado 100+ MB y consumido más RAM; Tauri reutiliza el motor del sistema. |
| Backend | **Rust** (edition 2024) | Leer `.xlsx`/`.xls` con `calamine`, normalizar y consolidar textos, parsear números, hacer los cálculos de proporciones, escribir el Excel de salida con `rust_xlsxwriter` y persistir preferencias. | Velocidad y seguridad de memoria en el parseo de archivos grandes; una planilla de miles de filas se resuelve en milisegundos sin bloquear la UI. |
| Frontend | **Vanilla JS + HTML + CSS** | Toda la UI: árbol de archivos/hojas, tabla editable, menús contextuales, filtro por color, modales, impresión. El estado vive en variables de módulo y en el DOM. | Sin React/Vue: la app es una sola pantalla con una tabla; un framework habría añadido build step, dependencias y latencia sin beneficio. El DOM aquí **es** el modelo de la tabla. |

No hay *bundler*: `tauri.conf.json` apunta `frontendDist` a `../src`, es decir, se sirven los archivos tal cual. Eso explica que `src/main.js` sea un único archivo de ~3.200 líneas: es un módulo plano con funciones y estado en el ámbito superior.

## 1.2 Crates de Rust (lo que hay en `Cargo.toml`)

| Crate | Versión | Para qué se usa realmente |
|---|---|---|
| `tauri` | 2 | Runtime, `#[tauri::command]`, gestión de estado (`manage`), ciclo de vida de la ventana. |
| `tauri-plugin-store` | 2.5 | Persistencia clave-valor en archivos JSON (`config.json`, `grupos.json`, `recientes.json`). Evita escribir un serializador a disco a mano. |
| `tauri-plugin-dialog` | 2 | Diálogos nativos: abrir archivos, "Guardar como", mensajes de error. |
| `tauri-plugin-opener` | 2 | Abrir enlaces/archivos con el programa del sistema (queda registrado; hoy la app no lo usa en el flujo principal). |
| `calamine` | 0.38 | **Lectura** de libros Excel. Devuelve celdas ya tipadas (`Data::Int`, `Data::Float`, `Data::String`, `Data::Empty`…). |
| `rust_xlsxwriter` | 0.102 | **Escritura** de `.xlsx` real (Office Open XML + ZIP). Da negrita, color de fondo, `freeze_panes` y `autofit` sin tocar XML a mano. |
| `serde` / `serde_json` | 1 | Serializar/deserializar los structs que cruzan la frontera JS ↔ Rust y los que se guardan en el store. |

Detalle importante para la presentación: **`calamine` para leer, `rust_xlsxwriter` para escribir**. Son crates distintas porque una está optimizada para parsear y la otra para generar; `rust_xlsxwriter` no lee y `calamine` no escribe.

## 1.3 Plugins y permisos de Tauri (v2)

En Tauri 2 todo lo que el frontend puede pedir está declarado en `src-tauri/capabilities/default.json`:

```json
"permissions": [
  "core:default",
  "core:window:allow-close",
  "core:window:allow-destroy",
  "opener:default",
  "store:default",
  "dialog:default"
]
```

`core:default` **no** incluye `destroy`, y eso es exactamente la raíz del bug de cierre (sección 5.1). Este archivo es el "firewall" de la app: si un permiso no está, la llamada del JS falla aunque el comando exista.

Además, `withGlobalTauri: true` en `tauri.conf.json` es lo que permite usar `window.__TAURI__.core.invoke` y `window.__TAURI__.dialog` sin `import`, dado que no hay bundler.

---

# 2. Arquitectura de la información

## 2.1 Vista general

```
┌──────────────────────────── WebView (JS) ────────────────────────────┐
│  Estado en memoria (variables de módulo)                             │
│    seccionesActuales · ingredientesConsolidados ·                    │
│    ingredientesPorArchivo · diccionarioMaestro ·                     │
│    coloresIngredientes (Map) · vinculacionesArchivosGrupos (Map) ·   │
│    coloresFiltroActivos (Set)                                        │
│                              │                                       │
│                              │  invoke('comando', { args })          │
│                              ▼                                       │
│  Tabla del DOM  ◄──── pintar / ocultar filas / colores inline        │
└──────────────────────────────┬───────────────────────────────────────┘
                               │  IPC (Tauri)
┌──────────────────────────────▼───────────────────────────────────────┐
│                        Rust (src-tauri/src)                          │
│  excel.rs        leer, normalizar, consolidar, calcular_total        │
│  secciones.rs    grupos, auto-ajuste de proporciones                 │
│  colores.rs      leer/guardar mapa de colores + versión de esquema   │
│  vinculaciones.rs mapa archivo → [grupos]                           │
│  recientes.rs    lista de archivos recientes                         │
│  exportacion.rs  generar .xlsx                                       │
│                              │                                       │
│                              ▼                                       │
│  tauri-plugin-store  →  config.json · grupos.json · recientes.json   │
└──────────────────────────────────────────────────────────────────────┘
```

## 2.2 ¿Dónde vive cada dato?

| Dato | Vive en | Se calcula en | Se persiste en |
|---|---|---|---|
| Ingredientes consolidados (tabla) | JS: `ingredientesConsolidados` + filas del `<tbody>` | **Rust** (`procesar_hojas_excel`, `consolidar_entre_archivos`) | No se persiste (se re-procesa al cargar los Excel) |
| Aporte crudo de cada archivo | JS: `ingredientesPorArchivo` (`[{ruta, datos}]`) | Rust (por archivo) | No |
| Secciones y proporciones | JS: `seccionesActuales` (panel derecho) | **Rust** (`auto_ajustar_proporciones`, `calcular_total`) | `grupos.json` |
| Colores por fila | JS: `Map coloresIngredientes` (fuente de verdad) | JS (solo clave + id) | `config.json` |
| Vinculaciones archivo→grupo | JS: `Map vinculacionesArchivosGrupos` | JS | `config.json` |
| Filtro por color activo | JS: `Set coloresFiltroActivos` | JS | **No** (se reinicia) |
| Diccionario maestro (códigos) | JS: `diccionarioMaestro` (array) | **Rust** (`leer_diccionario`) | Solo la **ruta** en `config.json` |
| Código y comentario por fila | DOM (input/select de cada `<tr>`) | — | No (se pierden al repintar; ver §9) |

La regla de diseño que puedes verbalizar: **Rust es dueño del cálculo y del formato de archivo; JS es dueño de la interacción y de la verdad del estado de UI.** JS nunca recalcula la fórmula de proporciones: se la pide a `calcular_total`.

## 2.3 El puente JS ↔ Rust

Un comando se declara así en Rust:

```rust
#[tauri::command]
pub fn calcular_total(
    ingredientes: Vec<IngredienteConsolidado>,
    secciones: Vec<Seccion>,
) -> Result<Vec<IngredienteConTotal>, String> {
```

y se registra obligatoriamente en `lib.rs`:

```rust
.invoke_handler(tauri::generate_handler![
    excel::calcular_total,
    exportacion::exportar_excel,
    /* … 24 handlers en total … */
])
```

Desde JS se llama con `invoke`, y los argumentos van en **camelCase** aunque en Rust sean `snake_case` (Tauri los convierte):

```js
const conTotales = await invoke('calcular_total', {
    ingredientes: ingredientesConsolidados,
    secciones: seccionesActuales
});
```

Ese detalle aparece en el código y demuestra que entendiste el puente: `nombres_hojas` en Rust se envía como `nombresHojas`, y `columnas_numericas` como `columnasNumericas`.

Puntos a mencionar:
- `Result<T, String>`: el `Err` viaja al `catch` del JS como mensaje de texto legible. Por eso el código hace `alert('Error al calcular total: ' + error)`.
- Los structs con `#[derive(Serialize, Deserialize)]` son el contrato. `#[serde(default)]` permite que un campo nuevo (`clave_ingrediente`, `opciones_codigo`) no rompa datos/llamadas antiguas.
- El estado global de secciones usa `tauri::State<AppState>` con dos `Mutex` (lista + contador de id), porque el panel puede agregar secciones desde varios eventos y Rust es multihilo.

---

# 3. Algoritmos críticos

## 3.1 Normalización de texto: `clave_ingrediente`

**Problema de negocio:** "Azúcar", "AZUCAR", "azúcar " y "Azucar" son el mismo ingrediente y deben sumarse. Pero "piña" y "pina" son cosas distintas.

**Solución — cuatro pasos, en orden:**

```rust
pub fn clave_ingrediente(nombre: &str) -> String {
    // 1) quitar tildes y diéresis, carácter por carácter,
    //    dejando ñ/Ñ intacta a propósito
    // 2) pasar a minúsculas
    // 3) colapsar espacios múltiples a uno
    // 4) quitar puntuación final ( . , ; : )
}
```

Desglose:

1. **Tabla de reemplazo explícita** (`á→a`, `é→e`, `í→i`, `ó→o`, `ú/ü→u`). No se usa `unicode-normalization` ni una crate extra: son 10 caracteres y una dependencia menos. La `ñ` cae en la rama `otro => otro` y se conserva, porque en español no es una "n acentuada" sino otra letra; si la convirtieras, "piña" y "pina" se fusionarían y sumarías cantidades de ingredientes distintos.
2. **`to_lowercase()`** después de quitar tildes: así `Á` ya se convirtió en `a` y no hay que preocuparse por el caso especial de `İ` turca.
3. **`split_whitespace().join(" ")`**: colapsa tabs, espacios dobles y saltos de línea en un solo espacio.
4. **`trim_end_matches('.', ',', ';', ':')`**: Excel arrastra puntos finales ("Sal." vs "Sal").

**Resultado:** `"  Azúcar  "` → `"azucar"`, `"AZÚCAR."` → `"azucar"`, `"Piña"` → `"piña"`.

Funciones hermanas que conviene nombrar:

- `nombre_visible()`: decide cómo se **muestra** el nombre. Si el texto viene todo en mayúsculas (`"SAL"`), lo pasa a Tipo Título (`"Sal"`) porque las planillas de bodega suelen venir gritadas. Si ya está en formato mixto, no lo toca (respeta "Jamón Serrano").
- `puntuacion_nombre()`: puntúa qué variante es "más bonita" — cada tilde/diéresis suma **2** y una inicial mayúscula suma **1**. Cuando dos variantes caen en la misma clave, el nombre visible del grupo es la de mayor puntaje: `"Azúcar"` (3) le gana a `"AZUCAR"` (1) y a `"azucar"` (0). Es un desempate determinista, no aleatorio.

## 3.2 Consolidación: cómo se encuentran las columnas del Excel

Esta es la parte que más te van a preguntar. Respuesta corta: **no hay coordenadas fijas ni diccionario externo; hay una compuerta de tres marcas en la misma fila, buscada solo en las primeras 15 filas.**

### Paso 0 — abrir el libro y recorrer hojas

```rust
let mut workbook: Xlsx<_> = open_workbook(&ruta)?;
for nombre_hoja in nombres_hojas {
    let range = workbook.worksheet_range(&nombre_hoja)?;
```

Se procesa **solo** las hojas que el usuario marcó en el árbol de la izquierda.

### Paso 1 — escanear las primeras 15 filas buscando la fila de cabecera

```rust
for (i, row) in range.rows().take(15).enumerate() {
    let celdas: Vec<String> = row.iter()
        .map(|c| c.to_string().trim().to_lowercase())
        .collect();

    let tiene_ingrediente = celdas.iter().any(|c|
        c.contains("ingrediente") || c.contains("descripción")
        || c.contains("descripcion") || c.contains("material"));

    let tiene_um = celdas.iter().any(|c|
        c == "u/m" || c == "um" || c.contains("unidad"));

    let tiene_cantidad = celdas.iter().any(|c| c.contains("cantidad"));

    if tiene_ingrediente && tiene_um && tiene_cantidad { /* es cabecera */ }
}
```

Puntos que debes explicar:

- **Límite de 15 filas**: las planillas reales tienen logos, títulos y filas en blanco arriba. 15 es el margen empírico; además acota el costo (no se recorre toda la hoja para algo que está arriba).
- **Normalización previa de cada celda** (`trim().to_lowercase()`): así `" INGREDIENTE "`, `"Ingrediente"` y `"ingrediente"` son la misma marca.
- **Lista de sinónimos embebida, no un diccionario de datos**: para la columna de nombre se aceptan `ingrediente`, `descripción`/`descripcion` (con y sin tilde, porque el `to_lowercase` no quita tildes) y `material`. Para unidad: `u/m`, `um` (comparación exacta) y cualquier celda que contenga `unidad`. Para cantidad, cualquier celda que contenga `cantidad`.
- **La compuerta es un AND de las tres**: la fila debe tener las tres marcas a la vez. Esto es lo que evita falsos positivos: una fila de título como "Listado de ingredientes del casino" contiene "ingrediente" pero no "unidad" ni "cantidad", así que se descarta. Si bastara un `any`, cualquier encabezado de sección rompería el parseo.
- **`break`**: se queda con la **primera** fila que cumple las tres condiciones. Las cabeceras repetidas más abajo se filtran después (paso 3).

### Paso 2 — mapear la posición de cada columna

Dentro de esa fila, se recorre celda por celda y se asigna el **primer** índice que corresponda a cada rol:

```rust
if col_nombre.is_none() && (celda.contains("ingrediente") || …) {
    col_nombre = Some(j);
} else if col_um.is_none() && (celda == "u/m" || celda == "um" || celda.contains("unidad")) {
    col_um = Some(j);
} else if col_cantidad.is_none() && celda.contains("cantidad") {
    col_cantidad = Some(j);
}
```

Es decir, **los índices salen del contenido, no de una plantilla**. Si la planilla trae `Cantidad | Ingrediente | U/M`, funciona igual. El `is_none()` garantiza que si hay dos columnas "Cantidad" (típico: cantidad y cantidad total) se use la primera.

Si falta cualquiera de las tres, el `match` no arma la tupla y se ejecuta `continue`: **la hoja se omite en silencio**, sin romper el resto del libro. Ese es el comportamiento que hay que saber explicar cuando pregunten "¿y si la hoja no tiene el formato?".

### Paso 3 — recorrer los datos y consolidar

```rust
for row in range.rows().skip(fila_cabecera_idx + 1) {
    let nombre = …trim();
    let um = …trim();
    let cantidad = row.get(col_cantidad).map(cantidad_de_celda).unwrap_or(0.0);

    if nombre.is_empty() || um.is_empty() { continue; }        // filas basura
    if nombre.to_lowercase().contains("material")
        || nombre.to_lowercase().contains("descripción") { continue; }  // cabecera repetida

    let clave = format!("{}|{}", clave_ingrediente(&nombre), um.to_lowercase());
    let entry = mapa.entry(clave).or_insert_with(|| IngredienteConsolidado { … });
    if puntuacion_nombre(&nombre) > puntuacion_nombre(&entry.nombre) {
        entry.nombre = nombre_visible(&nombre);   // gana la variante mejor acentuada
    }
    entry.cantidad += cantidad;                   // ← la suma
}
```

La **clave de consolidación** es `nombre_normalizado + "|" + unidad_en_minúsculas`. Se usa `um.to_lowercase()` pero **no** se quita la unidad, a propósito: `Harina` en `kg` y `Harina` en `g` son filas distintas, porque sumar 1 kg + 500 g daría un número sin sentido. El usuario decide después. Ese es un argumento de diseño que vale la pena decir en voz alta.

El acumulador es un `HashMap<String, IngredienteConsolidado>` con `entry().or_insert_with()`, o sea: se crea la fila la primera vez y en las siguientes solo se suma. Complejidad **O(n)** en filas, con lookup promedio O(1).

### Paso 4 — segunda pasada entre archivos

`procesar_hojas_excel` consolida dentro de un archivo. Luego el JS llama a `consolidar_entre_archivos`, que aplica **exactamente la misma clave** sobre los resultados de todos los archivos. Por eso un ingrediente que aparece en 3 libros distintos termina en una sola fila. Al final, `sort_by(clave_ingrediente(nombre))` da el orden alfabético estable entre acentos ("Azúcar" y "azucar" quedan juntos).

**Si te preguntan "¿usas coordenadas fijas o un diccionario de sinónimos?":** "Ninguna de las dos cosas de forma rígida. Uso una lista corta de sinónimos embebida en el código, y exijo que las tres marcas aparezcan en la misma fila dentro de las primeras 15. El índice de cada columna se descubre en tiempo de ejecución. Es deliberadamente conservador: si no reconoce la cabecera, omite la hoja en vez de inventar datos."

**Limitación honesta (dila tú):** los sinónimos están en español y son fijos. Un archivo con "Producto / Medida / Qty" no se detecta. La solución escalable sería externalizar esa lista a un JSON de configuración.

## 3.3 Parseo de decimales: `parsear_decimal`

**El problema real:** una celda de Excel puede llegar de tres formas distintas y las tres rompían el parseo anterior:

1. Celda **numérica** (`Data::Float`) → problema resuelto por el `match`, se convierte directo.
2. Celda de **texto** con coma (`"0,4"`) → `"0,4".parse::<f64>()` **falla** en Rust, que solo acepta punto.
3. Celda de texto con espacios o con el **espacio duro** `\u{00A0}` que Excel arrastra al copiar/pegar → `"0.4 "` falla.

Y había una cuarta trampa: `calamine` ofrece `Data::as_f64()`, pero internamente usa `fast_float`, que **se detiene en el primer carácter inválido**. Comprobado con un test: `Data::String("0,4").as_f64()` devuelve `None`, y `"1,5"` también. Por eso el código **no** usa ese atajo para texto.

**El algoritmo, paso a paso:**

```rust
pub fn parsear_decimal(texto: &str) -> f64 {
    // 1) borrar TODO espacio, incluido \u{00A0}
    let limpio: String = texto.chars()
        .filter(|c| !c.is_whitespace() && *c != '\u{00A0}')
        .collect();

    if limpio.is_empty() { return 0.0; }

    // 2) contar separadores y decidir cuál es el decimal
    let puntos = limpio.matches('.').count();
    let comas  = limpio.matches(',').count();

    let normalizado = match (puntos, comas) {
        (p, c) if p > 0 && c > 0 => {           // "1.234,56" o "1,234.56"
            if limpio.rfind(',') > limpio.rfind('.') {
                limpio.replace('.', "").replace(',', ".")   // coma decimal (es-CL)
            } else {
                limpio.replace(',', "")                     // punto decimal (en-US)
            }
        }
        (p, 0) if p > 1 => limpio.replace('.', ""),  // "1.234.567" → miles
        (0, c) if c > 1 => limpio.replace(',', ""),  // "1,234,567" → miles
        (0, _)          => limpio.replace(',', "."), // "0,4" → "0.4"
        _               => limpio,                    // "0.4" ya es válido
    };

    // 3) parsear o degradar con aviso
    normalizado.parse::<f64>().unwrap_or_else(|_| {
        eprintln!("[excel] Cantidad no numérica, se usa 0.0: {texto:?}");
        0.0
    })
}
```

**La idea central que debes verbalizar:** *"cuando hay dos tipos de separador, el decimal es el que aparece más a la derecha"* (`rfind`). Eso resuelve ambos locales sin necesitar la configuración regional del sistema. Cuando hay varios del mismo tipo, son separadores de miles y se eliminan.

**Cómo se conecta con `calamine`:**

```rust
fn cantidad_de_celda(celda: &Data) -> f64 {
    match celda {
        Data::Int(v)   => *v as f64,          // entero real de Excel
        Data::Float(v) => *v,                 // decimal real de Excel
        Data::Bool(v)  => if *v { 1.0 } else { 0.0 },
        Data::Empty    => 0.0,
        otro           => parsear_decimal(&otro.to_string()),  // texto
    }
}
```

Se decidió **por variante del enum**, no por "intentar número y si falla parsear texto". Así una celda numérica nunca pasa por el parser de strings y una celda de texto nunca se trunca.

**El punto de ingeniería que vale oro en la presentación:** el `0.0` final **no es silencioso**. Antes el código hacía `unwrap_or(0.0)` sin avisar, y ese era el bug real: una cantidad ilegible se convertía en cero y el usuario no tenía forma de saber que faltaba un dato. Ahora se escribe `[excel] Cantidad no numérica, se usa 0.0` en el `stderr`, visible en la consola de desarrollo.

**Y el tipo:** todos los campos numéricos (`cantidad`, `cantidad_total`, `proporcion`) son `f64`, no `f32` ni enteros. Se migraron los structs de `f32` a `f64` para no perder precisión al encadenar `cantidad × factor`. Hay 4 tests unitarios que cubren esto (`cargo test --lib` → 5 passed).

## 3.4 Cálculo de proporciones: la matemática

### El caso simple: `calcular_total`

```rust
let suma_proporciones: f64 = secciones.iter().map(|s| s.proporcion).sum();
let suma_alumnos: f64      = secciones.iter().map(|s| s.alumnos as f64).sum();

let factor = if suma_proporciones > 0.0 {
    suma_proporciones / 100.0        // "el total de porciones del grupo"
} else if suma_alumnos > 0.0 {
    suma_alumnos                     // respaldo: factor = número de comensales
} else {
    return Err("No hay secciones con alumnos o proporciones definidas".to_string());
};

cantidad_total = cantidad * factor;
```

**Cómo explicarlo:** las proporciones no se aplican una por una; se **suman primero y luego se multiplica una sola vez**. Si un grupo tiene secciones de 60 % y 40 %, el factor es `(60+40)/100 = 1.0`, es decir, se compra la receta completa. Si el grupo tiene solo 60 %, se compra el 60 %. Si alguien dejó los porcentajes vacíos pero cargó alumnos, el factor pasa a ser la cantidad de comensales (receta pensada para 1 persona × N personas). Y si no hay ni porcentajes ni alumnos, se devuelve `Err` en vez de dividir por cero — el JS convierte ese error en un mensaje al usuario.

### El auto-ajuste: `auto_ajustar_proporciones`

```rust
let max_alumnos = secciones.iter().map(|s| s.alumnos).max().unwrap_or(0);
let proporcion_calculada = (s.alumnos as f64 / max_alumnos as f64) * 100.0;
seccion.proporcion = (proporcion_calculada * 10.0).round() / 10.0;  // 1 decimal
```

Es una **regla de tres contra el grupo más grande**, no un reparto que sume 100 %. Con 10, 20 y 20 alumnos da 50 %, 100 % y 100 %. Es intencional: el grupo más grande es la referencia "receta completa" y los demás se escalan respecto a él. `(x * 10).round() / 10` es el truco para redondear a un decimal sin `format!`.

Si te preguntan "¿por qué la suma de proporciones puede pasar de 100?": porque cada sección se mide contra la más grande, no contra el total. El factor resultante (`2.5` en ese ejemplo) significa "2,5 veces la receta base".

### El caso difícil: un archivo en varios grupos (`calcularVinculados`)

Este es **el** algoritmo que hay que saber contar, porque es donde está la lógica de negocio más sutil.

**Problema:** un archivo puede estar vinculado a 0, 1 o N grupos (relación N a N). Cada grupo tiene sus propios porcentajes. El mismo ingrediente puede venir de dos archivos distintos, y uno de ellos estar vinculado y el otro no.

**Paso 1 — recolectar los grupos válidos por archivo.**

```js
const candidatos = Array.from(grupos)
    .filter(nombre => grupoTieneFactorCalculo(seccionesPorGrupo.get(nombre)))
    .sort((a, b) => a.localeCompare(b, 'es'));
```

`grupoTieneFactorCalculo` replica en JS la condición de Rust (suma de proporciones o de alumnos > 0), para no llamar a un comando que va a fallar. El `sort` hace el resultado **determinista** (mismo orden siempre), lo que ayuda a reproducir bugs.

**Paso 2 — invertir el mapa: de archivo→grupos a grupo→archivos.** Así se hace **una sola llamada a `calcular_total` por grupo**, no una por archivo.

**Paso 3 — acumular, grupo por grupo.**

```js
for (const [nombreGrupo, rutas] of archivosPorGrupo) {
    const ingredientes = rutas.flatMap(ruta => datosPorRuta.get(ruta) ?? []);
    const calculados = await invoke('calcular_total', {
        ingredientes,
        secciones: seccionesPorGrupo.get(nombreGrupo)
    });
    calculados.forEach(ing => {
        const clave = claveConsolidada(ing);
        clavesCalculadas.add(clave);
        totalesPorClave.set(clave, (totalesPorClave.get(clave) || 0) + ing.cantidad_total);
    });
}
```

**La fórmula que responde a "el problema de los archivos en 2 grupos":**

> Si un archivo está en el grupo A y en el grupo B, su aporte es
> `cantidad × factor(A) + cantidad × factor(B)`.
> **Se suman, no se elige uno ni se promedian.**

Justificación de negocio: el archivo representa un insumo que se necesita para dos servicios distintos (por ejemplo, almuerzo y cena), así que la compra total es la suma de ambas necesidades.

**Paso 4 — los archivos sin grupo no pierden sus datos.** Si un ingrediente lo aporta un archivo vinculado y también uno suelto, el suelto entra con factor 1, pero **solo para las claves que ya fueron calculadas**. Esa condición es clave: evita que un archivo sin vínculos "resucite" filas que no participan del cálculo.

```js
if (!clave || !clavesCalculadas.has(clave)) return;
totalesPorClave.set(clave, (totalesPorClave.get(clave) || 0) + (Number(ing.cantidad) || 0));
```

**Paso 5 — pintar sin repintar la tabla.** `aplicarTotalesVinculados` recorre las filas del DOM y actualiza **solo la celda "Cantidad Total"** (`fila.children[4]`). No se vuelve a generar el `<tbody>` para no perder comentarios, códigos elegidos ni colores. Después llama a `reaplicarFiltroColor()` para que el filtro siga vigente.

**Dos propiedades que puedes vender como calidad de diseño:**

1. **Idempotencia.** El cálculo siempre parte de `ingredientesPorArchivo` (datos crudos por archivo), nunca de los totales ya pintados. Pulsar "Calcular vinculados" dos veces da el mismo resultado; no se duplica nada.
2. **Por qué existe `ingredientesPorArchivo`.** Después de consolidar, se pierde de qué archivo venía cada cantidad. Si solo tuvieras la fila consolidada, no podrías escalar únicamente el aporte del archivo vinculado. Guardar el crudo por archivo es lo que hace posible "multiplicar solo la parte que corresponde".

**Contra qué se protege:** si no hay vinculaciones, si no hay tabla, si no hay origen por archivo, si ningún grupo tiene factor, o si ningún grupo se pudo calcular, cada caso tiene su propio `alert` con un mensaje distinto. Y cada grupo que falla se captura con `try/catch` + `console.warn` sin abortar los demás.

---

# 4. Sistema de colores y persistencia

## 4.1 La clave: una PK compuesta

Un color no se asocia al índice de la fila (cambiaría al recargar) ni al nombre solo (dos unidades del mismo ingrediente se pintarían juntas). Se usa una **clave primaria compuesta y normalizada**:

```js
function pkColorFila(fila) {
    const nombre = claveNombreIngrediente(fila);   // viene de Rust: clave_ingrediente
    const unidad = normalizarUnidadMedida(fila?.unidad);
    return `${nombre}${SEPARADOR_PK_COLOR}${unidad}`;   // "harina::kg"
}
```

Detalles que demuestran criterio:

- El **nombre lo normaliza Rust** y lo expone en el campo `clave_ingrediente`. JS no duplica esa lógica: una sola fuente de verdad para la normalización.
- `normalizarUnidadMedida` recorta, colapsa espacios, quita puntuación final y pasa a minúsculas.
- El separador es `'::'`, elegido explícitamente porque **no colisiona con `'|'`**, que es el separador de la clave interna de consolidación de Rust. Eso permite distinguir a simple vista una clave vieja (`"harina|kg"`) de una actual (`"harina::kg"`), y es la base de la migración.
- Esta PK se escribe en el DOM como `tr.dataset.idFila`, así el color sobrevive a cualquier repintado de la tabla.

## 4.2 Se persiste el **id** del color, no el hex

```js
const COLORES_INGREDIENTE = [
    { id: 'rojo', valor: '#f8d7da' }, { id: 'naranja', valor: '#ffe8cc' },
    { id: 'amarillo', valor: '#fff3bf' }, { id: 'verde', valor: '#d3f9d8' },
    { id: 'turquesa', valor: '#c5f6fa' }, { id: 'azul', valor: '#d0ebff' },
    { id: 'violeta', valor: '#e5dbff' }, { id: 'rosa', valor: '#f3d9fa' }
];
const COLORES_POR_ID = new Map(COLORES_INGREDIENTE.map(c => [c.id, c.valor]));
```

Ventaja concreta: si mañana cambias la paleta a tonos más suaves, los colores guardados ("verde") siguen funcionando y se pintan con el nuevo hex. Si guardaras `#d3f9d8`, quedarían fuera de la paleta. Además, un id desconocido al leer se ignora con un `warn` en vez de romper.

## 4.3 Escritura en background: cola de promesas

El guardado **no bloquea** la interacción. Cuando el usuario elige un color:

```js
function guardarColorFila(idFila, colorId) {
    coloresIngredientes.set(idFila, colorId);   // 1. estado en memoria (verdad)
    pintarFilaPorId(idFila, colorId);           // 2. pintado inmediato (optimista)
    persistirColoresFilas();                    // 3. disco, sin await
}
```

Y `persistirColoresFilas` es una **cadena de promesas** (`persistenciaColoresCola`) que hace tres cosas:

```js
persistenciaColoresCola = persistenciaColoresCola
    .then(() => coloresCargadosPromise || Promise.resolve())  // espera la carga inicial
    .then(guardar)                                            // escribe en orden
    .catch(error => console.error('No se pudieron guardar…', error));
```

1. **Serializa las escrituras.** Si el usuario pinta 10 filas rápido, no se lanzan 10 escrituras concurrentes que se pisen: se encolan y se ejecutan una detrás de otra.
2. **Espera la carga inicial.** Evita el peor escenario: guardar un mapa vacío porque el `Map` aún no se había llenado desde disco. Ese bug borraría todos los colores del usuario.
3. **No rompe la UI.** El `catch` final convierte un fallo de disco en un `console.error`, no en una excepción no capturada.

Del lado de Rust el guardado es **sobrescritura total** del mapa (`store.set(CLAVE_COLORES, …)`), porque JS es la fuente de verdad. Si el mapa queda vacío, se hace `store.delete`, para no dejar `{}` en el JSON.

## 4.4 Carga, versión de esquema y migración

El esquema de claves evolucionó: **v1** guardaba solo el nombre normalizado (`"harina"`), **v2** guarda `"harina::kg"`. La migración es necesaria porque un v1 pinta bien hasta que aparece el mismo ingrediente en dos unidades.

`cargarColoresFilas` hace:

1. Lee el mapa y la versión (`obtener_colores_filas` + `obtener_version_colores_filas`, dos comandos separados porque la versión es secundaria: si falla, la migración se apoya en el **formato de las claves** y sigue siendo segura).
2. Separa las entradas: las que contienen `'::'` van directo al `Map`; las demás quedan en `coloresPendientesMigracion` **hasta que exista la tabla** (no se puede decidir sin saber qué filas hay hoy).
3. `migrarColoresLegacy(datos)` aplica una heurística conservadora:
   - Clave v1 (`"harina"`) y hoy hay **una sola** fila con ese nombre → se hereda el color con la PK nueva.
   - Clave v1 y hay **varias** filas con ese nombre (distintas unidades) → **ambiguo, se descarta**. Prefiere no pintar antes que pintar la fila equivocada.
   - Clave intermedia `"harina|kg"` → se convierte a `"harina::kg"` y solo se aplica si esa PK existe hoy.
4. Marca `SCHEMA_VERSION_COLORES = 2` en el store **después** del mapa, para que si algo falla la migración se reintente en el próximo arranque (idempotencia).

## 4.5 El filtro por color (selección múltiple)

```js
let coloresFiltroActivos = new Set();       // ids de color + posible sentinel
const FILTRO_SIN_COLOR = '__sin_color__';   // centinela: no puede colisionar
```

`reaplicarFiltroColor()` recorre las filas y decide visibilidad con una sola expresión:

```js
const coincide = !hayFiltro
    || (colorId ? coloresFiltroActivos.has(colorId)
                : coloresFiltroActivos.has(FILTRO_SIN_COLOR));
fila.hidden = !coincide;
```

Se usa `hidden` (no `display:none` inline) porque es más limpio de revertir, y ambos casos están cubiertos en `filasVisiblesTabla()` a la hora de exportar. El filtro **no se persiste** a propósito: al reiniciar, el usuario ve toda su tabla.

El "problema del filtro vacío" se resuelve insertando una fila de aviso con `colSpan = 6` y clase `fila-vacia-filtro`, que **no tiene `data-id-fila`**, así los selectores que recorren filas de datos no la confunden con un ingrediente.

## 4.6 Flush al cerrar

`flushColoresAlCerrar()` es la red de seguridad del cierre:

- Espera `coloresCargadosPromise` (no volcar antes de leer).
- Si `cargaColoresFallida`, **se aborta** el volcado: es preferible conservar lo que hay en disco que sobrescribirlo con un mapa vacío.
- Espera `persistenciaColoresCola` para no adelantarse a un guardado en vuelo.
- Conserva las claves viejas que nunca llegaron a migrar (si el usuario cerró antes de tener tabla), para no perderlas.
- Guarda mapa + versión con `Promise.all` y **nunca lanza**: el `catch` solo registra. El cierre no se bloquea por un fallo de disco.

---

# 5. Bugs resueltos (desafíos técnicos)

## 5.1 La ventana no cerraba (y el proceso quedaba colgado)

**Síntoma:** pulsar la X no hacía nada; había que matar el proceso desde el Administrador de tareas.

**Causa raíz — dos capas que se sabotean entre sí:**

1. Para guardar los colores antes de cerrar, el handler hace `evento.preventDefault()`. Eso **anula el cierre nativo**: la ventana deja de cerrarse por sí sola y la responsabilidad pasa al JS.
2. El código llamaba después a `getCurrentWindow().close()`. Pero en el API de Tauri, `close()` **vuelve a emitir** `closeRequested`. Con la bandera `permitirCierre` el handler dejaba pasar el evento, y entonces el *wrapper* interno de `onCloseRequested` intentaba cerrar con `this.destroy()`:

```js
// node_modules/@tauri-apps/api/window.js
async onCloseRequested(handler) {
    return this.listen(TauriEvent.WINDOW_CLOSE_REQUESTED, async (event) => {
        const evt = new CloseRequestedEvent(event);
        await handler(evt);
        if (!evt.isPreventDefault()) {
            await this.destroy();      // ← esta línea necesitaba permiso
        }
    });
}
```

3. Y `destroy` **no está en `core:window:default`**. La llamada fallaba por ACL, la ventana nunca se destruía, y como el cierre nativo ya estaba bloqueado por el `preventDefault`, quedaba abierta con el proceso vivo.

**La solución (4 piezas):**

- **`destroy()` en vez de `close()`**: destruye la ventana de forma nativa y **no re-emite** `closeRequested`, así que el bucle es estructuralmente imposible (no depende de una bandera para no repetirse).
- **`"core:window:allow-destroy"`** agregado a `capabilities/default.json`, que es el permiso que faltaba.
- **Bandera `cerrando`** para re-entrada: si el usuario hace doble clic en la X mientras se guarda, el segundo evento solo hace `preventDefault()` y sale. Si `destroy()` falla, la bandera **se libera** (`cerrando = false`) para que otra pulsación reintente en vez de dejar la ventana muerta.
- **`Promise.race` con timeout de 1.5 s** + `try/catch/finally`: si el store se cuelga, se cierra igual; si el guardado lanza, el `finally` cierra igual. El requisito "el usuario nunca queda atrapado" se cumple por construcción.

**Frase para la presentación:** *"El bug no era un `await` olvidado: era un conflicto entre el cierre nativo que yo había bloqueado y un cierre programático que el sistema de permisos rechazaba en silencio. Lo resolví usando la primitiva que no re-emite el evento (`destroy`) y declarando el permiso que faltaba. Y como los permisos se compilan dentro del binario, el arreglo requiere recompilar, no solo recargar la vista."*

## 5.2 Los acentos se rompían al exportar (UTF-8 con BOM)

**Síntoma:** al abrir el archivo exportado, "Piña" se veía "PiÃ±a" y "Azúcar" como "AzÃºcar".

**Causa:** la primera versión exportaba **CSV** concatenando texto. Un CSV no declara su codificación en ninguna parte: es bytes y nada más. Rust escribe UTF-8, pero Excel en Windows, si no encuentra una marca, asume la página de códigos ANSI (Windows-1252). Un byte UTF-8 como `C3 B1` (ñ) se interpreta como dos caracteres latinos (`Ã`, `±`). La solución clásica es anteponer el **BOM** `EF BB BF` (los tres bytes de `U+FEFF`) para que Excel detecte UTF-8. Y aun así quedaban dos problemas secundarios: el separador (`;` en es-CL vs `,` en en-US) y que los números se escribían como texto.

**La solución que se adoptó fue eliminar la clase de problema, no parchearla:** se reemplazó el CSV por un **`.xlsx` real** generado con `rust_xlsxwriter`. Las razones técnicas:

- En Office Open XML los textos viven en `sharedStrings.xml`, un XML con `encoding="UTF-8"` **declarado en el prólogo**. No hay ambigüedad que resolver, así que **el BOM deja de ser necesario**.
- No hay separador de campos que adivinar: cada celda es un elemento `<c>` con su tipo (`t="s"` para texto, número para cifras).
- Se puede dar formato: cabecera en negrita con fondo `#D9D9D9`, panel congelado, ancho automático.
- Se conservan los ceros a la izquierda de los códigos (`"001"` sigue siendo texto) porque las columnas numéricas se declaran explícitamente (`[3, 4]` = Cantidad y Cantidad Total) en vez de "adivinar".

Y se agregó un **test de ida y vuelta** que lo demuestra: `exportacion.rs` genera el archivo, lo vuelve a abrir con `calamine` y verifica tres cosas a la vez —

```rust
assert_eq!(hoja.get_value((1, 0)), Some(&Data::String("Piña".to_string())));  // UTF-8 intacto
assert_eq!(hoja.get_value((1, 1)), Some(&Data::String("001".to_string())));   // ceros conservados
assert_eq!(hoja.get_value((1, 3)), Some(&Data::Float(1.5)));                  // número, no texto
```

**Frase para la presentación:** *"El bug de los acentos era un problema de codificación implícita. En vez de agregar el BOM y seguir dependiendo de una convención, cambié el formato de salida a uno que declara su codificación por contrato. Gané tildes correctas, números sumables y formato, y bajé el riesgo a cero porque el test relee el archivo generado."*

## 5.3 El resto de decisiones que puedes mencionar como desafíos

| Desafío | Solución implementada |
|---|---|
| Cantidades decimales llegaban como 0 | `parsear_decimal` + `cantidad_de_celda` por variante del enum + `f64` en los structs + log de advertencia (no fallo silencioso). |
| Un ingrediente en 2 grupos se contaba mal | Suma aditiva `cantidad×fA + cantidad×fB`, calculada desde los datos crudos por archivo para que sea idempotente. |
| El repintado de la tabla borraba comentarios y códigos | `aplicarTotalesVinculados` actualiza solo la celda de total, sin reconstruir el `<tbody>`. |
| Guardados de color concurrentes se pisaban | Cola de promesas encadenadas (`persistenciaColoresCola`) que además espera la carga inicial. |
| Un color guardado podía migrar a la fila equivocada | Migración conservadora: ante ambigüedad (varias filas con el mismo nombre), se descarta la entrada. |
| El PDF salía con fondos de color y sin cabecera | Hoja `.solo-impresion` generada en texto plano + `@page margin: 0` + `print-color-adjust: economy`. |

---

# 6. Mapa de archivos (para orientarte si te preguntan "¿dónde está…?")

| Archivo | Tamaño aprox. | Contenido |
|---|---|---|
| `src/main.js` | ~3.200 líneas | Todo el frontend: estado, eventos, tabla, colores, filtro, vinculaciones, exportación, cierre. |
| `src/index.html` | ~12 KB | Layout de 3 columnas (archivos / tabla / grupos), banner con botones Excel y PDF, `#print-header`. |
| `src/styles.css` | ~49 KB | Layout, menús contextuales, y el bloque `@media print` completo. |
| `src-tauri/src/excel.rs` | ~590 líneas | Normalización, `parsear_decimal`, detección de columnas, consolidación, diccionario, `calcular_total`, tests. |
| `src-tauri/src/secciones.rs` | ~150 líneas | Struct `Seccion`, `AppState` con `Mutex`, guardar/listar/eliminar grupos, auto-ajuste. |
| `src-tauri/src/colores.rs` | 75 líneas | 4 comandos: leer/guardar mapa de colores y versión de esquema. |
| `src-tauri/src/vinculaciones.rs` | 45 líneas | Leer/guardar el mapa archivo → grupos (N a N). |
| `src-tauri/src/recientes.rs` | 73 líneas | Lista de archivos recientes, con deduplicación por ruta. |
| `src-tauri/src/exportacion.rs` | 132 líneas | `exportar_excel` + test de ida y vuelta. |
| `src-tauri/src/lib.rs` | 61 líneas | Registro de módulos, plugins y **los 24 handlers**. Punto de entrada para leer la app de un vistazo. |
| `src-tauri/capabilities/default.json` | 16 líneas | Permisos del frontend (incluye el `allow-destroy` del fix de cierre). |
| `src-tauri/tauri.conf.json` | — | `frontendDist: ../src`, `withGlobalTauri: true`, ventana 1280×720 maximizada. |

**Truco de presentación:** abre `lib.rs` y muestra el `generate_handler!` como índice de funcionalidades. En 20 líneas se ve todo lo que hace la app.

---

# 7. Guion de presentación (7 minutos)

**Minuto 0 — El problema (45 s).**
"En una cocina institucional se reciben planillas de ingredientes de varios proveedores, con formatos distintos, y hay que sumar cuánto comprar para grupos de distinta cantidad de comensales. Hoy eso se hace a mano en Excel. Esta app lo automatiza."

**Minuto 1 — La arquitectura (60 s).**
Muestra el diagrama de §2.1. "Tres capas: Tauri empaqueta, Rust procesa, JS interactúa. La clave: Rust es dueño del cálculo y del formato de archivo; JS es dueño de la interacción. Se comunican con comandos tipados."

**Minuto 2 — El stack y por qué (45 s).**
"Tauri en vez de Electron: reutiliza WebView2, la app pesa Megabytes. Rust por `calamine` y `rust_xlsxwriter`: leer y escribir Excel de verdad, no CSV. Vanilla JS porque la UI es una tabla: un framework habría añadido build step sin beneficio."

**Minuto 3 — El algoritmo estrella: detección de columnas (90 s).**
"El usuario no configura columnas. La app escanea las primeras 15 filas y exige que en la misma fila aparezcan tres marcas: algo que contenga 'ingrediente', 'descripción' o 'material'; algo que sea 'u/m', 'um' o contenga 'unidad'; y algo que contenga 'cantidad'. Ese AND de tres evita que un título rompa el parseo. Cuando encuentra la fila, descubre el índice de cada columna por contenido, no por posición. Si no reconoce la cabecera, omite la hoja en vez de inventar datos."

**Minuto 4 — Consolidación y la clave compuesta (60 s).**
"Consolida con la clave nombre_normalizado|unidad. La normalización quita tildes pero **conserva la ñ** a propósito: piña y pina son ingredientes distintos. Y no se quita la unidad: harina en kg y harina en g quedan separadas, porque sumarlas daría un número sin sentido."

**Minuto 5 — La matemática de grupos (90 s).**
"El factor es la suma de proporciones sobre 100, aplicada una sola vez. Pero un archivo puede estar en dos grupos. Ahí el aporte es cantidad×factor(A) + cantidad×factor(B): se suman, porque son dos servicios que hay que cubrir. Lo importante: recalculo desde los datos crudos por archivo, no desde los totales ya pintados, así pulsar dos veces no duplica nada."

**Minuto 6 — Persistencia y los dos bugs (60 s).**
"Los colores se guardan con una PK nombre::unidad, se escribe el id del color no el hex, y el guardado va en una cola de promesas que espera la carga inicial para no sobrescribir con un mapa vacío. Dos bugs que me costaron: el cierre de ventana, que era un conflicto entre el cierre nativo bloqueado y un `destroy` rechazado por permisos; y los acentos, que en CSV necesitaban BOM y que resolví cambiando a xlsx real, donde el XML declara UTF-8. Ese segundo lo cubre un test de ida y vuelta."

**Minuto 7 — Cierre (30 s).**
"El resultado: el usuario carga archivos, la app detecta, consolida, calcula por grupos, permite marcar y filtrar por color, y exporta a Excel tipado o PDF en blanco y negro. Cinco tests unitarios cubren el parseo y la exportación; el resto está cubierto por un plan de pruebas de ~75 casos."

---

# 8. Preguntas probables (con respuesta corta)

| Pregunta | Respuesta |
|---|---|
| ¿Por qué no Electron? | Tauri reutiliza el WebView2 del sistema: binario de megabytes y menos RAM, a cambio de depender del motor instalado. |
| ¿Por qué no React? | Una sola pantalla con una tabla; el DOM es el modelo. Sin framework no hay build step ni estado duplicado. |
| ¿Dónde está la lógica de negocio? | En Rust. JS solo orquesta y pinta. La única excepción documentada es `grupoTieneFactorCalculo`, que replica la validación de Rust para evitar una llamada que fallaría. |
| ¿Cómo se sincronizan los datos? | No hay base de datos. Tres archivos JSON vía `tauri-plugin-store`; JS tiene el estado en memoria y lo escribe completo (sobrescritura), porque es la fuente de verdad. |
| ¿Y si la app se cae a mitad de un guardado? | Se pierde como máximo el último cambio no confirmado: el guardado es write-through, se lanza inmediatamente al elegir un color. Además hay un flush explícito al cerrar. |
| ¿Qué pasa con 10.000 filas? | El parseo y la consolidación son O(n) con `HashMap`, en Rust. La parte que sufre es el DOM (10.000 `<tr>`), no el cálculo. |
| ¿Por qué la clave usa `::` y no `|`? | Porque `|` ya es el separador de la clave interna de consolidación de Rust; usar símbolos distintos permite detectar el formato viejo en la migración. |
| ¿Por qué `destroy` y no `close`? | `close` re-emite `closeRequested` e invita a un bucle; `destroy` cierra sin evento. |
| ¿Cómo evitas dividir por cero? | `calcular_total` devuelve `Err` si no hay proporciones ni alumnos; `auto_ajustar_proporciones` devuelve todo en 0 si `max_alumnos == 0`. |
| ¿Los porcentajes se guardan como enteros? | No: `f64`, igual que las cantidades, para no perder precisión al multiplicar. |
| ¿Por qué los sinónimos de columna están en el código? | Simplicidad y cero configuración para el usuario. Es una limitación conocida: la evolución natural es externalizarlos a un JSON. |
| ¿El PDF es un PDF real? | Se genera por el motor de impresión a PDF del sistema desde una hoja HTML dedicada. Ventaja: una sola ruta de código para imprimir y exportar, sin dependencias de PDF en Rust. |
| ¿Cómo se testea? | 5 tests unitarios en Rust (parseo decimal, separadores de miles, celdas tipadas, exportación de ida y vuelta) + `PLAN_DE_PRUEBAS.md` con ~75 casos manuales por módulo. |

---

# 9. Limitaciones conocidas (dilas tú antes de que te las encuentren)

1. **`.xls` antiguo**: el diálogo acepta `xls`, pero el lector está tipado como `Xlsx<_>`. En `calamine` 0.38 `open_workbook` es genérico y hace `R::new(file)`, así que **forzar el tipo Xlsx significa que un `.xls` real (OLE2) no se podrá abrir**. El diálogo promete más de lo que el backend soporta. Arreglo: detectar la extensión y usar `Xls`/`Xlsx` según corresponda.
2. **Sinónimos de cabecera cerrados**: solo español y una lista fija; "Producto / Medida / Qty" no se detecta.
3. **Comentarios y códigos viven en el DOM**: al repintar la tabla se pierden (los colores no, porque tienen persistencia). No hay store para ellos.
4. **El filtro por color no se persiste**: decisión deliberada, pero implica que al reiniciar se ve todo.
5. **`limpiarColoresHuerfanos` existe pero no se invoca**: se dejó como utilidad manual porque la tabla puede ser un subconjunto y borraría colores de otros conjuntos. Es una decisión consciente, no código muerto por descuido.
6. **`Image`/fechas en Excel**: las celdas de fecha se leen como texto; no hay conversión de formato de fecha porque el dominio solo usa cantidades.
7. **El botón `greet`** sigue registrado del template de Tauri. Es inocuo, pero si te preguntan "¿qué hace?", la respuesta honesta es "es el comando de ejemplo del scaffolding; se puede borrar".

---

## Anexo — Verificación rápida antes de presentar

```powershell
node --check src/main.js                      # sintaxis del frontend
cargo test  --manifest-path src-tauri/Cargo.toml --lib   # 5 tests
cargo check --manifest-path src-tauri/Cargo.toml          # compila limpio
npm run tauri dev                             # demo en vivo
```

Los tres primeros ya están verificados en verde. Para la demo en vivo, ten preparados **dos Excel con el mismo ingrediente en unidades distintas** y uno con cantidades escritas como `"0,4"`: son los casos que mejor muestran la detección de columnas, la clave compuesta y el parseo decimal.
