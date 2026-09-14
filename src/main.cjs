const { app, BrowserWindow, ipcMain, webContents, session, shell } = require('electron')
const path = require('path')
const fs = require('fs')
const { execFile } = require('child_process')
const { pathToFileURL } = require('url')
const png = require('./png.cjs')

/* Lanzada desde una tubería que se cierra antes que la app (un `| head`, un
 * terminal que muere), el primer console.log del proceso principal lanza EPIPE
 * y, sin capturar, Electron abre un diálogo de error. Un log perdido no debe
 * tumbar la app; sólo silenciamos ese caso. */
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (err) => { if (err.code !== 'EPIPE') throw err })
}

let win = null

function createWindow () {
  win = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0b0c0e',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 16 },
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true
    }
  })

  win.once('ready-to-show', () => win.show())
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  win.on('closed', () => { win = null })
}

// Allow self-signed / invalid certs on local dev servers only.
app.on('certificate-error', (event, wc, url, error, cert, callback) => {
  if (/^https:\/\/(localhost|127\.0\.0\.1|\[::1\]|.*\.local)(:\d+)?/.test(url)) {
    event.preventDefault()
    callback(true)
  } else {
    callback(false)
  }
})

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

/* ------------------------------------------------------------------ *
 * Guest emulation (colour scheme / locale) via the Chrome DevTools
 * protocol. `webview.setZoomFactor` covers zoom, but emulated media and
 * locale overrides are only reachable through the debugger.
 * ------------------------------------------------------------------ */

function attach (wc) {
  if (!wc.debugger.isAttached()) wc.debugger.attach('1.3')
}

async function applyEmulation (wc, { colorScheme, locale, reducedMotion }) {
  attach(wc)
  const features = []
  if (colorScheme && colorScheme !== 'auto') {
    features.push({ name: 'prefers-color-scheme', value: colorScheme })
  }
  if (reducedMotion) {
    features.push({ name: 'prefers-reduced-motion', value: 'reduce' })
  }
  await wc.debugger.sendCommand('Emulation.setEmulatedMedia', { media: '', features })
  await wc.debugger.sendCommand('Emulation.setLocaleOverride',
    locale && locale !== 'auto' ? { locale } : {})
}

ipcMain.handle('emulate', async (_e, opts) => {
  const wc = webContents.fromId(opts.id)
  if (!wc || wc.isDestroyed()) return { ok: false, reason: 'gone' }
  try {
    await applyEmulation(wc, opts)
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: String((err && err.message) || err) }
  }
})

ipcMain.handle('open-devtools', (_e, { id }) => {
  try {
    const wc = webContents.fromId(id)
    if (wc && !wc.isDestroyed()) wc.openDevTools({ mode: 'detach' })
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: String((err && err.message) || err) }
  }
})

ipcMain.handle('clear-storage', async (_e, { partition }) => {
  try {
    const ses = session.fromPartition(partition || 'persist:previewer')
    /* clearStorageData deja fuera la caché HTTP, y sin ella una recarga puede
     * seguir sirviendo el bundle viejo: las dos o ninguna. */
    await Promise.all([ses.clearStorageData(), ses.clearCache()])
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: String((err && err.message) || err) }
  }
})

/* ------------------------------------------------------------------ *
 * Capture.
 *
 * Screenshots are taken in a throwaway offscreen window sized to the
 * device, never from the live <webview>: capturing a guest is unreliable
 * here, the on-screen panel is rasterised at the canvas zoom (so anything
 * read back from it is soft when you are zoomed out), and this way the live
 * panel is left completely alone. It shares the browsing session, so logins
 * carry over, but the page is loaded afresh: state living only in the
 * running page is not reproduced.
 *
 * Resolution is the whole point of how this works, so, in order:
 *
 *   - Density is *set*, not inherited. Emulation.setDeviceMetricsOverride
 *     pins deviceScaleFactor, so a capture is @2x (or @3x) whatever the
 *     display it runs on. Left to itself an offscreen window inherits the
 *     screen's scale factor, which silently means @1x on a non-retina
 *     monitor.
 *
 *   - The page is rendered, not scrolled and photographed. Below the first
 *     screenful, each slice is a Page.captureScreenshot with
 *     captureBeyondViewport and a clip, asking the compositor to draw a window
 *     onto the full page layout. Slices butt together to the pixel, and sticky
 *     elements land in their own place rather than repeating down the strip.
 *     The first screenful is a plain viewport shot instead — see below.
 *
 *   - Slices exist only because of the GPU: a raster surface taller than
 *     MAX_TEXTURE comes back blank (and can take the GPU process with it).
 *     They are cut as tall as that ceiling allows, so a page is typically
 *     two or three of them.
 *
 *   - Nothing is resampled after the fact. The slices are deflated straight
 *     into the PNG on disk (see png.cjs). The old path stitched tiles onto a
 *     renderer canvas, and since a canvas that big is refused outright, long
 *     pages had to have their density dropped to fit — the taller the page,
 *     the softer the image.
 *
 * mode 'viewport' still scrolls and grabs one real screenful: at a given
 * scroll position that is what fixed elements actually look like, and a
 * composited full-page render cannot show that.
 * ------------------------------------------------------------------ */

/* Scrollbars would show up in the shot, and smooth scrolling has to go too: a
 * page with `scroll-behavior: smooth` animates its way to every position we ask
 * for, and the trip from the bottom back to the top takes long enough that the
 * capture caught ship.studio still 773px down — so the top of the strip showed
 * content from the middle of the page. */
const PREPARE_PAGE = `(() => {
  const style = document.createElement('style')
  style.textContent =
    '::-webkit-scrollbar { width: 0 !important; height: 0 !important; display: none !important }' +
    'html, body { scroll-behavior: auto !important }'
  document.documentElement.appendChild(style)
  return 1
})()`

/* Jumping, never gliding, and only reporting done once the page agrees it is
 * there — a scroll can be refused outright or intercepted by a scrolling
 * library, and capturing at the wrong offset is silent and ruinous. */
const SCROLL_TO = (y) => `(() => {
  try { window.scrollTo({ top: ${y}, left: 0, behavior: 'instant' }) }
  catch (_) { window.scrollTo(0, ${y}) }
  return Math.round(window.scrollY)
})()`

/* Only `fixed`, never `sticky`: a sticky element resolves against scroll 0 and
 * lands in its own place, but a fixed one is pinned to whatever viewport it is
 * rendered into — and a slice's viewport is the slice. A bottom-anchored bar
 * would otherwise float in the middle of the strip. `visibility` rather than
 * `display` so nothing reflows between slices. */
const HIDE_FIXED = `(() => {
  let n = 0
  const all = document.body ? document.body.querySelectorAll('*') : []
  const limit = Math.min(all.length, 6000)
  for (let i = 0; i < limit; i++) {
    const el = all[i]
    if (getComputedStyle(el).position === 'fixed') {
      el.style.visibility = 'hidden'
      n++
    }
  }
  return n
})()`

const MEASURE = `({
  width: Math.max(document.documentElement.scrollWidth, window.innerWidth),
  height: Math.max(document.body ? document.body.scrollHeight : 0,
                   document.documentElement.scrollHeight, window.innerHeight),
  viewport: window.innerHeight,
  dpr: window.devicePixelRatio,
  scroll: window.scrollY
})`

/* Anything taller than this in device pixels comes back blank. */
const MAX_TEXTURE = 16384
/* Keep one decoded slice to about this much RAM while it is being written. */
const SLICE_BUDGET = 96e6
/* A runaway page (infinite scroll) has to stop somewhere. Generous because
 * length no longer costs any sharpness — it only costs file size — and the
 * toast says when a shot was cut short. */
const MAX_PAGE_CSS = 60000
const CAPTURE_TIMEOUT = 180000
const SHOT_TIMEOUT = 45000

const pause = (ms) => new Promise((r) => setTimeout(r, ms))

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')

/* The info strip is drawn by the page itself, at the capture's own density, so
 * it is real text rather than a bitmap scaled to fit. It is captured as its own
 * slice and taken back out before the page is captured, so it cannot disturb
 * the layout it is describing. */
function bannerScript (head) {
  const line = 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis'
  const html =
    `<div style="all:initial;display:flex;align-items:baseline;gap:12px;font-family:inherit">` +
      `<span style="font:600 21px/1.35 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#fff;${line}">${esc(head.name)}</span>` +
      `<span style="font:15px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace;color:#8a919c;flex:0 0 auto">${esc(head.size)}</span>` +
      `<span style="flex:1 1 auto"></span>` +
      `<span style="font:13px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace;color:#5d646e;flex:0 0 auto">${esc(head.when)}</span>` +
    `</div>` +
    `<div style="font:14px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;color:#4c8dff;${line}">${esc(head.url)}</div>` +
    `<div style="font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:#8a919c;${line}">${esc(head.meta)}</div>` +
    (head.inspect ? inspectBlock(head.inspect) : '')

  return `(() => {
    const old = document.getElementById('__previewer_banner')
    if (old) old.remove()
    if (!document.body) return 0
    const el = document.createElement('div')
    el.id = '__previewer_banner'
    /* all:initial walls the strip off from the page's own styles; the rest
     * keeps it a full-width block even when body is a flex or grid box. */
    el.setAttribute('style', [
      'all: initial',
      'display: block',
      'position: relative',
      'z-index: 2147483647',
      'box-sizing: border-box',
      'width: 100%',
      'flex: 0 0 auto',
      'grid-column: 1 / -1',
      'margin: 0',
      'padding: 18px 22px 20px',
      'background: #0b0c0e',
      'border-bottom: 2px solid #4c8dff',
      'font-family: ui-monospace, SFMono-Regular, Menlo, monospace',
      'text-align: left',
      'direction: ltr'
    ].join(';') + ';')
    el.innerHTML = ${JSON.stringify(html)}
    document.body.insertBefore(el, document.body.firstChild)
    return Math.ceil(el.getBoundingClientRect().height)
  })()`
}

/* Inspect mode in a capture.
 *
 * The shot runs on a page that was loaded a moment ago and knows nothing
 * about what was selected on screen, so the whole of inspect.js is injected
 * and asked to redraw the overlay from the selector paths the renderer sent.
 * Same file, same code, same drawing as the live frame — see the notes at the
 * top of it.
 *
 * It can legitimately come up empty: a page that renders itself differently on
 * every load may not have that element at that path any more. Then the shot is
 * taken without the highlight and the toast says so, which beats losing it. */
const INSPECT_SOURCE = fs.readFileSync(path.join(__dirname, 'inspect.js'), 'utf8')

async function drawInspect (wc, ins) {
  /* `locked: true` siempre, aunque en vivo la pareja no estuviera fijada: el
   * trazo discontinuo del segundo elemento significa «aquí está el ratón», y
   * en una imagen no hay ratón. Lo que hay es una medida, y se dibuja como
   * tal. */
  const spec = JSON.stringify({
    select: ins.path, hover: ins.hoverPath || null, k: 1, locked: true
  })
  try {
    return !!await wc.executeJavaScript(
      INSPECT_SOURCE + ';(PreviewerInspect.overlay(' + spec + ') || {}).ok')
  } catch (_) {
    return false
  }
}

/* The strip is inserted at the top of the body, which shifts the page under a
 * fixed overlay: the highlight would land on top of the strip and end up in
 * the middle of it. It has already been photographed by this point. */
const HIDE_INSPECT = `(() => {
  try { PreviewerInspect.hide() } catch (_) {}
  return 1
})()`

/* The values, laid out as columns so a phone-width strip stays readable. The
 * same sections the floating panel shows, computed once in the renderer. */
function inspectBlock (ins) {
  const cols = (ins.sections || []).map((sec) => {
    const rows = sec.rows.map((row) => {
      const swatch = row.swatch
        ? `<span style="display:inline-block;width:11px;height:11px;border-radius:2px;` +
          `background:${esc(row.swatch)};box-shadow:inset 0 0 0 1px #ffffff66;margin-right:6px"></span>`
        : ''
      /* Sin dibujo y sin dos líneas: esta franja es la de repuesto y va a lo
       * ancho, así que la variable se cuelga detrás del valor y ya. */
      const token = row.token
        ? `<span style="color:${row.token.warn ? '#d9a469' : '#93a9c9'};padding-left:7px">` +
          `${esc(row.token.label)}</span>`
        : ''
      return `<div style="display:flex;gap:8px;align-items:baseline;padding:1px 0">` +
        `<span style="color:#5d646e;flex:0 0 96px">${esc(row.k)}</span>` +
        `<span style="color:#e6e8ec;flex:1 1 auto;word-break:break-word">${swatch}${esc(row.v)}${token}</span>` +
        `</div>`
    }).join('')
    return `<div style="break-inside:avoid;padding-bottom:16px">` +
      `<div style="color:#8a919c;letter-spacing:.06em;padding-bottom:3px">` +
      `${esc(sec.title.toUpperCase())}</div>${rows}</div>`
  }).join('')

  const dist = ins.dist
    ? `<div style="color:#ff7bff;padding-top:2px">${esc(ins.dist)} ` +
      `<span style="color:#8a919c">hasta ${esc(ins.hoverLabel || 'el otro elemento')}</span></div>`
    : ''

  /* Esta franja sólo sale cuando la columna no se pudo dibujar. La nota se
   * arrastra hasta aquí para que un fallo de la columna no se lleve por
   * delante lo único que la captura no puede volver a deducir. */
  const note = ins.note
    ? `<div style="background:#ffffff12;border-left:3px solid #4c8dff;padding:8px 11px;` +
      `margin-bottom:12px;color:#fff;font:15px/1.45 -apple-system,BlinkMacSystemFont,` +
      `'Segoe UI',sans-serif;word-break:break-word;white-space:pre-wrap">` +
      `${esc(ins.note)}</div>`
    : ''

  return `<div style="margin-top:14px;padding-top:12px;border-top:1px solid #24282e;` +
      `font:15px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace">` +
      note +
      `<div style="color:#4c8dff;font-weight:600;padding-bottom:2px">${esc(ins.label)}</div>` +
      dist +
      `<div style="column-width:250px;column-gap:24px;margin-top:8px">${cols}</div>` +
    `</div>`
}

/* La columna de datos de una captura en modo inspección.
 *
 * Se dibuja en su propia ventana, a la misma densidad que la página, y se pega
 * al lado derecho de la imagen (ver png.joinSide). Antes esto era una franja a
 * lo ancho encima de la captura, y en cuanto un elemento traía diez filas de
 * propiedades la franja medía casi tanto como el viewport que estaba
 * describiendo: en columna el texto se apila donde hay sitio de sobra —a lo
 * alto— y se lee de arriba abajo de una pasada.
 *
 * Lleva dentro la cabecera (dispositivo, URL, fecha), así que en este modo la
 * franja de arriba no se dibuja: sería la misma información dos veces. */
const COLUMN_CSS_WIDTH = 380

/* El mismo diagrama de caja que pinta el panel, con la misma decisión detrás
 * —la toma `boxModel` en inspect.js— y el dibujo rehecho aquí porque esta
 * columna se pinta en su propia ventana y no comparte la hoja de estilos.
 *
 * En una captura vale incluso más que en vivo: es la imagen que acaba en Slack
 * y quien la mira no tiene el elemento delante para volver a medirlo. */
function diagramHtml (row) {
  const d = row.diagram
  const SIDES = ['t', 'r', 'b', 'l']
  let inner = `<div class="bm-c">${esc(d.w + ' × ' + d.h)}</div>`
  for (const ring of d.rings.slice().reverse()) {
    const values = d[ring].map((n, i) =>
      `<span class="bm-v bm-${SIDES[i]}${n === 0 ? ' zero' : ''}">${esc(String(n))}</span>`
    ).join('')
    inner = `<div class="bm-ring bm-${ring}">` +
      `<span class="bm-n">${esc(ring)}</span>${values}${inner}</div>`
  }
  const foot = row.token
    ? `<div class="bm-foot"><span>padding</span>${tokenHtml(row.token)}</div>`
    : ''
  return `<div class="bm">${inner}${foot}</div>`
}

/* La variable, en la línea de debajo del valor. Aquí importa más que en el
 * panel: la captura es lo que se manda, y quien la abre no tiene la página
 * delante para ir a mirar de dónde salía ese color. */
function tokenHtml (token) {
  if (!token) return ''
  return `<span class="var${token.warn ? ' loose' : ''}">${esc(token.label)}</span>`
}

function columnHtml (head, ins) {
  const mono = 'ui-monospace,SFMono-Regular,Menlo,monospace'
  const sans = "-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif"

  const sections = (ins.sections || []).map((sec) => {
    const rows = sec.rows.map((row) => {
      if (row.diagram) return diagramHtml(row)
      const swatch = row.swatch
        ? `<span class="sw" style="background:${esc(row.swatch)}"></span>`
        : ''
      const tag = row.tag
        ? `<span class="tag${row.bad ? ' bad' : ''}">${esc(row.tag)}</span>`
        : ''
      return `<div class="row${row.accent ? ' is-style' : ''}">` +
        `<span class="k">${esc(row.k)}</span>` +
        `<span class="v"><span class="vt">${swatch}${esc(row.v)}</span>` +
        `${tag}${tokenHtml(row.token)}</span></div>`
    }).join('')
    return `<div class="sec"><div class="t">${esc(sec.title.toUpperCase())}</div>${rows}</div>`
  }).join('')

  const dist = ins.dist
    ? `<div class="dist">${esc(ins.dist)}` +
      `<span class="to">hasta ${esc(ins.hoverLabel || 'el otro elemento')}</span>` +
      (ins.why ? `<span class="why">${esc(ins.why)}</span>` : '') +
      `</div>`
    : ''

  /* La nota va arriba y en sans, no en mono: es lo único de la columna escrito
   * por una persona para otra, y lo primero que hay que leer. El selector y el
   * CSS son el material de apoyo de lo que dice aquí. */
  const note = ins.note
    ? `<div class="note">${esc(ins.note)}</div>`
    : ''

  return `<!doctype html><html><head><meta charset="utf-8"><style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{width:${COLUMN_CSS_WIDTH}px;background:#0b0c0e;color:#e6e8ec;
      padding:20px 20px 26px;font:15px/1.5 ${mono};-webkit-font-smoothing:antialiased}
    .name{font:600 20px/1.3 ${sans};color:#fff;word-break:break-word}
    .size{font:14px/1.4 ${mono};color:#8a919c;padding-top:2px}
    .url{font:13px/1.5 ${mono};color:#4c8dff;padding-top:8px;word-break:break-all}
    .meta{font:12px/1.5 ${mono};color:#5d646e;padding-top:4px}
    hr{border:0;border-top:1px solid #24282e;margin:16px 0}
    .note{background:#ffffff12;border-left:3px solid #4c8dff;border-radius:0 5px 5px 0;
      padding:10px 12px;margin-bottom:18px;font:15px/1.45 ${sans};color:#fff;
      word-break:break-word;white-space:pre-wrap}
    .sel{color:#4c8dff;font-weight:600;word-break:break-all}
    .dist{color:#ff7bff;padding-top:6px}
    .dist .to{color:#8a919c;display:block;font-size:13px;word-break:break-all}
    .dist .why{color:#e6e8ec;display:block;font-size:13px;padding-top:3px;word-break:break-word}
    .sec{padding-top:24px}
    .t{color:#8a919c;font-size:12px;letter-spacing:.08em;padding-bottom:4px}
    .row{display:flex;gap:10px;align-items:baseline;padding:1px 0}
    .k{color:#5d646e;flex:0 0 104px;font-size:14px}
    .v{color:#e6e8ec;flex:1 1 auto;min-width:0;font-size:14px;
      display:flex;align-items:baseline;flex-wrap:wrap;gap:5px}
    .vt{flex:0 1 auto;min-width:0;word-break:break-word}
    .row.is-style .vt{color:#a9c9ff}
    .var{flex:0 0 100%;font-size:12px;line-height:1.4;color:#93a9c9;word-break:break-all}
    .var.loose{color:#d9a469}
    .bm-foot{display:flex;align-items:baseline;gap:7px;padding:7px 2px 0}
    .bm-foot>span:first-child{flex:none;font-size:12px;color:#5d646e}
    .bm-foot .var{flex:1 1 auto}
    .sw{display:inline-block;width:11px;height:11px;border-radius:2px;margin-right:6px;
      box-shadow:inset 0 0 0 1px #ffffff66;vertical-align:baseline}
    .tag{margin-left:6px;padding:1px 5px;border-radius:3px;background:#ffffff1f;
      color:#8a919c;font-size:12px}
    .tag.bad{background:#ff5f5633;color:#ff8f88}
    .bm{padding:8px 0 4px}
    .bm-ring{position:relative;padding:24px 26px;border-radius:6px}
    .bm-margin{background:#7a552e2b;box-shadow:inset 0 0 0 1px #c9924e54}
    .bm-border{background:#ffffff0a;box-shadow:inset 0 0 0 1px #ffffff1f}
    .bm-padding{background:#3f6b452b;box-shadow:inset 0 0 0 1px #6fb07a54}
    .bm-n{position:absolute;top:4px;left:7px;font-size:11px;letter-spacing:.04em}
    .bm-margin>.bm-n{color:#d9a469}
    .bm-border>.bm-n{color:#8a919c}
    .bm-padding>.bm-n{color:#8cc596}
    .bm-c{padding:9px 10px;border-radius:5px;background:#1e3865;
      box-shadow:inset 0 0 0 1px #4c8dff5c;color:#a9c9ff;font-size:13px;
      text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .bm-v{position:absolute;font-size:12px;line-height:1;color:#e6e8ec}
    .bm-v.zero{color:#5d646e}
    .bm-t{top:5px;left:50%;transform:translateX(-50%)}
    .bm-b{bottom:5px;left:50%;transform:translateX(-50%)}
    .bm-l{left:5px;top:50%;transform:translateY(-50%)}
    .bm-r{right:5px;top:50%;transform:translateY(-50%)}
  </style></head><body>
    <div class="name">${esc(head.name)}</div>
    <div class="size">${esc(head.size)}</div>
    <div class="url">${esc(head.url)}</div>
    <div class="meta">${esc(head.meta)}</div>
    <div class="meta">${esc(head.when)}</div>
    <hr>
    ${note}
    <div class="sel">${esc(ins.label)}</div>
    ${dist}
    ${sections}
  </body></html>`
}

/* Devuelve el PNG de la columna, o null: una captura sin columna sigue siendo
 * una captura útil, y con el resalte ya dibujado encima. */
function metaLine (spec, info, pageHeight, landed, density) {
  return [
    spec.mode === 'viewport'
      ? `viewport en scroll ${landed}px`
      : `página ${info.width}×${pageHeight}`,
    `@${density}x`
  ].concat((spec.header && spec.header.variants) || []).join('  ·  ')
}

async function shootColumn (head, ins, cssHeight, density) {
  const win = new BrowserWindow({
    show: false,
    useContentSize: true,
    width: COLUMN_CSS_WIDTH,
    height: Math.max(200, Math.round(cssHeight)),
    webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false }
  })
  const wc = win.webContents
  let attached = false
  try {
    await wc.loadURL('data:text/html;charset=utf-8,' +
      encodeURIComponent(columnHtml(head, ins)))
    attach(wc)
    attached = true
    await wc.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
      width: COLUMN_CSS_WIDTH, height: Math.max(200, Math.round(cssHeight)),
      deviceScaleFactor: density, mobile: false
    })
    await pause(150)
    const content = Number(await wc.executeJavaScript(
      'Math.ceil(document.body.getBoundingClientRect().height)')) || 0
    // Si los datos no caben en el alto del viewport, la imagen crece y
    // joinSide rellena el lado de la página; al revés, sobra fondo y ya está.
    return await shootClip(wc, {
      y: 0,
      width: COLUMN_CSS_WIDTH,
      height: Math.max(Math.round(cssHeight), content)
    })
  } catch (_) {
    return null
  } finally {
    if (attached) {
      try { await wc.debugger.sendCommand('Emulation.clearDeviceMetricsOverride') } catch (_) {}
      try { wc.debugger.detach() } catch (_) {}
    }
    if (!win.isDestroyed()) win.destroy()
  }
}

const REMOVE_BANNER = `(() => {
  const el = document.getElementById('__previewer_banner')
  if (el) el.remove()
  return 1
})()`

async function shoot (wc, params) {
  const res = await Promise.race([
    wc.debugger.sendCommand('Page.captureScreenshot', Object.assign({ format: 'png' }, params)),
    new Promise((_, reject) => setTimeout(
      () => reject(new Error('un tramo tardó demasiado en renderizarse')), SHOT_TIMEOUT))
  ])
  const buf = Buffer.from(res.data, 'base64')
  if (!buf.length) throw new Error('un tramo salió vacío')
  return buf
}

/* One clip out of the full-page render, at the pinned density. */
function shootClip (wc, clip) {
  return shoot(wc, {
    captureBeyondViewport: true,
    clip: { x: 0, y: clip.y, width: clip.width, height: clip.height, scale: 1 }
  })
}

/* The viewport exactly as it stands, fixed elements where they really are.
 * Deliberately not webContents.capturePage(): that reads back the offscreen
 * window's own framebuffer, which is sized by the display's scale factor and
 * ignores the emulated one, so it silently caps the shot at the monitor's
 * density. */
function shootViewport (wc) {
  return shoot(wc, {})
}

/* Walk the page so lazy images and reveal-on-scroll effects have fired before
 * anything is captured, then come back to the top. */
async function primePage (wc, info, upTo) {
  const stride = Math.max(200, Math.round(info.viewport * 0.85))
  for (let y = 0; y < upTo; y += stride) {
    await wc.executeJavaScript(SCROLL_TO(Math.min(y, upTo)))
    await pause(70)
  }
  await scrollToY(wc, upTo)
}

/* Asks, then checks, then waits — up to a point. A page can clamp the offset
 * (the target is past the end) or animate to it in spite of being told not to,
 * and both look the same from here: scrollY is not where it was asked to be. */
async function scrollToY (wc, y) {
  let at = Number(await wc.executeJavaScript(SCROLL_TO(y))) || 0
  for (let i = 0; i < 12 && Math.abs(at - y) > 2; i++) {
    await pause(150)
    const next = Number(await wc.executeJavaScript(SCROLL_TO(y))) || 0
    // Clamped rather than gliding: it has stopped somewhere and will not move.
    if (Math.abs(next - at) <= 1) return next
    at = next
  }
  return at
}

/* Wait until the page stops moving, rather than guessing how long it needs.
 *
 * Chrome that reacts to scrolling — a header that hides on the way down and
 * slides back in on the way up — can still be animating long after the scroll
 * itself has stopped. A fixed pause caught ship.studio's navbar mid-fade and it
 * came out of the shot entirely; it wanted about two seconds. Two identical
 * frames in a row is a much better signal than any single number, and on a page
 * that is already still it costs two thumbnails.
 *
 * The probe is a heavily downscaled shot of the viewport, and deliberately
 * without captureBeyondViewport: that one resizes the viewport to render, which
 * on an animated page is itself enough to set things moving again. */
const SETTLE_TRIES = 14
const SETTLE_GAP = 200

async function settle (wc, width, height) {
  let previous = null
  for (let i = 0; i < SETTLE_TRIES; i++) {
    let frame
    try {
      frame = await shoot(wc, { clip: { x: 0, y: 0, width, height, scale: 0.15 } })
    } catch (_) {
      await pause(600)
      return false
    }
    if (previous && frame.equals(previous)) return true
    previous = frame
    await pause(SETTLE_GAP)
  }
  return false
}

async function capturePanel (spec) {
  const { url, width, height, zoom, mode, scrollTo, fileName } = spec
  if (!url || /^about:/.test(url)) return { ok: false, reason: 'el panel no tiene una URL cargada' }

  const density = Math.min(3, Math.max(1, Number(spec.density) || 2))
  const w = Math.max(200, Math.round(width))
  const h = Math.max(200, Math.round(height))

  const shot = new BrowserWindow({
    show: false,
    useContentSize: true,
    width: w,
    height: h,
    webPreferences: {
      partition: 'persist:previewer',
      offscreen: true,
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  const wc = shot.webContents
  let attached = false

  try {
    // The page has to be loaded before the debugger is usable: attaching and
    // emulating on a blank webContents hangs.
    await wc.loadURL(url)
    try {
      await applyEmulation(wc, spec)
      // prefers-color-scheme re-evaluates live, but a locale override only
      // takes hold on a fresh load.
      if (spec.locale && spec.locale !== 'auto') {
        await wc.reload()
        await pause(500)
      }
    } catch (_) { /* capture without variants rather than not at all */ }

    attach(wc)
    attached = true

    // Always set it, 1 included: Chromium remembers zoom per host across a
    // session, so capturing a panel at 125% would otherwise leave every later
    // capture of that host zoomed and quietly narrower.
    wc.setZoomFactor(zoom || 1)
    await pause(250)

    // Pin the density. Width and height stay the panel's, so only the scale
    // factor changes and the page lays out exactly as it does on screen.
    await wc.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
      width: w, height: h, deviceScaleFactor: density, mobile: false
    })
    await pause(900)
    await wc.executeJavaScript(PREPARE_PAGE)

    const before = await wc.executeJavaScript(MEASURE)
    const target = mode === 'viewport'
      ? Math.max(0, Math.round(scrollTo || 0))
      : before.height
    await primePage(wc, before, target)

    const info = await wc.executeJavaScript(MEASURE)
    const pageHeight = Math.min(MAX_PAGE_CSS, Math.max(before.height, info.height))
    const truncated = Math.max(before.height, info.height) > pageHeight

    if (mode !== 'viewport') {
      // Sticky elements are painted relative to the scroll offset, so the whole
      // page render has to start from a known one — and has to have got there.
      await scrollToY(wc, 0)
    }
    await settle(wc, info.width, Math.min(info.viewport, pageHeight))

    let inspected = null
    if (spec.inspect && spec.inspect.path && mode === 'viewport') {
      inspected = await drawInspect(wc, spec.inspect)
    }

    /* The page is captured first and the strip second, so the strip can be cut
     * to the width the page actually came out at — a clip is measured in layout
     * CSS pixels, and with page zoom or a horizontally overflowing page that is
     * not the same as the window's own width. Stacking needs them equal. */
    const page = []
    let landed = 0

    if (mode === 'viewport') {
      page.push(await shootViewport(wc))
      landed = Math.round(Number(await wc.executeJavaScript('window.scrollY')) || 0)
    } else {
      /* The top slice is exactly one viewport, taken as a plain viewport shot.
       * A clip would cover the same ground, but rendering one resizes the
       * viewport, and on a page that animates on scroll that resize re-runs the
       * reveal animations and the hero comes back empty. A plain shot cannot do
       * that, and it puts the fixed chrome — header, floating bar, cookie notice
       * — exactly where it sits on load, by definition.
       *
       * It is only usable when its geometry lines up with the clips it will be
       * stacked on: a plain shot is as wide as the window, a clip as wide as the
       * layout, and page zoom or a horizontally overflowing page pulls those
       * apart. Rather than predicting that, take it and check. */
      const viewportCss = Math.max(1, Math.min(pageHeight, info.viewport))
      const plain = await shootViewport(wc)
      if (png.readHeader(plain).width === Math.round(info.width * density)) {
        page.push(plain)
      } else {
        page.push(await shootClip(wc, { y: 0, width: info.width, height: viewportCss }))
      }

      if (pageHeight > viewportCss) {
        await wc.executeJavaScript(HIDE_FIXED)
        await settle(wc, info.width, viewportCss)
        // Slice height: the GPU ceiling, and small enough that one decoded slice
        // stays inside the memory budget.
        const maxRows = Math.min(MAX_TEXTURE, Math.floor(SLICE_BUDGET / (info.width * density * 4)))
        const sliceCss = Math.max(200, Math.floor(maxRows / density))
        for (let y = viewportCss; y < pageHeight; y += sliceCss) {
          page.push(await shootClip(wc, {
            y,
            width: info.width,
            height: Math.min(sliceCss, pageHeight - y)
          }))
        }
      }
    }

    /* La columna se dibuja aparte y con los datos que vinieron en el spec, así
     * que no toca la página ni depende de que el resalte se haya encontrado. */
    let column = null
    if (spec.inspect && spec.inspect.path && mode === 'viewport' && spec.header) {
      column = await shootColumn(
        Object.assign({}, spec.header, { meta: metaLine(spec, info, pageHeight, landed, density) }),
        spec.inspect,
        Math.max(1, Math.min(pageHeight, info.viewport)),
        density)
    }

    const slices = []
    if (spec.header && !column) {
      try {
        await wc.executeJavaScript(HIDE_INSPECT)
        const bannerCss = Number(await wc.executeJavaScript(bannerScript(Object.assign({}, spec.header, {
          inspect: spec.inspect && spec.inspect.path ? spec.inspect : null,
          meta: metaLine(spec, info, pageHeight, landed, density)
        })))) || 0
        const pageWidth = png.readHeader(page[0]).width
        if (bannerCss > 0) {
          const strip = await shootClip(wc, {
            y: 0,
            width: Math.round(pageWidth / density),
            height: bannerCss
          })
          // Stacking needs an exact match, and a rounding disagreement here is
          // not worth throwing the capture away over.
          if (png.readHeader(strip).width === pageWidth) slices.push(strip)
        }
        await wc.executeJavaScript(REMOVE_BANNER)
      } catch (_) { /* the strip is not worth losing the shot over */ }
    }
    slices.push(...page)

    const file = column
      // #0b0c0e es el fondo de la columna: si la página es más corta que los
      // datos, lo que se rellena por debajo se lee como la columna siguiendo.
      ? await save(fileName, density,
          (out) => png.joinSide(page[0], column, out, density, [0x0b, 0x0c, 0x0e, 0xff]))
      : await save(fileName, density, (out) => png.stackVertical(slices, out, density))

    return Object.assign({
      ok: true,
      mode: mode === 'viewport' ? 'viewport' : 'full',
      density,
      slices: page.length,
      scrolledTo: landed,
      inspected,
      column: !!column,
      truncated: mode === 'viewport' ? false : truncated
    }, file)
  } catch (err) {
    return { ok: false, reason: String((err && err.message) || err) }
  } finally {
    // Leaving the override or the debugger session behind on a window that is
    // about to be destroyed wedges the next capture's renderer.
    if (attached) {
      try { await wc.debugger.sendCommand('Emulation.clearDeviceMetricsOverride') } catch (_) {}
      try { wc.debugger.detach() } catch (_) {}
    }
    if (!shot.isDestroyed()) shot.destroy()
  }
}

/* Why these come out as JPEG and not PNG.
 *
 * Quick Look — the space-bar preview, which is how anyone actually looks at a
 * file on a Mac — builds its preview on a fixed pixel budget. A full-page shot
 * is enormous (2560×18718 on a laptop preset is not unusual), so it gets scaled
 * down hard to fit that budget, and with a PNG there is no cheap way to do that:
 * the whole thing has to be decoded first, so Quick Look gives up and shows a
 * coarse proxy. The degradation is gradual, worsening as the page gets longer,
 * which is what makes it so easy to misread as "the capture came out blurry".
 * It did not — Preview opens the same file sharp.
 *
 * JPEG has scaled decoding built into the codec, so the same enormous image
 * previews correctly. Measured on a 48-megapixel shot: JPEG at quality 95 is
 * 3.3MB against the PNG's 3.9MB, so it is lighter as well, which also keeps
 * Slack previewing it inline instead of demoting it to an attachment.
 *
 * These are QA shots — read the spacing, spot what broke, move on — so lossless
 * buys nothing here and costs the preview. One format for every capture, no
 * threshold: the short ones are cheap either way.
 *
 * The slices are still stitched losslessly into a PNG first. Asking Chromium for
 * JPEG slices instead would mean decoding and re-encoding each one, i.e. lossy
 * twice over, to save a temporary file. */
const JPEG_QUALITY = 95

/* sips ships with macOS and does the conversion out of process, so the ~190MB
 * of decoded bitmap never lands in this app's heap. ~0.2s for 48 megapixels. */
function toJpeg (from, to) {
  return new Promise((resolve) => {
    execFile(
      '/usr/bin/sips',
      ['-s', 'format', 'jpeg', '-s', 'formatOptions', String(JPEG_QUALITY), from, '--out', to],
      // 0.2s is the real cost at 48 megapixels and the ceiling here is nowhere
      // near 30s even for the longest page we allow; this is only so a wedged
      // sips falls back to the PNG well inside CAPTURE_TIMEOUT.
      { timeout: 30000 },
      (err) => {
        if (err) return resolve(false)
        // A sips that exits 0 having written nothing usable would otherwise cost
        // us the PNG we are about to delete.
        try { resolve(fs.statSync(to).size > 0) } catch (_) { resolve(false) }
      })
  })
}

/* `compose` recibe la ruta del PNG intermedio y devuelve su tamaño: apilar los
 * tramos en vertical, o pegar la columna de datos al lado. El resto —carpeta,
 * nombre, conversión a JPEG— es igual en los dos casos. */
async function save (fileName, density, compose) {
  const dir = path.join(app.getPath('downloads'), 'previewer')
  fs.mkdirSync(dir, { recursive: true })
  const base = path.join(dir, (fileName || 'previewer').replace(/\.(png|jpe?g)$/i, ''))

  const stitched = base + '.png'
  const size = await compose(stitched)

  let file = stitched
  const jpeg = base + '.jpg'
  if (await toJpeg(stitched, jpeg)) {
    file = jpeg
    // Only once the JPEG is known good: a failed conversion leaves the PNG as
    // the capture, which is still a perfectly good file.
    try { fs.unlinkSync(stitched) } catch (_) {}
  }

  return { file, dir, width: size.width, height: size.height, bytes: fs.statSync(file).size }
}

/* Belt and braces: never let a stuck capture leave the UI waiting. */
ipcMain.handle('capture-panel', async (_e, spec) => {
  let timer = null
  try {
    return await Promise.race([
      capturePanel(spec),
      new Promise((resolve) => {
        timer = setTimeout(
          () => resolve({ ok: false, reason: 'la captura tardó demasiado y se canceló' }),
          CAPTURE_TIMEOUT)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
})

/* The guest cannot read it off disk from inside its sandbox, so it asks for
 * it through the host. Read once, at startup. */
ipcMain.handle('inspect-source', () => INSPECT_SOURCE)

/* Which typeface is actually painting an element's text.
 *
 * `font-family` computes to the stack the page asked for, and on any page
 * built on a modern reset the first entry is a keyword — `ui-sans-serif`,
 * `-apple-system`, `system-ui` — so reporting "the first family that exists"
 * answered with the keyword and not with a typeface. All three mean San
 * Francisco on a Mac, which is the thing anyone actually wants to know.
 *
 * The DOM cannot tell you: there is no API for the font that won. The DevTools
 * protocol can — it is where the "Rendered Fonts" list in the Computed panel
 * comes from — and we already have a debugger session on every guest for the
 * media emulation.
 *
 * Only on a click, never on hover, and a failure is not worth a word to the
 * user: the CSS value is still shown, it just is not as useful. */
/* Chromium devuelve el nombre interno de la cara del sistema —«SF NS»,
 * «.AppleSystemUIFont», «.SFNSDisplay»—, que no es como la llama nadie. */
const APPLE_SYSTEM =
  /^\.?(AppleSystemUIFont|SF ?NS|SF ?UI|SF ?Pro|Helvetica ?Neue ?DeskInterface|Lucida ?Grande)/i

function prettyFont (name) {
  if (!name) return null
  if (APPLE_SYSTEM.test(name)) return 'San Francisco'
  // .SFNS-Regular_wdth_opsz… y demás nombres internos con sufijos.
  return name.replace(/^\./, '').split('_')[0]
}

/* De qué variable sale cada valor.
 *
 * Una hoja de estilos dice `color: var(--color-text)` y para cuando la página
 * está pintada eso ya es un `rgb(26, 26, 26)` y nadie puede saber de dónde
 * venía: el navegador resuelve la variable antes de que el DOM la vea. Es la
 * razón por la que hasta ahora había que abrir el inspector del navegador para
 * comprobar si un color era el token que tocaba.
 *
 * El protocolo de DevTools sí lo sabe —es de donde sale el panel «Styles»— y
 * devuelve las reglas *tal y como se escribieron*, con el `var()` sin resolver,
 * incluyendo la cadena de herencia y las hojas de otro dominio. Ya teníamos la
 * sesión abierta aquí para la fuente, así que es una llamada más en un viaje
 * que ya se hacía.
 *
 * Qué propiedades se miran, y con qué atajos puede haberlas escrito alguien:
 * `padding: var(--space-4)` es un `padding` en la regla y cuatro `padding-*`
 * en el computado. */
const TOKEN_PROPS = {
  color: ['color'],
  'background-color': ['background-color', 'background'],
  'font-family': ['font-family', 'font'],
  'font-size': ['font-size', 'font'],
  'font-weight': ['font-weight', 'font'],
  'line-height': ['line-height', 'font'],
  'letter-spacing': ['letter-spacing'],
  'border-top-left-radius': ['border-radius'],
  'border-top-color': ['border-top-color', 'border-color', 'border-top', 'border'],
  'padding-top': ['padding-top', 'padding'],
  'row-gap': ['row-gap', 'gap'],
  'column-gap': ['column-gap', 'gap']
}

/* Sólo se hereda lo que se hereda: buscar un `padding` en los padres daría el
 * del contenedor, que no es el de este elemento ni tiene nada que ver. */
const INHERITED = new Set([
  'color', 'font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing'
])

/* Los valores que son una huella dactilar y no una casualidad. Ver el aviso
 * «a mano» en readTokens. */
const COLOURS = new Set(['color', 'background-color', 'border-top-color'])

/* Las que componen un estilo de texto. En Figma esto es una sola cosa
 * —`body/xs`, con su tamaño, su peso y su familia dentro— y en CSS no existe
 * tal cosa: lo más parecido es un puñado de variables que comparten raíz,
 * `--…--text-label-md--font-size` y sus hermanas. Es lo que busca typeStyle. */
const TYPE_PROPS = ['font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing']

/* `#1a1a1a` y `rgb(26, 26, 26)` son el mismo color y dos cadenas distintas, y
 * la comparación se hace justo entre esas dos: una variable guarda el texto
 * que se escribió y el computado siempre trae la forma larga. Sin esto, cada
 * token escrito en hexadecimal —o sea, casi todos— quedaría sin detectar. */
function normalise (value) {
  const text = String(value == null ? '' : value).trim().toLowerCase().replace(/\s+/g, ' ')
  const hex = text.match(/^#([0-9a-f]{3,8})$/)
  if (!hex) return text.replace(/,\s*/g, ', ')
  let d = hex[1]
  if (d.length === 3 || d.length === 4) d = d.split('').map((c) => c + c).join('')
  if (d.length !== 6 && d.length !== 8) return text
  const n = (i) => parseInt(d.slice(i * 2, i * 2 + 2), 16)
  if (d.length === 6) return `rgb(${n(0)}, ${n(1)}, ${n(2)})`
  return `rgba(${n(0)}, ${n(1)}, ${n(2)}, ${Math.round((n(3) / 255) * 100) / 100})`
}

/* Todas las variables que aparecen en el valor escrito.
 *
 * Son varias más veces de las que parece, porque casi nadie escribe la
 * propiedad larga: `border: 2px solid var(--color-linea)` lleva la variable
 * dentro de un atajo, y `font: bold var(--tamano)/1.4 var(--familia)` lleva
 * dos, cada una para una propiedad distinta. Cuál manda para la propiedad que
 * estamos mirando lo decide después la comprobación contra el computado. */
function varsIn (value) {
  const out = []
  const re = /var\(\s*(--[\w-]+)/g
  let m
  while ((m = re.exec(String(value || '')))) out.push(m[1])
  return out
}

/* La declaración que gana para una propiedad, de mayor a menor precedencia.
 *
 * Importa el orden y no vale con «la primera que lleve un var()»: si alguien ha
 * escrito el hexadecimal a mano encima de una regla que sí usaba la variable,
 * mirar sólo los `var()` contaría justo lo contrario de lo que pasa. Se busca
 * quién gana y después se mira si ese lleva variable.
 *
 * El protocolo entrega las reglas de menor a mayor precedencia —la specificity
 * ya resuelta por el propio navegador—, así que ganar es ir del final al
 * principio, con lo marcado `!important` por delante de todo lo demás. */
function winner (styles, names) {
  const pick = (important) => {
    for (const style of styles) {
      const found = (style.cssProperties || []).filter((p) =>
        p.text && !p.disabled && names.indexOf(p.name) > -1 && !!p.important === important)
      if (found.length) return found[found.length - 1].value
    }
    return null
  }
  return pick(true) || pick(false)
}

/* Las hojas de un elemento, de mayor a menor precedencia y en un solo array. */
function stack (match) {
  const own = (match.matchedCSSRules || []).map((m) => m.rule.style).reverse()
  return (match.inlineStyle ? [match.inlineStyle] : []).concat(own)
}

/* La raíz de un token, quitándole el nombre de la propiedad que lleva pegado.
 *
 * Los dos órdenes existen y hay que conocer los dos: unos sistemas lo ponen
 * detrás —`--…--text-label-md--font-size`— y otros delante
 * —`--font-size--text-body-xs`—. Buscando sólo el sufijo, los segundos no se
 * detectaban como estilo y salían con la variable repetida en cada fila, que
 * es justo lo que se venía a quitar. */
function stemOf (name, prop) {
  if (name.length > prop.length && name.slice(-prop.length) === prop) {
    const stem = name.slice(0, name.length - prop.length).replace(/-+$/, '')
    if (stem.length > 2) return stem
  }
  const head = '--' + prop
  if (name.indexOf(head) === 0 && name.length > head.length) {
    const stem = '--' + name.slice(head.length).replace(/^-+/, '')
    if (stem.length > 2) return stem
  }
  return null
}

/* La hermana de una raíz para otra propiedad. Cuatro formas posibles: la
 * propiedad delante o detrás, y con uno o dos guiones de separador. Probarlas
 * todas no cuesta nada y ahorra tener que saber de qué sistema viene. */
function sibling (vars, stem, prop) {
  const bare = stem.replace(/^--/, '')
  const names = [
    stem + '--' + prop, stem + '-' + prop,
    '--' + prop + '--' + bare, '--' + prop + '-' + bare
  ]
  for (const name of names) {
    if (vars[name] != null) return name
  }
  return null
}

/* Si dos valores son el mismo, sabiendo cuál es la propiedad.
 *
 * Hace falta por el interlineado: escribirlo sin unidad —`line-height: 1.6`—
 * es lo normal, y entonces el token guarda `1.6` mientras el computado trae
 * `19.2px`. Comparados como cadenas no se parecen en nada, y así se quedaba
 * sin detectar el interlineado de medio sistema de diseño; y con él, la mitad
 * de las veces que un estilo de texto podía reconocerse entero. */
function sameValue (prop, token, painted, fontSize) {
  if (token === painted) return true
  if (prop !== 'line-height' || /[a-z%]/.test(token)) return false
  const ratio = parseFloat(token)
  const px = parseFloat(painted)
  const base = parseFloat(fontSize)
  if (!ratio || !px || !base) return false
  return Math.abs(ratio * base - px) < 0.5
}

/* El estilo de texto aplicado, que es la pregunta de verdad.
 *
 * Enseñar `--…--text-label-md--font-size`, `--…--text-label-md--line-height` y
 * `--…--text-label-md--font-weight` en tres filas seguidas es decir tres veces
 * lo mismo: lo que cambia entre ellas —`font-size`, `line-height`— ya lo dice
 * el nombre de la fila, y lo único que informa, `text-label-md`, queda
 * enterrado y repetido. Si el estilo está puesto, sus piezas están bien por
 * definición y no hay nada que mirar. Así que se dice una vez y arriba.
 *
 * Hacen falta dos propiedades para hablar de estilo: con una sola, la raíz es
 * una coincidencia del nombre y no una prueba de que haya un estilo detrás.
 *
 * Y entonces sí se puede señalar lo que se sale, que sin esta raíz era
 * imposible: si el elemento usa `text-label-md` y el peso va a mano, se puede
 * comparar contra lo que ese estilo dice que debería pesar. */
function typeStyle (out, vars, raw, value) {
  const stems = {}
  for (const prop of TYPE_PROPS) {
    const t = out[prop]
    if (!t || t.loose) continue
    const stem = stemOf(t.name, prop)
    if (stem) (stems[stem] = stems[stem] || []).push(prop)
  }

  let best = null
  for (const stem of Object.keys(stems)) {
    if (stems[stem].length < 2) continue
    if (!best || stems[stem].length > stems[best].length) best = stem
  }
  if (!best) return null

  /* Lo que se sale del estilo, que es lo único que queda por mirar. Sólo de
   * las propiedades para las que el estilo tiene algo que decir: si no existe
   * `--…--text-label-md--letter-spacing`, el estilo no opina del espaciado y
   * no hay nada de lo que salirse. */
  const off = {}
  for (const prop of TYPE_PROPS) {
    const t = out[prop]
    if (t && !t.loose && stemOf(t.name, prop) === best) continue
    const sib = sibling(vars, best, prop)
    if (!sib || value[prop] == null) continue
    off[prop] = {
      name: sib,
      value: raw[sib],
      same: sameValue(prop, vars[sib], value[prop], value['font-size'])
    }
  }

  return {
    stem: best,
    props: stems[best],
    off: Object.keys(off).length ? off : null
  }
}

function readTokens (match, computed) {
  const value = {}
  const vars = {}
  /* El valor sin tocar, para enseñarlo: `normalise` pasa todo a minúsculas
   * para poder comparar, y una familia tipográfica enseñada como «inter» en
   * vez de «Inter» canta. Se compara con uno y se lee el otro. */
  const raw = {}
  for (const p of computed) {
    if (p.name.indexOf('--') !== 0) { value[p.name] = normalise(p.value); continue }
    vars[p.name] = normalise(p.value)
    raw[p.name] = String(p.value || '').trim()
  }
  if (!Object.keys(vars).length) return null

  const own = stack(match)
  /* `inherited[0]` es el padre, y de ahí hacia arriba. */
  const up = (match.inherited || []).map(stack)
  const out = {}

  for (const prop of Object.keys(TOKEN_PROPS)) {
    const painted = value[prop]
    if (painted == null) continue
    const names = TOKEN_PROPS[prop]

    let declared = winner(own, names)
    if (declared == null && INHERITED.has(prop)) {
      for (const level of up) {
        declared = winner(level, names)
        if (declared != null) break
      }
    }

    if (declared == null) continue

    const used = varsIn(declared)
    if (used.length) {
      /* La red de seguridad, y la que además elige entre las varias de un
       * atajo: vale la que resuelve a lo que se está viendo. Si ninguna
       * resuelve a eso, la regla que hemos elegido no es la que manda, y una
       * atribución equivocada manda a alguien a cambiar la línea que no era.
       * Con dos que cuadren tampoco se puede decir cuál: callar las dos veces,
       * que es el mismo criterio que el de las cotas. */
      const fits = used.filter((n) =>
        vars[n] != null && sameValue(prop, vars[n], painted, value['font-size']))
      if (fits.length === 1) out[prop] = { name: fits[0], value: raw[fits[0]] }
      continue
    }

    /* El valor a mano que coincide con un token: el color es el correcto hoy y
     * el día que el token cambie éste no cambiará. Es el fallo que se busca al
     * revisar un sistema de diseño y el único que no se ve mirando la
     * pantalla, porque hoy se ve exactamente igual de bien.
     *
     * Sólo con colores, y la razón es cuánto pesa la coincidencia: un
     * `#001745` es una huella dactilar y encontrarlo en la lista de tokens
     * demuestra algo, mientras que un `500`, un `16px` o un `0` coinciden con
     * *algún* token en cuanto el sistema tiene doscientos. Avisar de esos era
     * señalar una casualidad y hacer creer que alguien había roto un estilo
     * que en realidad no estaba puesto. El caso con contexto —un peso a mano
     * dentro de un elemento que sí usa un estilo— lo cuenta `typeStyle`, que
     * sabe contra qué compararlo. */
    if (!COLOURS.has(prop)) continue
    const same = Object.keys(vars).find((n) => vars[n] === painted)
    if (same) out[prop] = { name: same, value: raw[same], loose: true }
  }
  if (!Object.keys(out).length) return null
  return { props: out, style: typeStyle(out, vars, raw, value) }
}

ipcMain.handle('inspect-details', async (_e, { id, selector }) => {
  const wc = webContents.fromId(id)
  if (!wc || wc.isDestroyed() || !selector) return null
  let enabled = false
  try {
    attach(wc)
    await wc.debugger.sendCommand('DOM.enable')
    await wc.debugger.sendCommand('CSS.enable')
    enabled = true
    const { root } = await wc.debugger.sendCommand('DOM.getDocument', { depth: 0 })
    const found = await wc.debugger.sendCommand('DOM.querySelector', {
      nodeId: root.nodeId, selector
    })
    if (!found || !found.nodeId) return null
    const { fonts } = await wc.debugger.sendCommand('CSS.getPlatformFontsForNode', {
      nodeId: found.nodeId
    })
    // La que ha pintado más glifos, sin contar la de emoji, que aparece en
    // cuanto el texto lleva un solo símbolo.
    const best = (fonts || [])
      .filter((f) => f.familyName && !/emoji/i.test(f.familyName))
      .sort((a, b) => (b.glyphCount || 0) - (a.glyphCount || 0))[0]

    /* Las variables no son motivo para perder la fuente: van en su propio
     * try, y una página sin tokens sencillamente no trae esta parte. */
    let read = null
    try {
      const [match, computed] = await Promise.all([
        wc.debugger.sendCommand('CSS.getMatchedStylesForNode', { nodeId: found.nodeId }),
        wc.debugger.sendCommand('CSS.getComputedStyleForNode', { nodeId: found.nodeId })
      ])
      read = readTokens(match, computed.computedStyle || [])
    } catch (_) {}

    return {
      font: best ? prettyFont(best.familyName) : null,
      tokens: read ? read.props : null,
      style: read ? read.style : null
    }
  } catch (_) {
    return null
  } finally {
    /* Los dominios del protocolo son por sesión, así que apagarlos no molesta
     * a unas DevTools abiertas, y dejar CSS encendido le cuesta a la página
     * seguir la pista de sus hojas de estilo para nada. */
    if (enabled) {
      try { await wc.debugger.sendCommand('CSS.disable') } catch (_) {}
      try { await wc.debugger.sendCommand('DOM.disable') } catch (_) {}
    }
  }
})

ipcMain.handle('reveal', (_e, { file }) => shell.showItemInFolder(file))

/* pathToFileURL, not 'file://' + path: once packaged the bundle can live
 * anywhere, and a single space in the path ("/Applications/Mi Previewer.app")
 * would silently produce an unusable URL and every panel would load with no
 * preload — no scroll sync, no clicks. */
ipcMain.handle('guest-preload-path', () => {
  return pathToFileURL(path.join(__dirname, 'guest', 'guest.cjs')).href
})

/* Exported so the capture path, the column and the token reading can be
 * exercised without the UI. */
module.exports = { capturePanel, columnHtml, readTokens }
