# Plan de Pruebas — Appgastronomia

**Versión de la app:** 0.1.0 · **Fecha del plan:** 15/11/2026
**Plataforma objetivo:** Windows 11 · WebView2 · Tauri 2 (Rust + Vanilla JS)
**Datos de prueba sugeridos:** Excel con locale es-CL (coma decimal), hojas con cabeceras `Ingrediente | Unidad | Cantidad`.

**Leyenda de resultado:** `OK` = pasa · `FALLA` = no cumple lo esperado · `BLOQ` = no se pudo ejecutar · `N/A` = no aplica.
**Prioridad:** A = crítica (rompe el flujo) · M = importante · B = cosmética / borde.

> La columna **Resultado obtenido** está vacía a propósito para que la completes durante la ejecución.

---

## 1. Carga de archivos y hojas

| ID | Tipo | Caso de prueba | Datos / pasos | Resultado esperado | Resultado obtenido | Pri |
|---|---|---|---|---|---|---|
| CAR-01 | Éxito | Agregar varios Excel válidos | Botón "Agregar Excel" → seleccionar 3 `.xlsx` | Los 3 aparecen en la lista y en recientes; se listan sus hojas | | A |
| CAR-02 | Éxito | Abrir `.xls` antiguo | Seleccionar un `.xls` de Excel 97-2003 | Se abre y lista hojas sin error | | M |
| CAR-03 | Borde | Cancelar el diálogo de archivos | Abrir diálogo y pulsar Cancelar | No se agrega nada ni aparece error en consola | | M |
| CAR-04 | Borde | Archivo reciente ya no existe | Borrar el archivo desde el Explorador y reiniciar la app | La entrada se ignora o se limpia; la app arranca normal | | M |
| CAR-05 | Borde | Archivo corrupto | Renombrar un `.txt` a `.xlsx` y cargarlo | Mensaje de error controlado; la app sigue usable | | A |
| CAR-06 | Borde | Libro sin datos | `.xlsx` con una hoja vacía | Lista de hojas correcta; al procesar no hay filas ni crash | | M |
| CAR-07 | Borde | Libro protegido con contraseña | `.xlsx` con contraseña | Error legible; no se cae la app | | M |
| CAR-08 | Estrés | Libro grande | `.xlsx` de ~20 MB con 50 hojas | El listado de hojas responde en tiempo razonable (< 10 s) | | M |

## 2. Importación y parseo de cantidades

| ID | Tipo | Caso de prueba | Datos / pasos | Resultado esperado | Resultado obtenido | Pri |
|---|---|---|---|---|---|---|
| IMP-01 | Éxito | Decimales con punto | Cantidades de texto `0.4`, `1.5` | Se muestran `0.40`, `1.50` | | A |
| IMP-02 | Éxito | Decimales con coma | Cantidades de texto `0,4`, `1,5` | Se muestran `0.40`, `1.50` | | A |
| IMP-03 | Borde | Separador de miles + decimal | `1.234,56` y `1,234.56` | Ambos → `1234.56` | | A |
| IMP-04 | Borde | Espacios o NBSP | `" 0,4 "` y `"0,4\u00A0"` | → `0.40` (no 0) | | A |
| IMP-05 | Borde | Número real de Excel | Celda numérica `0.4` (tipo Float) | → `0.40` | | A |
| IMP-06 | Borde | Celda no numérica | Vacía, `N/A`, `--` | → `0.00` + advertencia en consola; sin crash | | M |
| IMP-07 | Borde | Cantidad negativa | `-1,5` | → `-1.50` (o rechazo explícito, según regla de negocio) | | M |
| IMP-08 | Borde | Hoja sin cabecera reconocible | Columnas sin "Ingrediente/Unidad/Cantidad" | La hoja se omite sin romper el resto | | A |
| IMP-09 | Borde | Filas incompletas | Fila sin unidad o sin nombre | Esa fila se omite; el resto se procesa | | M |
| IMP-10 | Borde | Acentos y ñ | `Azúcar`, `azucar`, `PIÑA`, `pina` | Consolida variantes con tilde; `piña` ≠ `pina` | | M |
| IMP-11 | Borde | Misma cosa, distinta unidad | `Harina` en `kg` y en `g` | Dos filas separadas (no se suman) | | M |
| IMP-12 | Borde | Encabezado repetido entre hojas | Mismo ingrediente en 3 hojas | Una sola fila con la suma | | M |

## 3. Consolidación y cálculo

| ID | Tipo | Caso de prueba | Datos / pasos | Resultado esperado | Resultado obtenido | Pri |
|---|---|---|---|---|---|---|
| CON-01 | Éxito | Consolidar por nombre+unidad | 2 archivos con el mismo ingrediente | Suma de cantidades en una fila | | A |
| CON-02 | Éxito | "Calcular" con grupos | 2 secciones con proporciones válidas | Cantidad Total = cantidad × factor | | A |
| CON-03 | Borde | "Calcular" sin grupos | Sin secciones, alumnos y proporciones en 0 | Mensaje "No hay secciones con alumnos o proporciones definidas" | | A |
| CON-04 | Éxito | Archivo vinculado a 2 grupos | Proporciones 60 % y 40 % | Total = cantidad×0.6 + cantidad×0.4 | | A |
| CON-05 | Borde | Archivo sin vincular | 1 archivo vinculado + 1 sin vincular | El no vinculado aporta cantidad cruda solo a filas con aporte vinculado | | A |
| CON-06 | Borde | Grupo con factor inválido | Grupo con 0 alumnos y 0 % | Ese grupo se ignora; no divide por cero | | M |
| CON-07 | Borde | Recalcular dos veces | Pulsar "Calcular" y "Calcular vinculados" seguidos | Resultados idempotentes, sin duplicar cantidades | | A |
| CON-08 | Borde | Edición sin guardar | Cambiar proporción en el panel y no pulsar "Guardar" | El cálculo vinculado usa el valor guardado anterior | | M |
| CON-09 | Borde | Total con decimales | Proporción 33.3 % con cantidad 0.4 | Total con 2 decimales coherente (0.13) | | M |

## 4. Grupos y vinculaciones

| ID | Tipo | Caso de prueba | Datos / pasos | Resultado esperado | Resultado obtenido | Pri |
|---|---|---|---|---|---|---|
| GRP-01 | Éxito | Crear y editar sección | Agregar sección, cambiar nombre/alumnos/% | Cambios reflejados en el panel | | A |
| GRP-02 | Éxito | Auto-ajustar proporciones | 3 secciones con 10, 20 y 20 alumnos | 50.0 %, 100.0 %, 100.0 % (alumnos/máximo, 1 decimal) | | M |
| GRP-03 | Éxito | Guardar / cargar / eliminar grupo | Guardar "Almuerzo", reiniciar, cargar y eliminar | Persiste y se elimina sin residuos | | A |
| GRP-04 | Éxito | Vincular archivo a grupo | Modal Vincular → marcar grupo → Aceptar | Chip del grupo visible junto al archivo | | A |
| GRP-05 | Borde | Desvincular | Menú contextual → "Desvincular grupo" | El chip desaparece y el cálculo deja de aplicarlo | | M |
| GRP-06 | Borde | Eliminar archivo vinculado | Quitar el archivo desde recientes | Sus vinculaciones huérfanas se limpian | | M |
| GRP-07 | Borde | Nombre de grupo duplicado | Guardar 2 veces el mismo nombre | Sobrescribe o avisa (definir comportamiento esperado) | | B |
| GRP-08 | Borde | Archivo en 3 grupos | Vincular a 3 grupos con 33.3 % cada uno | 3 chips y suma de los 3 factores | | M |

## 5. Tabla, códigos y comentarios

| ID | Tipo | Caso de prueba | Datos / pasos | Resultado esperado | Resultado obtenido | Pri |
|---|---|---|---|---|---|---|
| TAB-01 | Éxito | Cargar diccionario maestro | Elegir `.xlsx` de diccionario | Cada fila muestra selector de códigos | | A |
| TAB-02 | Éxito | Elegir código | Seleccionar un código del desplegable | En reposo se ve solo el código; el valor queda en el estado | | A |
| TAB-03 | Éxito | Código manual | Elegir "Escribir manualmente…" y teclear | Se guarda el texto libre | | M |
| TAB-04 | Borde | Sin diccionario | Procesar sin cargar diccionario | Input de código manual disponible | | M |
| TAB-05 | Borde | Código duplicado entre artículos | Dos artículos con el mismo código | Se distingue por nombre en el desplegable | | B |
| TAB-06 | Éxito | Comentario por fila | Escribir comentario largo | Se conserva al exportar | | M |
| TAB-07 | Borde | Tabla sin procesar | Inicio de la app | Placeholder "Haz clic en el nombre de una hoja…" | | B |
| TAB-08 | Borde | Caracteres especiales | Nombre/comentario con `;`, `"`, saltos de línea | Tabla y exportaciones no se rompen | | M |

## 6. Colores y filtro

| ID | Tipo | Caso de prueba | Datos / pasos | Resultado esperado | Resultado obtenido | Pri |
|---|---|---|---|---|---|---|
| COL-01 | Éxito | Asignar color | Elegir color para una fila | Fila pintada; persiste tras reiniciar | | A |
| COL-02 | Éxito | Filtro múltiple | Marcar Verde y Azul | Solo esas filas visibles; badge "2" | | A |
| COL-03 | Éxito | Filtro "Sin color" | Marcar solo "Sin color" | Solo filas sin color asignado | | M |
| COL-04 | Borde | Filtro sin coincidencias | Color sin filas + "Seleccionar todo" | Aviso "Ninguna fila coincide…" | | M |
| COL-05 | Borde | Cierre del menú | Abrir menú y hacer clic fuera / Escape / scroll / resize | El menú se cierra en todos los casos | | M |
| COL-06 | Borde | Filtro + repintado | Filtrar y luego calcular | El filtro se mantiene tras el repintado | | A |
| COL-07 | Borde | Reinicio con filtro activo | Filtrar y reiniciar la app | Colores persisten; el filtro vuelve a "sin filtro" | | M |
| COL-08 | Borde | Color y cambio de nombre | Renombrar ingrediente y reimportar | El color no se hereda a la clave nueva (orphan) | | B |
| COL-09 | Borde | Resumen de colores | Abrir "Ajustes → Resumen de colores" | Conteos por color correctos | | B |

## 7. Exportación a Excel (.xlsx)

| ID | Tipo | Caso de prueba | Datos / pasos | Resultado esperado | Resultado obtenido | Pri |
|---|---|---|---|---|---|---|
| XLS-01 | Éxito | Exportar completo | Botón Excel → guardar | `.xlsx` con todas las filas, cabecera negrita y fondo gris | | A |
| XLS-02 | Éxito | Exportar con filtro | Filtrar Verde+Azul y exportar | Solo las filas visibles | | A |
| XLS-03 | Borde | Cancelar "Guardar como" | Abrir diálogo y cancelar | No se crea archivo; sin mensajes de error | | A |
| XLS-04 | Borde | Ruta sin extensión | Escribir `resumen` y aceptar | Se guarda como `resumen.xlsx` | | M |
| XLS-05 | Borde | Ruta con acentos/espacios | `C:\Mis Documentos\Resumen niño.xlsx` | Se guarda y abre correctamente | | M |
| XLS-06 | Borde | Códigos con ceros | Código `001` | En Excel sigue siendo texto `001` | | M |
| XLS-07 | Borde | Cantidades numéricas | Cantidad `1.50` | En Excel es número 1.5 (sumable) | | M |
| XLS-08 | Borde | Ancho automático | Comentario de 200 caracteres | Columna ajustada con tope (~320 px) | | B |
| XLS-09 | Borde | Nada visible | Filtrar un color sin filas y exportar | Alerta "No hay filas visibles…"; no se genera archivo | | M |
| XLS-10 | Borde | Sin permisos de escritura | Guardar en `C:\Windows\` | Mensaje de error legible; app usable | | M |
| XLS-11 | Borde | Sobrescribir | Guardar sobre un archivo existente | Confirmación del sistema y reemplazo correcto | | M |

## 8. Exportación a PDF

| ID | Tipo | Caso de prueba | Datos / pasos | Resultado esperado | Resultado obtenido | Pri |
|---|---|---|---|---|---|---|
| PDF-01 | Éxito | Cabecera del reporte | Exportar PDF | Título de la tabla + "Fecha: DD/MM/AAAA", sin la palabra "Filtro" | | A |
| PDF-02 | Éxito | Respetar filtro | Filtrar Verde y exportar | Solo filas visibles en el PDF | | A |
| PDF-03 | Éxito | Blanco y negro | Exportar con filas de colores | Sin fondos de color; texto negro; bordes `#ccc` | | A |
| PDF-04 | Borde | Cancelar impresión | Cerrar el diálogo de impresión | La app vuelve a la normalidad, sin hoja residual | | A |
| PDF-05 | Borde | Muchas páginas | 500 filas | Cabecera de tabla repetida; sin filas cortadas | | M |
| PDF-06 | Borde | Ctrl+P manual | Imprimir con el atajo del sistema | Banner y cabecera de tabla ocultos; sin hueco de cabecera | | M |
| PDF-07 | Borde | Fecha del sistema | Cambiar la fecha del equipo y exportar | La cabecera usa la fecha del momento del clic | | B |
| PDF-08 | Borde | Comentarios largos | Comentario con saltos de línea | Se imprime completo y legible | | M |
| PDF-09 | Borde | Nada visible | Filtrar sin coincidencias y exportar | Alerta; no se abre el diálogo de impresión | | M |

## 9. Persistencia y arranque

| ID | Tipo | Caso de prueba | Datos / pasos | Resultado esperado | Resultado obtenido | Pri |
|---|---|---|---|---|---|---|
| PER-01 | Éxito | Restauración completa | Reiniciar tras configurar todo | Colores, grupos, vínculos, diccionario y recientes restaurados | | A |
| PER-02 | Borde | `config.json` corrupto | Truncar el JSON y arrancar | Arranca sin datos, sin crash; se regenera | | A |
| PER-03 | Borde | `grupos.json` ausente | Borrar el archivo y arrancar | Lista de grupos vacía, sin error | | M |
| PER-04 | Borde | Cierre con cambios | Asignar un color y cerrar de inmediato | El color alcanza a persistirse (flush al cerrar) | | A |
| PER-05 | Borde | Ventana maximizada | Abrir la app | Arranca maximizada | | B |

## 10. Estrés y rendimiento

| ID | Tipo | Caso de prueba | Datos / pasos | Resultado esperado | Resultado obtenido | Pri |
|---|---|---|---|---|---|---|
| STR-01 | Estrés | 10.000 filas | Consolidar 10.000 filas | Scroll fluido; filtro por color < 1 s | | M |
| STR-02 | Estrés | 20 archivos × 50 hojas | Procesar todo | Sin bloqueo permanente; memoria estable | | M |
| STR-03 | Estrés | 1.000 asignaciones de color | Pintar 1.000 filas | Sin degradación perceptible; persiste | | B |
| STR-04 | Estrés | 30 grupos vinculados | Guardar 30 grupos y vincularlos | Cálculo correcto en tiempo razonable | | M |
| STR-05 | Estrés | Exportar 10.000 filas | Excel con 10.000 filas | `.xlsx` válido en < 10 s | | M |
| STR-06 | Estrés | PDF de 10.000 filas | Exportar PDF masivo | Genera todas las páginas sin colgarse | | B |
| STR-07 | Estrés | Doble clic en exportar | Pulsar Excel/PDF dos veces rápido | Un solo diálogo/archivo; sin estados zombies | | M |
| STR-08 | Estrés | Comentario de 5.000 caracteres | Pegar texto enorme | Tabla, xlsx y PDF no se rompen | | B |
| STR-09 | Estrés | Números extremos | `1e15`, `0.000001`, `-9999.99` | Se muestran y exportan sin notación rota | | B |
| STR-10 | Estrés | Unicode | Emojis, chino, árabe en nombres | Se guardan y exportan correctamente | | B |
