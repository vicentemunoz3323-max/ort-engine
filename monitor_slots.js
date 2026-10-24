'use strict';
/* ============================================================
   MONITOR DE SLOTS (proceso principal)
   Cada terminal de slot guarda todo lo que imprime en un archivo
   (slot-01.log …) sin cambiar lo que ves en la terminal. Aquí se lee ese archivo en vivo:

   - "Execution N started successfully"  → el slot va en el loop N
   - un error con 8090 / localhost        → SISTEMA CAÍDO (el servicio de la PC)
   - "refused", Traceback, ERROR, FAIL…   → SLOT CAÍDO
   - el script terminó (slot-01.exit)     → código 0 = terminó bien, otro = caído

   Si cambian los mensajes de ot_regression.py, ajusta las expresiones de abajo.
   ============================================================ */
const fs = require('fs');
const path = require('path');

// ---- Mensajes que se reconocen (sin distinguir mayúsculas; tolera faltas de ortografía) ----
const RX_EJECUCION = /exc?e?cution\s*#?\s*(\d+)[^\n]{0,40}?start\w*\s+succ?e?ss?\w*/i;
const RX_FALLA = /refused|fail|error|unreachable|timed?\s*out|cannot connect|could not connect|connection reset|no route to host|exception|traceback|fatal|critical|no se pudo|caido|caído/i;
const RX_SISTEMA = /8090|127\.0\.0\.1|localhost/i;           // el servicio de pruebas de esta PC (open_test)
const RX_SLOT = [
  /refused/i,
  /traceback \(most recent call last\)/i,
  /\b(error|fatal|critical|exception)\b/i,
  /\bfail(ed|ure)?\b/i,
  /no route to host|unreachable|connection reset|timed?\s*out/i
];
// Líneas que mencionan errores pero NO son falla (resúmenes en cero, etc.)
const RX_NO_ES_FALLA = /\b(0|no|zero|sin)\s+(errors?|failures?|failed|fails?|errores?|fallas?)\b|\b(errors?|failures?|failed|fails?|errores?|fallas?)\s*[:=]\s*0\b|\bpass(ed)?\b.*\b0\s+fail/i;
const RX_ANSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\r/g;

const MAX_LINEAS = 40;
let DIR = null;
let avisar = () => {};
const est = {};            // slot -> estado

function configurar(opc) {
  DIR = opc.dir;
  if (opc.avisar) avisar = opc.avisar;
}
const pad = (n) => String(n).padStart(2, '0');
const archivoLog = (s) => path.join(DIR, `slot-${pad(s)}.log`);
const archivoExit = (s) => path.join(DIR, `slot-${pad(s)}.exit`);

function nuevo(s) {
  return { slot: s, offset: 0, resto: '', loop: null, loopTs: null, ejecuciones: [], estado: 'esperando',
    error: null, incidentes: [], exit: null, exitTs: null, lineas: [], cambio: Date.now() };
}

// Se llama justo antes de abrir la terminal de un slot: empieza una corrida limpia
function prepararCorrida(s) {
  for (const f of [archivoLog(s), archivoExit(s)]) { try { fs.unlinkSync(f); } catch (e) {} }
  est[s] = nuevo(s);
  publicar(s);
}

// Comando para la terminal: guarda todo en el .log (con "script", así la terminal se ve igual)
// y al terminar escribe el código de salida en el .exit
function envolver(s, comando, comillas) {
  const log = comillas(archivoLog(s)), exit = comillas(archivoExit(s));
  const interno = `bash -ic ${comillas(comando)}`;
  return `if command -v script >/dev/null 2>&1; then script -q -f -e -c ${comillas(interno)} ${log}; else ${comando}; fi; echo $? > ${exit}`;
}

function clasificar(linea) {
  const t = linea.trim();
  if (!t) return null;
  const m = t.match(RX_EJECUCION);
  if (m) return { tipo: 'ejecucion', n: parseInt(m[1], 10) };
  if (!RX_FALLA.test(t) || RX_NO_ES_FALLA.test(t)) return null;
  if (RX_SISTEMA.test(t)) return { tipo: 'sistema' };
  if (RX_SLOT.some((rx) => rx.test(t))) return { tipo: 'slot' };
  return null;
}

function procesarLinea(e, linea) {
  const t = linea.replace(RX_ANSI, '').replace(/[\x00-\x08\x0b-\x1f]/g, '').trimEnd();
  if (!t.trim()) return false;
  if (/^Script (started|done) on /.test(t)) return false;      // encabezado que agrega "script"
  e.lineas.push(t.slice(0, 400));
  if (e.lineas.length > MAX_LINEAS) e.lineas.shift();
  const c = clasificar(t);
  if (!c) return false;
  const ahora = Date.now();
  if (c.tipo === 'ejecucion') {
    const recuperado = e.estado === 'slot' || e.estado === 'sistema';
    e.loop = c.n; e.loopTs = ahora;
    e.ejecuciones.push({ n: c.n, ts: ahora });
    e.estado = 'corriendo';
    e.recuperado = recuperado ? { de: e.error, ts: ahora } : null;
    e.error = null;
    return true;
  }
  // un error: se reporta (el primero de una racha; los siguientes solo cuentan)
  if (e.error && e.error.tipo === c.tipo && e.estado === c.tipo) {
    e.error.repeticiones++; e.error.ultima = t.slice(0, 400);
    // tras "Traceback (most recent call last):" la línea que importa es la del error real
    if (/^traceback/i.test(e.error.linea)) { e.error.linea = t.slice(0, 400); e.incidentes[e.incidentes.length - 1].linea = e.error.linea; return true; }
    return false;
  }
  e.estado = c.tipo;
  e.error = { tipo: c.tipo, linea: t.slice(0, 400), ts: ahora, repeticiones: 1, loop: e.loop };
  e.incidentes.push({ tipo: c.tipo, linea: t.slice(0, 400), ts: ahora, loop: e.loop });
  if (e.incidentes.length > 30) e.incidentes.shift();
  return true;
}

function leer(s) {
  const e = est[s] || (est[s] = nuevo(s));
  let cambio = false;
  // 1) líneas nuevas del log
  try {
    const st = fs.statSync(archivoLog(s));
    if (st.size < e.offset) { e.offset = 0; e.resto = ''; }       // el log se reinició
    if (st.size > e.offset) {
      const fd = fs.openSync(archivoLog(s), 'r');
      const tam = Math.min(st.size - e.offset, 4 * 1024 * 1024);   // máximo 4 MB por vuelta
      const buf = Buffer.alloc(tam);
      fs.readSync(fd, buf, 0, tam, e.offset);
      fs.closeSync(fd);
      e.offset += tam;
      const txt = e.resto + buf.toString('utf8');
      const partes = txt.split(/\n/);
      e.resto = partes.pop();
      if (e.resto.length > 8000) { partes.push(e.resto); e.resto = ''; }
      for (const l of partes) for (const sub of l.split('\r')) if (procesarLinea(e, sub)) cambio = true;
    }
  } catch (err) { /* todavía no hay log */ }
  // 2) ¿terminó el script?
  if (e.exit === null) {
    try {
      const code = parseInt(fs.readFileSync(archivoExit(s), 'utf8').trim(), 10);
      if (!isNaN(code)) {
        if (e.resto) { procesarLinea(e, e.resto); e.resto = ''; }
        e.exit = code; e.exitTs = Date.now();
        if (code === 0) e.estado = 'terminado';
        else if (e.estado !== 'sistema') {
          e.estado = 'slot';
          if (!e.error) {
            e.error = { tipo: 'slot', linea: `El script terminó con código ${code}`, ts: Date.now(), repeticiones: 1, loop: e.loop };
            e.incidentes.push({ ...e.error });
          }
        }
        cambio = true;
      }
    } catch (err) {}
  }
  if (cambio) { e.cambio = Date.now(); publicar(s); }
}

function publico(s) {
  const e = est[s];
  if (!e) return null;
  const { offset, resto, ...resto2 } = e;
  return resto2;
}
function publicar(s) { try { avisar(s, publico(s)); } catch (e) {} }

function todos() {
  const r = {};
  for (let s = 1; s <= 16; s++) {
    if (!est[s]) { try { fs.statSync(archivoLog(s)); leer(s); } catch (e) { continue; } }
    if (est[s]) r[s] = publico(s);
  }
  return r;
}

let timer = null;
function iniciar() {
  if (timer) return;
  // al abrir la app se leen los logs que ya existan (corridas que siguen o que terminaron)
  for (let s = 1; s <= 16; s++) { try { fs.statSync(archivoLog(s)); leer(s); } catch (e) {} }
  timer = setInterval(() => { for (let s = 1; s <= 16; s++) if (est[s]) leer(s); }, 1500);
}

module.exports = { configurar, iniciar, prepararCorrida, envolver, todos, leer, clasificar, _est: est };
