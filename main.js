const { app, BrowserWindow, ipcMain, Notification, dialog, shell } = require('electron');
// El actualizador es opcional: si falta el paquete, la app funciona igual (solo sin actualizaciones)
let autoUpdater = null;
try { ({ autoUpdater } = require('electron-updater')); } catch (e) { console.warn('electron-updater no está instalado: corre "npm install".'); }
const { spawn, exec } = require('child_process');
const path = require('path');
const fs = require('fs');

app.commandLine.appendSwitch('no-sandbox');

let mainWindow;

// Tiempo máximo que esperamos al script de lectura de EEPROM antes de darlo por fallido
const TIMEOUT_LECTURA_MS = 45000;

function iconoVentana() {
  try {
    const { nativeImage } = require('electron');
    const dir = path.join(__dirname, 'icons');
    const img = nativeImage.createFromPath(path.join(dir, '48x48.png'));
    if (img.isEmpty()) return undefined;
    const hd = path.join(dir, '96x96.png');
    if (fs.existsSync(hd)) img.addRepresentation({ scaleFactor: 2, buffer: fs.readFileSync(hd) });
    return img;
  } catch (e) {
    return undefined;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1024,
    height: 768,
    minWidth: 900,
    minHeight: 640,
    frame: true,
    title: 'ORT Engine',
    autoHideMenuBar: true,
    backgroundColor: '#f4f4f4',
    // Ícono de la ventana (nítido en la barra de tareas: 48 px normal y 96 px en pantallas HiDPI)
    icon: iconoVentana(),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  mainWindow.loadFile('index.html');

  // Revisión automática de actualizaciones al abrir (solo en la app instalada)
  mainWindow.webContents.once('did-finish-load', () => {
    if (app.isPackaged) setTimeout(buscarActualizaciones, 3000);
  });
}

app.whenReady().then(() => {
  createWindow();
  // y otra revisión cada hora
  setInterval(() => { if (app.isPackaged) buscarActualizaciones(); }, 60 * 60 * 1000);
});

/* ---------- Actualizaciones (GitHub Releases) ---------- */

function enviarEstado(estado, datos = {}) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update:estado', { estado, ...datos });
}

if (autoUpdater) {
  autoUpdater.autoDownload = false;          // primero se le pregunta al usuario
  autoUpdater.autoInstallOnAppQuit = true;   // si ya se descargó, se instala al cerrar
  autoUpdater.on('checking-for-update', () => enviarEstado('buscando'));
  autoUpdater.on('update-not-available', () => enviarEstado('actual', { version: app.getVersion() }));
  autoUpdater.on('update-available', (info) => {
    enviarEstado('disponible', { version: info.version });
    if (Notification.isSupported()) {
      new Notification({ title: 'ORT Engine', body: `Nueva versión ${info.version} disponible` }).show();
    }
  });
  autoUpdater.on('download-progress', (p) => enviarEstado('descargando', { porcentaje: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (info) => enviarEstado('lista', { version: info.version }));
  autoUpdater.on('error', (e) => enviarEstado('error', { mensaje: e ? e.message : 'Error desconocido' }));
}

async function buscarActualizaciones() {
  if (!autoUpdater) return enviarEstado('error', { mensaje: 'Falta el paquete electron-updater. Corre "npm install".' });
  if (!app.isPackaged) return enviarEstado('dev');   // con "npm start" no hay nada que actualizar
  try { await autoUpdater.checkForUpdates(); }
  catch (e) { enviarEstado('error', { mensaje: e.message }); }
}

ipcMain.handle('app:version', () => app.getVersion());
ipcMain.handle('update:buscar', () => buscarActualizaciones());
ipcMain.handle('update:descargar', async () => {
  if (!autoUpdater) return;
  try { await autoUpdater.downloadUpdate(); }
  catch (e) { enviarEstado('error', { mensaje: e.message }); }
});
ipcMain.handle('update:instalar', () => { if (autoUpdater) autoUpdater.quitAndInstall(); });

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/* ---------- Buscar scripts de Python ----------
   Antes se buscaba con execSync en TODO el home cada vez que se leía un slot
   (y el reintento es cada segundo), lo que congelaba la app.
   Ahora se busca una sola vez, sin bloquear, y se recuerda la ruta. */
const rutasEncontradas = {};

function buscarScript(targetName) {
  const guardada = rutasEncontradas[targetName];
  if (guardada && fs.existsSync(guardada)) return Promise.resolve(guardada);

  const home = app.getPath('home');
  const searchDirs = [
    __dirname,
    path.join(__dirname, 'bin'),
    path.join(home, 'Music'),
    path.join(home, 'Música'),
    path.join(home, 'Desktop'),
    path.join(home, 'Escritorio'),
    path.join(home, 'Documents'),
    path.join(home, 'Documentos'),
    path.join(home, 'Downloads'),
    path.join(home, 'Descargas'),
    path.join(home, 'scripts')
  ];

  for (const dir of searchDirs) {
    const fullPath = path.join(dir, targetName);
    if (fs.existsSync(fullPath)) {
      rutasEncontradas[targetName] = fullPath;
      return Promise.resolve(fullPath);
    }
  }

  // Búsqueda completa en el home, en segundo plano (no congela la ventana)
  return new Promise((resolve) => {
    exec(`find "${home}" -name "${targetName}" -print -quit 2>/dev/null`, { timeout: 20000 }, (_err, stdout) => {
      const found = (stdout || '').toString().trim();
      if (found && fs.existsSync(found)) {
        rutasEncontradas[targetName] = found;
        resolve(found);
      } else {
        resolve(null);
      }
    });
  });
}

/* ---------- Terminales de cada slot ----------
   - La terminal ejecuta el comando directamente (sin xdotool ni portapapeles).
   - Usa "bash -i" para cargar tu ~/.bashrc igual que cuando pegabas el comando a mano.
   - Cada terminal se llama "SLOT 01", "SLOT 02"... y guarda su número de proceso,
     así la app puede traerla al frente o cerrarla desde su tarjeta. */
const os = require('os');
const DIR_TMP = path.join(os.tmpdir(), `ort-engine-${process.getuid ? process.getuid() : 'u'}`);
try { fs.mkdirSync(DIR_TMP, { recursive: true }); } catch (e) {}

// bashrc propio para la terminal: carga el tuyo y mantiene el título "SLOT 01" fijo
const RC_FILE = path.join(DIR_TMP, 'bashrc');
try {
  fs.writeFileSync(RC_FILE, [
    '[ -f ~/.bashrc ] && . ~/.bashrc',
    'PS1=\'\\[\\e]0;\'"$ORT_TITLE"\'\\a\\]\\[\\e[01;32m\\]\\u@\\h\\[\\e[00m\\]:\\[\\e[01;34m\\]\\w\\[\\e[00m\\]\\$ \'',
    ''
  ].join('\n'));
} catch (e) {}

const pidFile = (clave) => path.join(DIR_TMP, `${clave}.pid`);
const comillas = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function abrirTerminal(clave, titulo, comando) {
  const homeDir = app.getPath('home');
  try { fs.unlinkSync(pidFile(clave)); } catch (e) {}
  const script = [
    `printf '\\033]0;%s\\007' ${comillas(titulo)}`,
    `echo $$ > ${comillas(pidFile(clave))}`,
    `echo "\\$ ${comando.replace(/"/g, '\\"')}"`,
    comando,
    `export ORT_TITLE=${comillas(titulo)}`,
    `exec bash --rcfile ${comillas(RC_FILE)}`
  ].join('; ');
  const term = spawn('gnome-terminal', [
    `--working-directory=${homeDir}`,
    '--', 'bash', '-ic', script
  ], { detached: true, stdio: 'ignore' });
  term.on('error', () => {});
  term.unref();
}

function leerPid(clave) {
  try {
    const pid = parseInt(fs.readFileSync(pidFile(clave), 'utf8').trim(), 10);
    if (!pid) return null;
    process.kill(pid, 0);           // lanza error si el proceso ya no existe
    return pid;
  } catch (e) {
    return null;
  }
}

// ¿Se puede traer una ventana al frente? Solo en sesiones X11 y con wmctrl instalado.
let puedeEnfocar = null;
function revisarEnfoque() {
  if (puedeEnfocar) return Promise.resolve(puedeEnfocar);
  return new Promise((resolve) => {
    const sesion = (process.env.XDG_SESSION_TYPE || '').toLowerCase();
    if (sesion === 'wayland') {
      puedeEnfocar = { ok: false, motivo: 'wayland' };
      return resolve(puedeEnfocar);
    }
    exec('command -v wmctrl', (err) => {
      puedeEnfocar = err ? { ok: false, motivo: 'sin-wmctrl' } : { ok: true };
      resolve(puedeEnfocar);
    });
  });
}

const claveSlot = (slot) => `slot-${String(slot).padStart(2, '0')}`;
const tituloSlot = (slot) => `SLOT ${String(slot).padStart(2, '0')}`;

// Qué slots tienen su terminal abierta
ipcMain.handle('terminal:vivas', () => {
  const vivas = [];
  for (let s = 1; s <= 16; s++) if (leerPid(claveSlot(s))) vivas.push(s);
  return vivas;
});

ipcMain.handle('terminal:capacidad', () => revisarEnfoque());

// Traer al frente la terminal del slot
ipcMain.handle('terminal:mostrar', async (_e, slot) => {
  if (!leerPid(claveSlot(slot))) return { ok: false, motivo: 'cerrada' };
  const cap = await revisarEnfoque();
  if (!cap.ok) return cap;
  return new Promise((resolve) => {
    exec(`wmctrl -F -a ${comillas(tituloSlot(slot))}`, (err) => {
      resolve(err ? { ok: false, motivo: 'no-encontrada' } : { ok: true });
    });
  });
});

// Cerrar la terminal del slot (y todo lo que esté corriendo dentro)
ipcMain.handle('terminal:cerrar', (_e, slot) => {
  const pid = leerPid(claveSlot(slot));
  if (!pid) return { ok: true, yaCerrada: true };
  return new Promise((resolve) => {
    exec(`pkill -HUP -s ${pid}; sleep 0.5; pkill -KILL -s ${pid}`, () => {
      try { fs.unlinkSync(pidFile(claveSlot(slot))); } catch (e) {}
      resolve({ ok: true });
    });
  });
});

ipcMain.handle('read-eeprom', async (event, slotNum, loopsNum = 7, launchTerminal = false, detectedPartNumber = null, detectedSerial = null) => {
  if (launchTerminal) {
    const regressionScript = '~/viper-test/opentest/tools/ot_regression.py';
    const staticValue = 1200;
    const regressionCommandStr = `${regressionScript} ${slotNum} ${detectedPartNumber || '0000000'} ${detectedSerial || 'FLG-0000'} ${loopsNum} ${staticValue}`;

    abrirTerminal(claveSlot(slotNum), tituloSlot(slotNum), regressionCommandStr);

    return {
      slot: slotNum,
      model: 'Ghostfish Unit',
      serial: detectedSerial || 'FLG-0000',
      partNumber: detectedPartNumber || '0000000',
      status: 'ONLINE',
      log: `> [COMANDO EJECUTADO AUTOMÁTICAMENTE]:\n> ${regressionCommandStr}`
    };
  }

  const scriptPath = await buscarScript('read_eeprom_ghostfish.py');

  if (!scriptPath) {
    return {
      slot: slotNum,
      model: 'Ghostfish Unit',
      serial: 'ERR_NO_SCRIPT',
      partNumber: '0000000',
      status: 'NOT FOUND',
      log: 'Error: Script read_eeprom_ghostfish.py no encontrado en la PC.'
    };
  }

  return new Promise((resolve) => {
    let fullOutput = '';
    let terminado = false;

    const pythonProcess = spawn('python3', [scriptPath], { stdio: ['pipe', 'pipe', 'pipe'] });

    // Si el script se queda esperando (por ejemplo pide otro dato), lo cerramos
    const limite = setTimeout(() => {
      if (terminado) return;
      terminado = true;
      try { pythonProcess.kill('SIGKILL'); } catch (e) {}
      resolve({
        slot: slotNum,
        model: 'Ghostfish Unit',
        serial: 'ERR_TIMEOUT',
        partNumber: '0000000',
        status: 'TIMEOUT',
        log: (fullOutput.trim() + `\n> [TIMEOUT] El script no terminó en ${TIMEOUT_LECTURA_MS / 1000}s.`).trim()
      });
    }, TIMEOUT_LECTURA_MS);

    setTimeout(() => {
      try { pythonProcess.stdin.write(`${slotNum}\n`); } catch (e) {}
    }, 200);

    pythonProcess.stdout.on('data', (data) => {
      const chunk = data.toString();
      fullOutput += chunk;
      process.stdout.write(chunk);
    });

    pythonProcess.stderr.on('data', (data) => {
      const chunk = data.toString();
      fullOutput += chunk;
      process.stderr.write(chunk);
    });

    pythonProcess.on('close', (code) => {
      if (terminado) return;
      terminado = true;
      clearTimeout(limite);

      let serial = 'FLG_ERR-0000';
      let partNumber = '0000000';

      const serialMatch = fullOutput.match(/FLG[0-9]{4}-[0-9]{4,5}/);
      if (serialMatch) serial = serialMatch[0];

      const partMatch = fullOutput.match(/\b[0-9]{7}\b/);
      if (partMatch) partNumber = partMatch[0];

      resolve({
        slot: slotNum,
        model: 'Ghostfish Unit',
        serial,
        partNumber,
        status: code === 0 ? 'ONLINE' : 'RETRY',
        log: fullOutput.trim()
      });
    });

    pythonProcess.on('error', (err) => {
      if (terminado) return;
      terminado = true;
      clearTimeout(limite);
      resolve({
        slot: slotNum,
        model: 'Ghostfish Unit',
        serial: 'ERR_PROCESS',
        partNumber: '0000000',
        status: 'ERROR',
        log: `Error al ejecutar proceso: ${err.message}`
      });
    });
  });
});

/* ---------- Monitor ----------
   Antes, apagar el interruptor no detenía nada: se "mataba" el proceso que abre
   gnome-terminal, que ya había terminado, y el monitor seguía corriendo.
   Ahora se detiene el script de Python directamente por su nombre. */
ipcMain.handle('launch-monitor-script', async () => {
  const scriptPath = await buscarScript('ghostfish_monitor.py');
  if (!scriptPath) return { success: false };

  abrirTerminal('monitor', 'GHOSTFISH MONITOR', `python3 ${comillas(scriptPath)}`);
  return { success: true, path: scriptPath };
});

ipcMain.handle('stop-monitor-script', () => {
  return new Promise((resolve) => {
    exec('pkill -f "[g]hostfish_monitor.py"', () => resolve({ success: true }));
  });
});

/* ---------- Historial de unidades ----------
   Se guarda en un archivo de la PC (no se pierde al cerrar ni al actualizar la app):
   ~/.config/ort-engine/historial.json  (o la carpeta de datos de la app)              */
const archivoHistorial = () => path.join(app.getPath('userData'), 'historial.json');
let historialCache = null;

function leerHistorial() {
  if (historialCache) return historialCache;
  try {
    const datos = JSON.parse(fs.readFileSync(archivoHistorial(), 'utf8'));
    historialCache = Array.isArray(datos) ? datos : [];
  } catch (e) {
    historialCache = [];
  }
  return historialCache;
}

function escribirHistorial() {
  const destino = archivoHistorial();
  try {
    fs.mkdirSync(path.dirname(destino), { recursive: true });
    const tmp = destino + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(historialCache, null, 1));
    fs.renameSync(tmp, destino);          // escritura segura: nunca queda a medias
    return true;
  } catch (e) {
    console.error('No se pudo guardar el historial:', e.message);
    return false;
  }
}

ipcMain.handle('historial:listar', () => leerHistorial());

// Crea o actualiza un registro (se identifica por "id")
ipcMain.handle('historial:guardar', (_e, registro) => {
  if (!registro || !registro.id) return { ok: false };
  const lista = leerHistorial();
  const k = lista.findIndex((r) => r.id === registro.id);
  if (k >= 0) {
    lista[k] = { ...lista[k], ...registro };
  } else {
    lista.push({
      pc: os.hostname(),
      usuario: (() => { try { return os.userInfo().username; } catch (e) { return ''; } })(),
      versionApp: app.getVersion(),
      ...registro
    });
  }
  return { ok: escribirHistorial() };
});

// Exportar a un archivo CSV que abre Excel / LibreOffice
ipcMain.handle('historial:exportar', async (_e, csv, nombre) => {
  const r = await dialog.showSaveDialog(BrowserWindow.getFocusedWindow() || mainWindow, {
    title: 'Exportar historial',
    defaultPath: path.join(app.getPath('documents'), nombre || 'historial.csv'),
    filters: [{ name: 'CSV (Excel)', extensions: ['csv'] }]
  });
  if (r.canceled || !r.filePath) return { ok: false, cancelado: true };
  try {
    fs.writeFileSync(r.filePath, '\ufeff' + csv, 'utf8');   // BOM: Excel respeta acentos
    return { ok: true, ruta: r.filePath };
  } catch (e) {
    return { ok: false, mensaje: e.message };
  }
});

/* ---------- Manual de usuario (PDF incluido en la app) ----------
   El PDF va dentro de la app (manual/Manual-ORT-Engine.pdf). Como dentro del paquete
   no se puede abrir directo, se copia a la carpeta de datos y se abre desde ahí. */
const PDF_MANUAL = path.join(__dirname, 'manual', 'Manual-ORT-Engine.pdf');
ipcMain.handle('manual:abrir-pdf', async () => {
  try {
    const destino = path.join(app.getPath('userData'), 'Manual-ORT-Engine.pdf');
    fs.writeFileSync(destino, fs.readFileSync(PDF_MANUAL));
    const err = await shell.openPath(destino);
    return err ? { ok: false, mensaje: err, ruta: destino } : { ok: true, ruta: destino };
  } catch (e) { return { ok: false, mensaje: e.message }; }
});
ipcMain.handle('manual:guardar-pdf', async () => {
  try {
    const r = await dialog.showSaveDialog(mainWindow, {
      title: 'Guardar manual de usuario',
      defaultPath: path.join(app.getPath('documents'), 'Manual-ORT-Engine.pdf'),
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    });
    if (r.canceled || !r.filePath) return { ok: false, cancelado: true };
    fs.writeFileSync(r.filePath, fs.readFileSync(PDF_MANUAL));
    return { ok: true, ruta: r.filePath };
  } catch (e) { return { ok: false, mensaje: e.message }; }
});

ipcMain.handle('historial:carpeta', () => {
  const f = archivoHistorial();
  if (fs.existsSync(f)) shell.showItemInFolder(f);
  else shell.openPath(path.dirname(f));
  return { ok: true, ruta: f };
});


/* ---------- Notificaciones al celular (ntfy) ----------
   Se configuran desde la campana de la app. Se guardan en ~/.config/ort-engine/config.json */
const archivoConfig = () => path.join(app.getPath('userData'), 'config.json');
const CONFIG_BASE = {
  ntfy: { activo: true, servidor: 'https://ntfy.sh', tema: 'drdt', token: '', entrada: true, fin: false, detenido: false }
};

function leerConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(archivoConfig(), 'utf8'));
    return { ...CONFIG_BASE, ...c, ntfy: { ...CONFIG_BASE.ntfy, ...(c.ntfy || {}) } };
  } catch (e) {
    return JSON.parse(JSON.stringify(CONFIG_BASE));
  }
}
function guardarConfig(c) {
  try {
    fs.mkdirSync(path.dirname(archivoConfig()), { recursive: true });
    fs.writeFileSync(archivoConfig(), JSON.stringify(c, null, 2));
    return true;
  } catch (e) {
    return false;
  }
}

ipcMain.handle('config:leer', () => leerConfig());
ipcMain.handle('config:guardar', (_e, ntfy) => {
  const c = leerConfig();
  c.ntfy = { ...c.ntfy, ...ntfy };
  return { ok: guardarConfig(c), config: c };
});

async function publicarNtfy(n, aviso) {
  const servidor = String(n.servidor || 'https://ntfy.sh').trim().replace(/\/+$/, '');
  const tema = String(n.tema || '').trim();
  if (!tema) return { ok: false, mensaje: 'Falta el tema' };
  const headers = { 'Content-Type': 'application/json' };
  if (n.token) headers.Authorization = `Bearer ${String(n.token).trim()}`;
  const ctrl = new AbortController();
  const limite = setTimeout(() => ctrl.abort(), 10000);
  try {
    // Publicación en JSON: acepta acentos y emojis sin problema
    const r = await fetch(servidor + '/', {
      method: 'POST',
      headers,
      body: JSON.stringify({ topic: tema, title: aviso.title, message: aviso.message, tags: aviso.tags || [], priority: aviso.priority || 3 }),
      signal: ctrl.signal
    });
    if (r.ok) return { ok: true };
    const motivos = { 401: 'Token incorrecto o falta token', 403: 'Sin permiso para ese tema', 429: 'Demasiados avisos, espera un momento' };
    return { ok: false, mensaje: motivos[r.status] || `El servidor respondió ${r.status}` };
  } catch (e) {
    return { ok: false, mensaje: e.name === 'AbortError' ? 'Sin respuesta del servidor (10 s)' : 'Sin conexión a internet o servidor no encontrado' };
  } finally {
    clearTimeout(limite);
  }
}

// Si no hay internet, el aviso se guarda y se reintenta cada minuto (hasta 24 h)
const pendientesNtfy = [];
setInterval(async () => {
  if (!pendientesNtfy.length) return;
  const n = leerConfig().ntfy;
  if (!n.activo) return;
  for (const p of [...pendientesNtfy]) {
    if (Date.now() - p.creado > 24 * 3600 * 1000) { pendientesNtfy.splice(pendientesNtfy.indexOf(p), 1); continue; }
    const r = await publicarNtfy(n, p.aviso);
    if (r.ok) pendientesNtfy.splice(pendientesNtfy.indexOf(p), 1);
    else break;
  }
}, 60 * 1000);

// Evento de la app: 'entrada' | 'fin' | 'detenido'
ipcMain.handle('ntfy:evento', async (_e, tipo, aviso) => {
  const n = leerConfig().ntfy;
  if (!n.activo || !n[tipo]) return { ok: false, omitido: true };
  aviso = { ...aviso, message: `${aviso.message}\nEstación: ${os.hostname()}` };
  const r = await publicarNtfy(n, aviso);
  if (!r.ok && pendientesNtfy.length < 100) pendientesNtfy.push({ aviso, creado: Date.now() });
  return r;
});

// Botón "Enviar prueba" (usa lo que esté escrito aunque no se haya guardado)
ipcMain.handle('ntfy:prueba', (_e, n) => publicarNtfy(n, {
  title: 'DRDT Engine · prueba',
  message: `Las notificaciones funcionan ✔\nEstación: ${os.hostname()}`,
  tags: ['bell'],
  priority: 3
}));

/* ---------- Asistente de bienvenida: revisar e instalar lo necesario ---------- */
function comandoExiste(cmd) {
  return new Promise((resolve) => exec(`command -v ${cmd}`, (err, out) => resolve(!err && String(out).trim() ? String(out).trim() : null)));
}
function versionDe(cmd) {
  return new Promise((resolve) => exec(cmd, { timeout: 5000 }, (err, out, errOut) => resolve(err ? null : String(out || errOut).trim())));
}

ipcMain.handle('sistema:revisar', async () => {
  const home = app.getPath('home');
  const [terminal, python, wmctrl, eeprom] = await Promise.all([
    comandoExiste('gnome-terminal'),
    versionDe('python3 --version'),
    comandoExiste('wmctrl'),
    buscarScript('read_eeprom_ghostfish.py')
  ]);
  const regresion = path.join(home, 'viper-test/opentest/tools/ot_regression.py');
  const sesion = (process.env.XDG_SESSION_TYPE || 'desconocida').toLowerCase();

  return [
    { id: 'terminal', nombre: 'Terminal de Ubuntu', desc: 'Abre una terminal por cada slot',
      estado: terminal ? 'ok' : 'error', detalle: terminal ? 'gnome-terminal instalado' : 'No está instalada', paquete: terminal ? null : 'gnome-terminal' },
    { id: 'python', nombre: 'Python 3', desc: 'Ejecuta los scripts de lectura',
      estado: python ? 'ok' : 'error', detalle: python || 'No está instalado', paquete: python ? null : 'python3' },
    { id: 'eeprom', nombre: 'Script de lectura EEPROM', desc: 'read_eeprom_ghostfish.py',
      estado: eeprom ? 'ok' : 'error', detalle: eeprom ? eeprom.replace(home, '~') : 'No encontrado. Cópialo a tu Escritorio, Documentos o ~/scripts', paquete: null },
    { id: 'regresion', nombre: 'Script de regresión', desc: 'ot_regression.py de viper-test',
      estado: fs.existsSync(regresion) ? 'ok' : 'warn', detalle: fs.existsSync(regresion) ? '~/viper-test/opentest/tools/ot_regression.py' : 'No está en ~/viper-test/opentest/tools/ (necesario en la PC de pruebas)', paquete: null },
    { id: 'wmctrl', nombre: 'Ir a la terminal', desc: 'Trae al frente la terminal de cada slot (wmctrl)',
      estado: wmctrl ? 'ok' : 'warn', detalle: wmctrl ? 'wmctrl instalado' : 'Falta instalar wmctrl', paquete: wmctrl ? null : 'wmctrl' },
    { id: 'sesion', nombre: 'Sesión gráfica', desc: 'X11 permite traer ventanas al frente',
      estado: sesion === 'x11' ? 'ok' : 'warn', detalle: sesion === 'x11' ? 'X11' : `${sesion}: elige "Ubuntu en Xorg" al iniciar sesión para usar "Ir a la terminal"`, paquete: null }
  ];
});

// Instala paquetes con la ventana de contraseña de Ubuntu (pkexec). Solo paquetes permitidos.
const PAQUETES_PERMITIDOS = new Set(['wmctrl', 'gnome-terminal', 'python3']);
ipcMain.handle('sistema:instalar', (_e, paquetes) => {
  const lista = (Array.isArray(paquetes) ? paquetes : []).filter((p) => PAQUETES_PERMITIDOS.has(p));
  if (!lista.length) return { ok: true, nada: true };
  return new Promise((resolve) => {
    const proc = spawn('pkexec', ['env', 'DEBIAN_FRONTEND=noninteractive', 'apt-get', 'install', '-y', ...lista], { stdio: ['ignore', 'pipe', 'pipe'] });
    let salida = '';
    proc.stdout.on('data', (d) => { salida += d; });
    proc.stderr.on('data', (d) => { salida += d; });
    const limite = setTimeout(() => { try { proc.kill(); } catch (e) {} }, 5 * 60 * 1000);
    proc.on('error', (err) => { clearTimeout(limite); resolve({ ok: false, mensaje: 'No se pudo pedir permisos: ' + err.message }); });
    proc.on('close', (code) => {
      clearTimeout(limite);
      puedeEnfocar = null;                       // volver a revisar si ya se puede "Ir a la terminal"
      if (code === 0) resolve({ ok: true });
      else if (code === 126 || code === 127) resolve({ ok: false, cancelado: true, mensaje: 'Se canceló la contraseña' });
      else resolve({ ok: false, mensaje: (salida.trim().split('\n').pop() || `Error ${code}`).slice(0, 200) });
    });
  });
});

// Marca que el asistente ya se vio
ipcMain.handle('config:bienvenida', (_e, vista) => {
  const c = leerConfig();
  c.bienvenida = vista ? { vista: true, version: app.getVersion(), fecha: Date.now() } : null;
  return { ok: guardarConfig(c) };
});
