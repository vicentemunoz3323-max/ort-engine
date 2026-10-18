# ORT Engine · Ghostfish Slot Manager (v1.1.0)

Administra 16 slots: lee la EEPROM de cada unidad con `read_eeprom_ghostfish.py`
y, al obtener serial y número de parte, abre una terminal que ejecuta
`~/viper-test/opentest/tools/ot_regression.py` con los loops configurados.

## Archivos

| Archivo | Para qué sirve |
|---|---|
| `main.js` | Lógica: busca los scripts, lee EEPROM, abre terminales, monitor |
| `index.html` | Interfaz |
| `package.json` | Configuración del proyecto y del instalador `.deb` |
| `package-lock.json` | Versiones exactas de Electron |
| `fonts/` | Tipografías Inter y DejaVu Sans Mono (licencias incluidas) |
| `icons/` | Logo DRDT Engine dibujado en cada tamaño (16 a 512 px) para que se vea nítido |

## Requisitos

- Ubuntu con **gnome-terminal** (el que trae Ubuntu por defecto)
- **Node.js** y **npm**
- **python3**
- Los scripts `read_eeprom_ghostfish.py` y `ghostfish_monitor.py` en algún lugar de tu carpeta personal
  (Escritorio, Documentos, Descargas, Música, `~/scripts`, o la carpeta `bin/` del proyecto)

Ya **no necesita xdotool**.

Opcional, para el botón **Ir a la terminal** de cada slot:

```
sudo apt install wmctrl
```

Funciona en sesiones **X11**. En **Wayland**, Ubuntu no deja traer ventanas al frente, pero
**Cerrar terminal** funciona igual. Para saber cuál usas: `echo $XDG_SESSION_TYPE`.

## Probarla

```
npm install
npm start
```

`npm install` descarga Electron y el actualizador (`electron-updater`), y actualiza `package-lock.json`.

## Crear el instalador .deb

```
npm run build:deb
```

El instalador queda en la carpeta `dist/`. Instálalo con:

```
sudo apt install ./dist/ort-engine_1.1.0_amd64.deb
```

## Versiones y actualizaciones

La app muestra su versión arriba a la derecha y abajo en el pie.
Al abrirla (y cada hora) revisa si hay una versión nueva en GitHub. Si la hay, avisa con
una notificación y un aviso dentro de la app → **Descargar** → **Reiniciar e instalar**.
También puedes revisar a mano con el botón **Actualizaciones**.

- Solo funciona en la app **instalada** desde el `.deb`. Con `npm start` muestra "Modo desarrollo".
- Al instalar, Ubuntu te pide tu contraseña.
- El repo `ort-engine` en GitHub debe ser **público**.

### Publicar una versión nueva

1. En `package.json` sube el número de `"version"` (por ejemplo de `1.1.0` a `1.1.1`).
2. En la terminal, con tu token de GitHub (el mismo que usas para Neon Desk):
   ```
   export GH_TOKEN=tu_token
   npm run release
   ```
3. Entra a GitHub → **Releases** de `ort-engine`. Si quedó como borrador (*Draft*),
   ábrelo y presiona **Publish release**.

Las PCs que tengan la app instalada verán el aviso de la versión nueva.

> Si el número de `"version"` no cambia, las PCs no se enteran de la actualización.

## Qué mejoró respecto a la versión 1.0.1

**Funcionamiento**
- La terminal ejecuta el comando directamente: ya no usa xdotool ni el portapapeles
  (funciona en Wayland y no se mezclan los comandos con "Lanzar todos").
- Carga tu `~/.bashrc` igual que si pegaras el comando a mano.
- Los scripts se buscan una sola vez y sin congelar la ventana.
- Si falta `read_eeprom_ghostfish.py`, el slot se marca en rojo en vez de reintentar sin fin.
- La lectura de EEPROM tiene límite de 45 s; si se traba, reintenta.
- El interruptor **Monitor** sí detiene `ghostfish_monitor.py` al apagarlo.
- Los loops de cada slot se **guardan** y se recuerdan al volver a abrir la app.
- **Reiniciar** pide confirmación si hay slots trabajando.
- Muestra la versión y avisa cuando hay una actualización disponible en GitHub.

**Interfaz (estilo Google / Material Design)**
- Botones redondeados, tarjetas suaves y efecto de onda al hacer clic.
- Interruptor del monitor estilo Android.
- Filtros arriba de los slots (Todos, Activos, En proceso, Error, Libres) con contador:
  toca uno para resaltar solo esos slots.
- Barra de progreso en cada slot mientras lee.
- Modo claro y oscuro (botón de luna/sol arriba a la derecha); se recuerda tu elección.
- Historial de actividad con hora.
- Avisos de actualización abajo a la izquierda.
- Los slots se pueden activar también con el teclado (Tab + Enter).
- Tipografía Inter incluida en la app (se ve igual en cualquier PC).
- Botón de terminal en cada slot (aparece en verde cuando su terminal está abierta):
  **Ir a la terminal** la trae al frente y **Cerrar terminal** la cierra con todo lo que corre.
  Si cierras la ventana a mano, la tarjeta se actualiza sola.
- Contador de loops en cada slot: cada loop dura **8 h** y se cuenta desde 0
  (7 = loops 0 a 7 = 8 loops = 64 h). Muestra el loop actual, el tiempo que le falta y una
  barra con un segmento por loop. Al pasar el mouse muestra el tiempo total restante y a qué hora termina.
  Al terminar avisa con una notificación. Si cierras y vuelves a abrir la app, los slots que
  siguen corriendo se recuperan con su contador.
