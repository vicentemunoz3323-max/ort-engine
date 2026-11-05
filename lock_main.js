'use strict';
/* ============================================================
   LOCK: bloquea la pantalla con peces (proceso principal)
   - Cubre todos los monitores. Mientras tanto la app y las consolas siguen trabajando abajo.
   - Se quita con la contraseña del usuario de la PC (la misma de Linux).
   - Las contraseñas se revisan con "su" dentro de una pty de Python. No se guardan en ningún lado
     y nunca van en los argumentos de un comando (se pasan por stdin).
   ============================================================ */
const { ipcMain, BrowserWindow, screen, app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, exec } = require('child_process');

const VERIFICADOR = `
import os, pty, re, select, sys, time
usuario = sys.argv[1]
pw = sys.stdin.readline().rstrip("\\n")
pid, fd = pty.fork()
if pid == 0:
    os.environ["LC_ALL"] = "C"; os.environ["LANG"] = "C"
    os.execvp("su", ["su", usuario, "-c", "true"])
buf = b""; enviada = False; fin = time.time() + 12
while time.time() < fin:
    r, _, _ = select.select([fd], [], [], 0.3)
    if not r:
        p, st = os.waitpid(pid, os.WNOHANG)
        if p:
            sys.exit((os.WEXITSTATUS(st) if os.WIFEXITED(st) else 1) if enviada else 3)
        continue
    try: d = os.read(fd, 1024)
    except OSError: break
    if not d: break
    buf += d
    if not enviada and re.search(rb"(?i)(password|contrase)", buf):
        time.sleep(0.15); os.write(fd, (pw + "\\n").encode()); enviada = True; buf = b""
try:
    _, st = os.waitpid(pid, 0)
except ChildProcessError:
    sys.exit(3)
code = os.WEXITSTATUS(st) if os.WIFEXITED(st) else 1
sys.exit(code if enviada else 3)
`;

// "su" no funciona si la app se abrió con "no new privileges" (por ejemplo desde VS Code)
function noNewPrivs() {
  try { return /NoNewPrivs:\s*1/.test(fs.readFileSync('/proc/self/status', 'utf8')); } catch (e) { return false; }
}
const SYSTEMD_RUN = '/usr/bin/systemd-run';

function probarUsuario(usuario, pass) {
  return new Promise((resolve) => {
    let cmd = ['python3', '-c', VERIFICADOR, usuario];
    if (noNewPrivs() && fs.existsSync(SYSTEMD_RUN)) cmd = [SYSTEMD_RUN, '--user', '--pipe', '--wait', '--quiet', '--collect', '--', ...cmd];
    let p, fin = false;
    const listo = (c) => { if (!fin) { fin = true; clearTimeout(t); resolve(c); } };
    const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch (e) {} listo(3); }, 15000);
    try { p = spawn(cmd[0], cmd.slice(1), { stdio: ['pipe', 'ignore', 'ignore'] }); }
    catch (e) { return listo(3); }
    p.stdin.on('error', () => {});
    p.stdin.write(pass + '\n'); p.stdin.end();
    p.on('error', () => listo(3));
    p.on('close', (c) => listo(c === null ? 1 : c));
  });
}

// Se acepta la contraseña del usuario de la PC: el que abrió la app
function cuentas() {
  let lista = [];
  try { lista.push(os.userInfo().username); } catch (e) {}
  return lista.filter((c) => /^[a-z_][a-z0-9_.-]*$/i.test(c) && c !== 'root');
}

async function verificar(pass) {
  if (typeof pass !== 'string' || !pass || pass.length > 300 || /[\r\n]/.test(pass)) return { ok: false, error: 'Escribe la contraseña' };
  const lista = cuentas();
  if (!lista.length) return { ok: false, error: 'No se pudo revisar la contraseña: no hay un usuario válido.' };
  const r = await probarUsuario(lista[0], pass);
  if (r === 0) return { ok: true, usuario: lista[0] };
  return { ok: false, error: r === 3 ? 'No se pudo revisar la contraseña (su no la pidió).' : 'Contraseña incorrecta' };
}

let ventanas = [];
let activo = false;
let letrero = { titulo: '', subtitulo: '', encargado: '' };
const texto = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
let permitirCierre = false;
let avisar = () => {};

function crearVentanas() {
  cerrarVentanas();
  permitirCierre = false;
  screen.getAllDisplays().forEach((d, n) => {
    const w = new BrowserWindow({
      x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height,
      frame: false, kiosk: true, fullscreen: true, alwaysOnTop: true, skipTaskbar: true,
      movable: false, resizable: false, minimizable: false, maximizable: false, closable: false,
      backgroundColor: '#06283f', show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, 'lock_preload.js') }
    });
    w.setAlwaysOnTop(true, 'screen-saver');
    w.setVisibleOnAllWorkspaces(true);
    w.on('close', (e) => { if (!permitirCierre) e.preventDefault(); });
    w.webContents.on('will-navigate', (e) => e.preventDefault());
    w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    w.webContents.on('before-input-event', (e, inp) => {
      const k = String(inp.key || '').toLowerCase();
      if ((inp.control || inp.meta) && ['r', 'w', 'q', 'i', '+', '-', '=', '0'].includes(k)) e.preventDefault();
      if (['f5', 'f11', 'f12'].includes(k)) e.preventDefault();
    });
    w.once('ready-to-show', () => { w.show(); w.setKiosk(true); if (n === 0) w.focus(); });
    w.on('blur', () => setTimeout(() => {
      if (activo && !w.isDestroyed() && !BrowserWindow.getFocusedWindow()) { w.show(); w.focus(); }
    }, 300));
    w.loadFile(path.join(__dirname, 'lock.html'));
    ventanas.push(w);
  });
}
function cerrarVentanas() {
  permitirCierre = true;
  for (const w of ventanas) { try { if (!w.isDestroyed()) { w.setClosable(true); w.setKiosk(false); w.destroy(); } } catch (e) {} }
  ventanas = [];
}

function revisarHerramientas() {
  return new Promise((resolve) => exec('command -v su && command -v python3', { timeout: 5000 }, (err) => resolve(!err)));
}

function iniciar(opc = {}) {
  if (opc.avisar) avisar = opc.avisar;
  ipcMain.handle('auth:verificar', (_e, pass) => verificar(pass));
  ipcMain.handle('lock:activar', async (_e, datos) => {
    if (activo) return { ok: true };
    const d = datos || {};
    letrero = { titulo: texto(d.titulo, 60), subtitulo: texto(d.subtitulo, 90), encargado: texto(d.encargado, 50) };
    if (process.getuid && process.getuid() === 0) return { ok: false, error: 'La app corre como root: no se podría revisar la contraseña para quitar el bloqueo.' };
    // Sin estas herramientas no se podría desbloquear: mejor no bloquear
    if (!(await revisarHerramientas())) return { ok: false, error: 'Faltan "su" o "python3": no se podría quitar el bloqueo.' };
    activo = true;
    crearVentanas();
    avisar(true);
    return { ok: true };
  });
  ipcMain.handle('lock:info', () => ({ equipo: os.hostname(), cuentas: cuentas(), ...letrero }));
  ipcMain.handle('lock:desbloquear', async (_e, pass) => {
    if (!activo) return { ok: true };
    const r = await verificar(pass);
    if (!r.ok) { avisar(true, true); return r; }
    activo = false;
    cerrarVentanas();
    avisar(false);
    return { ok: true };
  });
  const rehacer = () => { if (activo) setTimeout(crearVentanas, 500); };
  screen.on('display-added', rehacer);
  screen.on('display-removed', rehacer);
  // Para que la app pueda cerrarse o actualizarse aunque esté bloqueada
  app.on('before-quit', () => { activo = false; cerrarVentanas(); });
}

module.exports = { iniciar, verificar, _VERIFICADOR: VERIFICADOR };
