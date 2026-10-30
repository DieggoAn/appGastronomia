# 🍳 Planificador Gastronómico - Guía de Instalación y Ejecución

¡Hola, equipo! Esta es la guía rápida para configurar el entorno de desarrollo y ejecutar la aplicación de escritorio del **Planificador Gastronómico** en sus computadoras.

---

## 🛠️ 1. Requisitos Previos y Dependencias de Entorno

Antes de comenzar, asegúrense de tener instalado el software base en su sistema operativo:

1. **Node.js**:
   * Descargar e instalar la versión **LTS** desde [nodejs.org](https://nodejs.org/).
   * Al instalarlo, se incluirá automáticamente **npm**.
2. **Rust**:
   * Descargar e instalar desde [rustup.rs](https://rustup.rs/).
   * *Nota para Windows:* Asegúrense de tener instaladas las **C++ Build Tools** a través del *Visual Studio Installer* (marcar la opción *"Desarrollo para el escritorio con C++"*).

---

## 🚀 2. Pasos para Configurar y Ejecutar el Proyecto

### Paso 1: Clonar / Abrir la carpeta del proyecto
Abran **Visual Studio Code** y seleccionen la carpeta raíz de la aplicación (`File > Open Folder...`).

### Paso 2: Solución al error de scripts en Windows (PowerShell)
Si al ejecutar comandos de `npm` en la terminal de VS Code en Windows les aparece un error de permisos o políticas de ejecución (*UnauthorizedAccess / PSSecurityException*), sigan una de estas opciones:

* **Opción A (Recomendada):** Abran PowerShell como Administrador en Windows y ejecuten:
  ```powershell
  Set-ExecutionPolicy RemoteSigned -Scope CurrentUser
  ```
* **Opción B:** En VS Code, cambien la terminal por defecto a **Command Prompt (CMD)** presionando `Ctrl + Shift + P` -> `Terminal: Select Default Profile` -> `Command Prompt`.

### Paso 3: Instalación de Dependencias de JavaScript
Abran la terminal en la raíz del proyecto y ejecuten:

```bash
npm install
```

*(Esto instalará todas las librerías necesarias del frontend como Vite, Tauri CLI, SheetJS/XLSX, etc., definidas en el `package.json`).*

---

## 💻 3. Ejecutar la Aplicación en Modo Desarrollo

Para levantar la ventana de la aplicación de escritorio con recarga en caliente (*hot-reload*), ejecuten:

```bash
npm run tauri dev
```

> **Nota:** La primera vez que ejecuten este comando, Rust descargará las librerías (*crates*) e iniciará la compilación del backend nativo. Este proceso inicial puede tardar unos minutos. En ejecuciones posteriores iniciará mucho más rápido.

---

## 📂 4. Estructura Rápida del Proyecto

* `src/`: Capa de Presentación (Frontend HTML, CSS, JavaScript). Aquí maquetamos las vistas, las tablas de ingredientes y la barra de acciones.
* `src-tauri/`: Capa de Negocio y Lectura nativa (Rust). Contiene la configuración del backend de Tauri y la interacción con archivos locales.
* `src-tauri/tauri.conf.json`: Configuración de ventana, permisos y opciones de empaquetado.

---

## ❓ Preguntas Frecuentes / Solución de Problemas

* **¿El programa requiere conexión a internet para funcionar?**
  No, la aplicación funciona **100% offline** procesando los archivos Excel localmente.
* **¿Qué hago si falla la compilación de Rust?**
  Verifiquen que Rust esté actualizado ejecutando `rustup update` en su terminal y confirmen que las herramientas de C++ de Visual Studio estén instaladas correctamente.

¡Cualquier duda la revisamos por el grupo de trabajo! 🚀