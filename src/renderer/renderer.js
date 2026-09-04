/* Previewer — multi-device canvas.
 * The host owns the canvas transform, the panels and the sync fan-out;
 * each guest page runs guest/guest.js and speaks to us over ipc-message. */

const $ = (sel) => document.querySelector(sel)

const viewport   = $('#viewport')
const canvas     = $('#canvas')
const urlInput   = $('#url-input')
const urlStatus  = $('#url-status')
const popover    = $('#popover')
const shield     = $('#shield')
const panOverlay = $('#pan-overlay')
const marquee    = $('#marquee')
const emptyState = $('#empty-state')
const toastEl    = $('#toast')
const toastMsgEl = $('#toast-msg')
const toastSpinnerEl = $('#toast-spinner')
const toastActionEl  = $('#toast-action')

const MIN_SCALE = 0.1
const MAX_SCALE = 2
const GAP = 48

let guestPreload = null
/* El código del inspector, tal cual, para dárselo al guest: su preload va en
 * sandbox y no puede leerlo del disco. Ver src/inspect.js. */
let inspectSource = null
let uid = 0

const state = {
  url: 'http://localhost:3000',
  canvas: { x: 60, y: 40, scale: 0.55 },
  sync: { scroll: true, click: true, nav: true },
  scrollMode: 'ratio',
  panels: []
}

/* Un set es una foto del canvas: los paneles y la URL en la que se guardaron.
 * { [nombre]: { url: string|null, panels: [...] } } — url null en los sets
 * guardados antes de que el formato incluyera la URL. */
let sets = {}

/* --------------------------------------------------------- persistence */

function save () {
  const plain = {
    url: state.url,
    canvas: state.canvas,
    sync: state.sync,
    scrollMode: state.scrollMode,
    panels: state.panels.map(serialize)
  }
  try { localStorage.setItem('previewer.state', JSON.stringify(plain)) } catch (_) {}
}

function serialize (p) {
  return {
    name: p.name, w: p.w, h: p.h, dpr: p.dpr,
    x: p.x, y: p.y,
    colorScheme: p.colorScheme, locale: p.locale,
    zoom: p.zoom, reducedMotion: p.reducedMotion
  }
}

function saveSets () {
  try { localStorage.setItem('previewer.sets', JSON.stringify(sets)) } catch (_) {}
}

/* La pista de «⇧ + clic para medir» se enseña hasta que se usa una vez, y eso
 * sí se recuerda entre sesiones: enseñar un truco es una conversación que se
 * tiene una vez, no cada vez que se abre la app. */
let distLearned = false
let distTipSeen = false

function learnDistance () {
  if (distLearned) return
  distLearned = true
  try { localStorage.setItem('previewer.distLearned', '1') } catch (_) {}
}

/* Los sets antiguos se guardaban como un array pelado de paneles. */
function normalizeSet (raw) {
  if (Array.isArray(raw)) return { url: null, panels: raw }
  return { url: raw.url || null, panels: raw.panels || [] }
}

function restore () {
  try {
    const raw = localStorage.getItem('previewer.state')
    if (raw) {
      const s = JSON.parse(raw)
      state.url = s.url || state.url
      state.canvas = Object.assign(state.canvas, s.canvas)
      state.sync = Object.assign(state.sync, s.sync)
      state.scrollMode = s.scrollMode || 'ratio'
      state.panels = (s.panels || []).map(hydrate)
    }
    distLearned = localStorage.getItem('previewer.distLearned') === '1'
    distTipSeen = localStorage.getItem('previewer.distTip') === '1'
    const rawSets = JSON.parse(localStorage.getItem('previewer.sets') || '{}')
    sets = {}
    for (const [name, raw] of Object.entries(rawSets)) sets[name] = normalizeSet(raw)
  } catch (_) {}
  if (!state.panels.length) {
    state.panels = window.DEFAULT_SET.map((d) => hydrate(d))
    arrange()
  }
}

function hydrate (d) {
  return {
    id: ++uid,
    name: d.name || `${d.w}×${d.h}`,
    w: d.w, h: d.h, dpr: d.dpr || 2,
    x: d.x || 0, y: d.y || 0,
    colorScheme: d.colorScheme || 'auto',
    locale: d.locale || 'auto',
    zoom: d.zoom || 1,
    reducedMotion: !!d.reducedMotion,
    el: null, webview: null, ready: false, insArmed: false
  }
}

/* Every capture is @2x, whatever the preset says and whatever monitor this is
 * running on: @1x presets describe the device, not how sharp a review
 * screenshot of it should be, and @2x is the native density of the screens
 * these get looked at on. Not a choice the panel gets to make — one less knob
 * to get wrong, and the shot is identical everywhere. */
const CAPTURE_DENSITY = 2

/* -------------------------------------------------------------- canvas */

function applyTransform () {
  const { x, y, scale } = state.canvas
  canvas.style.transform = `translate(${x}px, ${y}px) scale(${scale})`
  canvas.style.setProperty('--k', String(1 / scale))
  for (const p of state.panels) updateDensity(p)
  syncInspectScale()
  viewport.style.backgroundSize = `${24 * scale}px ${24 * scale}px`
  viewport.style.backgroundPosition = `${x}px ${y}px`
  $('#zoom-level').textContent = Math.round(scale * 100) + '%'
}

function zoomAt (nextScale, screenX, screenY) {
  const rect = viewport.getBoundingClientRect()
  const px = screenX - rect.left
  const py = screenY - rect.top
  const { x, y, scale } = state.canvas
  const s = Math.min(MAX_SCALE, Math.max(MIN_SCALE, nextScale))
  state.canvas.x = px - ((px - x) / scale) * s
  state.canvas.y = py - ((py - y) / scale) * s
  state.canvas.scale = s
  applyTransform()
  save()
}

function zoomBy (factor) {
  const rect = viewport.getBoundingClientRect()
  zoomAt(state.canvas.scale * factor, rect.left + rect.width / 2, rect.top + rect.height / 2)
}

function fit () {
  if (!state.panels.length) return
  const minX = Math.min(...state.panels.map((p) => p.x))
  const minY = Math.min(...state.panels.map((p) => p.y))
  const maxX = Math.max(...state.panels.map((p) => p.x + p.w))
  const maxY = Math.max(...state.panels.map((p) => p.y + p.h))
  const rect = viewport.getBoundingClientRect()
  const pad = 48
  const scale = Math.min(
    MAX_SCALE,
    Math.max(MIN_SCALE, Math.min(
      (rect.width - pad * 2) / (maxX - minX),
      (rect.height - pad * 2) / (maxY - minY)
    ))
  )
  state.canvas.scale = scale
  state.canvas.x = pad + (rect.width - pad * 2 - (maxX - minX) * scale) / 2 - minX * scale
  state.canvas.y = pad + (rect.height - pad * 2 - (maxY - minY) * scale) / 2 - minY * scale
  applyTransform()
  save()
}

function arrange () {
  const ordered = [...state.panels].sort((a, b) => a.w - b.w)
  let x = 0
  for (const p of ordered) {
    p.x = x
    p.y = 0
    x += p.w + GAP
  }
}

/* -------------------------------------------------------------- panels */

function panelBadges (p) {
  const out = []
  if (p.colorScheme !== 'auto') out.push(p.colorScheme === 'dark' ? 'dark' : 'light')
  if (p.locale !== 'auto') out.push(p.locale)
  if (p.zoom !== 1) out.push(Math.round(p.zoom * 100) + '%')
  if (p.reducedMotion) out.push('rm')
  return out
}

/* Retícula: el mismo gesto de «apuntar a un elemento» que usan las devtools
 * de cualquier navegador, así que no hay que explicarlo. */
const CROSSHAIR_ICON =
  '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" fill="none" ' +
  'stroke="currentColor" stroke-width="1.5" stroke-linecap="round">' +
  '<path d="M8 1.5v3.2M8 11.3v3.2M1.5 8h3.2M11.3 8h3.2"/>' +
  '<circle cx="8" cy="8" r="2.9"/></svg>'

function buildPanel (p) {
  const el = document.createElement('div')
  el.className = 'panel'
  el.dataset.id = p.id

  const bar = document.createElement('div')
  bar.className = 'panel-bar'
  bar.innerHTML = `
    <span class="panel-name"></span>
    <span class="panel-size"></span>
    <span class="panel-badges"></span>
    <span class="panel-actions">
      <button class="inspect" title="Inspeccionar elementos (CSS)">${CROSSHAIR_ICON}</button>
      <button class="theme" title="Alternar esquema de color">◐</button>
      <button class="more"  title="Opciones del panel">⋯</button>
      <button class="close" title="Quitar panel">✕</button>
    </span>`

  const body = document.createElement('div')
  body.className = 'panel-body'

  const wv = document.createElement('webview')
  wv.setAttribute('src', normalizeUrl(state.url))
  wv.setAttribute('preload', guestPreload)
  wv.setAttribute('partition', 'persist:previewer')
  wv.setAttribute('allowpopups', 'true')

  body.appendChild(wv)

  const grip = document.createElement('div')
  grip.className = 'panel-grip'
  grip.title = 'Redimensionar'

  el.append(bar, body, grip)
  canvas.appendChild(el)

  p.el = el
  p.webview = wv
  p.body = body

  wireWebview(p)
  wirePanelChrome(p)
  layoutPanel(p)
  return el
}

/* The label is counter-scaled, so its usable width in label-local pixels is
 * exactly the frame's on-screen width. Below each threshold it drops a part;
 * at the smallest tier only the ⋯ menu is left, which carries every action. */
const DENSITY_FULL = 210
const DENSITY_COMPACT = 108

function updateDensity (p) {
  if (!p.el) return
  const onScreen = p.w * state.canvas.scale
  const density = onScreen >= DENSITY_FULL ? 'full'
    : onScreen >= DENSITY_COMPACT ? 'compact'
      : 'mini'
  const bar = p.el.querySelector('.panel-bar')
  if (bar.dataset.density !== density) bar.dataset.density = density
}

function layoutPanel (p) {
  p.el.style.transform = `translate(${p.x}px, ${p.y}px)`
  p.el.style.width = p.w + 'px'
  p.body.style.height = p.h + 'px'
  p.webview.style.width = p.w + 'px'
  p.webview.style.height = p.h + 'px'
  p.el.querySelector('.panel-name').textContent = p.name
  p.el.querySelector('.panel-size').textContent = `${p.w}×${p.h}`
  p.el.querySelector('.panel-badges').innerHTML =
    panelBadges(p).map((b) => `<span class="badge">${b}</span>`).join('')
  updateDensity(p)
}

function render () {
  for (const p of state.panels) {
    if (!p.el) buildPanel(p)
    else layoutPanel(p)
  }
  emptyState.hidden = state.panels.length > 0
  paintSelection()
  applyTransform()
}

function addPanel (device) {
  const p = hydrate(device)
  const rightmost = state.panels.reduce(
    (acc, q) => Math.max(acc, q.x + q.w), -GAP)
  p.x = state.panels.length ? rightmost + GAP : 0
  p.y = state.panels.length ? state.panels[0].y : 0
  state.panels.push(p)
  render()
  save()
}

function removePanel (p) {
  const i = state.panels.indexOf(p)
  if (i === -1) return
  state.panels.splice(i, 1)
  if (insState.id === p.id) setInspect(null, false)
  selection.delete(p.id)
  p.el.remove()
  render()
  save()
}

/* ----------------------------------------------------------- selección */

/* Guardamos ids y no paneles: replaceSet rehidrata los objetos y una
 * referencia vieja se quedaría apuntando a un panel que ya no existe. */
const selection = new Set()

function isSelected (p) { return selection.has(p.id) }

function paintSelection () {
  for (const p of state.panels) {
    if (p.el) p.el.classList.toggle('selected', selection.has(p.id))
  }
}

function setSelection (ids) {
  selection.clear()
  for (const id of ids) selection.add(id)
  paintSelection()
}

function clearSelection () {
  if (selection.size) setSelection([])
}

function toggleSelected (p) {
  if (!selection.delete(p.id)) selection.add(p.id)
  paintSelection()
}

function selectedPanels () { return state.panels.filter(isSelected) }

/* Cargar un set reemplaza los paneles y, si el set guardó una URL, navega a
 * ella. Fijamos state.url antes de render() porque buildPanel lee state.url al
 * crear el webview: los paneles nuevos nacen ya en destino, sin recarga extra. */
function replaceSet (set) {
  if (insState.id) setInspect(null, false)
  if (set.url) applyUrl(set.url)
  for (const p of state.panels) p.el && p.el.remove()
  state.panels = set.panels.map(hydrate)
  /* Sin arrange(): el set guarda la posición de cada panel y la respetamos.
   * Para volver a la fila ordenada está «Reordenar en fila» en el menú
   * contextual del lienzo (clic derecho). */
  render()
  fit()
  save()
}

function applyUrl (url) {
  const target = normalizeUrl(url)
  state.url = target
  urlInput.value = target
  urlStatus.className = 'scheme ' + (isLocal(target) ? 'local' : 'remote')
}

function currentSet () {
  return { url: state.url, panels: state.panels.map(serialize) }
}

/* «Landing» ya existe → «Landing 2», y si también, «Landing 3»… */
function uniqueSetName (base) {
  let n = 2
  while (sets[`${base} ${n}`]) n++
  return `${base} ${n}`
}

/* --------------------------------------------------------- webview I/O */

function wireWebview (p) {
  const wv = p.webview

  wv.addEventListener('did-start-loading', () => p.body.classList.add('loading'))
  wv.addEventListener('did-stop-loading',  () => p.body.classList.remove('loading'))

  wv.addEventListener('dom-ready', () => {
    p.ready = true
    applyEmulation(p)
    wv.setZoomFactor(p.zoom)
    p.insArmed = false
    /* Una recarga se lleva por delante los listeners del guest, así que el
     * modo hay que volver a encenderlo — y sin selección, que el elemento de
     * antes ya no es el mismo objeto. */
    if (insState.id === p.id) setInspect(p, true)
  })

  wv.addEventListener('did-fail-load', (e) => {
    if (e.errorCode === -3) return // aborted, usually a redirect
    p.body.classList.remove('loading')
    urlStatus.className = 'scheme error'
    toast(`${p.name}: ${e.errorDescription || 'no se pudo cargar'}`)
  })

  wv.addEventListener('did-navigate', (e) => propagateNav(p, e.url))
  wv.addEventListener('did-navigate-in-page', (e) => {
    if (e.isMainFrame) propagateNav(p, e.url)
  })

  wv.addEventListener('ipc-message', (e) => onGuestMessage(p, e.channel, e.args[0] || {}))
}

function onGuestMessage (p, channel, data) {
  switch (channel) {
    case 'scroll':
      if (!state.sync.scroll || capturing) return
      broadcast(p, 'scroll', {
        mode: state.scrollMode === 'absolute' ? 'absolute' : 'ratio',
        ratio: data.ratio,
        y: data.y
      })
      break

    case 'click':
      if (!state.sync.click) return
      broadcast(p, 'click', data)
      break

    case 'input':
      if (!state.sync.click) return
      broadcast(p, 'input', data)
      break

    case 'wheel-zoom': {
      const rect = viewport.getBoundingClientRect()
      const s = state.canvas.scale
      const screenX = rect.left + state.canvas.x + (p.x + data.clientX) * s
      const screenY = rect.top + state.canvas.y + (p.y + data.clientY) * s
      const speed = (data.ctrlKey && !data.metaKey) ? 0.02 : 0.005
      zoomAt(s * (1 - data.deltaY * speed), screenX, screenY)
      break
    }

    case 'pan-key':
      setPanMode(data.down)
      break

    case 'shortcut':
      handleShortcut(data)
      break

    case 'inspect-pick':
      if (insState.id !== p.id) return
      insState.data = data.data
      insState.path = data.path
      dropInsLock()
      /* La nota abierta describía el elemento anterior: al clicar otro se
       * cierra en vez de heredarse, que es como se cuelan notas que no hablan
       * de lo que sale en la imagen. */
      closeInsNote()
      paintInspector()
      askPlatformFont(p)
      /* El globo al lado del cursor: una vez en la vida, en la primera
       * selección, y nunca más. Lo decide el host porque es quien recuerda
       * —el frame se recarga y olvida—; el frame sólo lo pinta, que es donde
       * está el ratón. */
      if (!distTipSeen && !distLearned) {
        distTipSeen = true
        try { localStorage.setItem('previewer.distTip', '1') } catch (_) {}
        p.webview.send('inspect-tip')
      }
      break

    case 'inspect-hover':
      if (insState.id !== p.id) return
      insState.hoverPath = data.hoverPath
      insState.hoverLabel = data.label
      insState.dist = data.dist
      insState.why = data.why
      insState.locked = !!data.locked
      if (insState.locked) learnDistance()
      /* Sin nada seleccionado el hover sólo resalta dentro del frame: no hay
       * distancia que contar todavía. */
      if (insState.data) paintDistance()
      break

    case 'inspect-broken':
      /* Sólo pasa si la página bloquea de algún modo la evaluación del
       * módulo. Mejor decirlo que dejar un modo que no responde. */
      toast('No se pudo activar la inspección en esta página: ' + data.reason)
      setInspect(p, false)
      break

    case 'inspect-escape':
      /* Escape va por pasos, como en Figma: suelta lo fijado, luego la
       * selección, y a la tercera sale del modo. */
      if (data.hadLock) {
        dropInsLock()
        sendInspect(p, true, 'lock')
        paintDistance()
      } else if (data.hadSelection) {
        dropInsSelection()
        sendInspect(p, true, true)
        paintInspector()
      } else {
        setInspect(p, false)
      }
      break

    case 'page-ready':
      urlStatus.className = 'scheme ' + (isLocal(data.href) ? 'local' : 'remote')
      break
  }
}

function broadcast (from, channel, payload) {
  for (const q of state.panels) {
    if (q === from || !q.ready) continue
    try { q.webview.send(channel, payload) } catch (_) {}
  }
}

let navLock = false

function propagateNav (from, url) {
  urlInput.value = url
  state.url = url
  urlStatus.className = 'scheme ' + (isLocal(url) ? 'local' : 'remote')
  save()
  if (!state.sync.nav || navLock) return
  navLock = true
  for (const q of state.panels) {
    if (q === from) continue
    try {
      if (q.webview.getURL() !== url) q.webview.loadURL(url)
    } catch (_) {}
  }
  setTimeout(() => { navLock = false }, 400)
}

async function applyEmulation (p) {
  try {
    const id = p.webview.getWebContentsId()
    await window.previewer.emulate({
      id,
      colorScheme: p.colorScheme,
      locale: p.locale,
      reducedMotion: p.reducedMotion
    })
  } catch (_) {}
}

/* ------------------------------------------------------------- helpers */

function isLocal (url) {
  return /^(https?:\/\/)?(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0|[^/]*\.local)(:\d+)?/i.test(url)
}

function normalizeUrl (raw) {
  const value = (raw || '').trim()
  if (!value) return 'about:blank'
  if (/^[a-z]+:\/\//i.test(value) || value === 'about:blank') return value
  if (/^localhost|^127\.0\.0\.1|^0\.0\.0\.0|^\[::1\]|^\d+\.\d+\.\d+\.\d+/.test(value)) {
    return 'http://' + value
  }
  if (/^:\d+/.test(value)) return 'http://localhost' + value
  if (/^\d+$/.test(value)) return 'http://localhost:' + value
  return 'https://' + value
}

let toastTimer = null
let toastAction = null

/* opts.spinner mantiene el toast en pantalla con un indicador de progreso
 * (se cierra cuando otra llamada lo sustituye). opts.action añade un botón. */
function toast (msg, opts = {}) {
  toastMsgEl.textContent = msg
  toastSpinnerEl.hidden = !opts.spinner

  toastAction = opts.action || null
  toastActionEl.hidden = !toastAction
  if (toastAction) toastActionEl.textContent = toastAction.label

  toastEl.hidden = false
  clearTimeout(toastTimer)
  if (!opts.spinner) {
    toastTimer = setTimeout(() => { toastEl.hidden = true }, opts.action ? 6000 : 2600)
  }
}

function loadAll (url) {
  applyUrl(url)
  navLock = true
  for (const p of state.panels) {
    try { p.webview.loadURL(state.url) } catch (_) {}
  }
  setTimeout(() => { navLock = false }, 500)
  save()
}

function reloadAll () {
  for (const p of state.panels) {
    try { p.webview.reload() } catch (_) {}
  }
}

/* ---------------------------------------------------------- screenshot */

let capturing = false

function stamp (date) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
         ` ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function shotName (p, date, mode) {
  const slug = p.name.toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'panel'
  const t = stamp(date).replace(/[: ]/g, '-')
  // No extension: the main process picks it, and falls back to .png if the
  // conversion to JPEG does not happen.
  return `${slug}_${p.w}x${p.h}${mode === 'viewport' ? '_viewport' : ''}_${t}`
}

/* The info strip and the stitching both live in the main process now: it draws
 * the strip inside the page being captured and deflates the slices straight to
 * disk, so the image is never rebuilt on a canvas and never has to be shrunk to
 * fit one. See the capture notes in main.cjs, including why the file that comes
 * back is a JPEG. */

function variants (p) {
  const out = []
  if (p.colorScheme !== 'auto') out.push(p.colorScheme)
  if (p.locale !== 'auto') out.push(p.locale)
  if (p.zoom !== 1) out.push(`zoom ${Math.round(p.zoom * 100)}%`)
  if (p.reducedMotion) out.push('reduced-motion')
  return out
}

async function screenshotPanel (p, mode = 'full', withInspect = false, note = '') {
  if (capturing) return
  if (!p.ready) { toast('El panel aún está cargando'); return }
  capturing = true
  toast((mode === 'viewport' ? `Capturando el viewport de ${p.name}` : `Capturando ${p.name}`) +
        ` a @${CAPTURE_DENSITY}x…`, { spinner: true })
  try {
    // The capture runs in its own offscreen window, so it needs the panel's
    // spec rather than a handle to the live guest.
    let scrollTo = 0
    if (mode === 'viewport') {
      try { scrollTo = await p.webview.executeJavaScript('window.scrollY') } catch (_) {}
    }
    const date = new Date()
    const url = p.webview.getURL()

    /* La captura corre sobre una copia recién cargada de la página, que no
     * sabe nada de lo seleccionado: le pasamos las rutas para que vuelva a
     * encontrar los elementos, y las secciones ya calculadas para la franja
     * de información. Si el elemento no aparece —una página que se dibuja
     * sola y no sale igual dos veces— la imagen sale sin resalte y se avisa,
     * en vez de perder la captura. */
    /* La pareja medida sólo viaja a la captura si está fijada.
     *
     * Antes viajaba la última que hubiera, y la última que hay casi nunca es
     * la que se quería: al salir del frame camino del botón, el puntero cruza
     * media página y la reasigna a lo que pisó por el borde. La imagen salía
     * con una caja magenta y unas cotas que nadie había pedido, en una captura
     * cuyo destino es explicarle algo a otra persona. Fijarla es el gesto que
     * dice «esta medida es la que quiero». */
    const measured = insState.locked && insState.hoverPath
    const inspectSpec = withInspect && insState.path
      ? {
          path: insState.path,
          hoverPath: measured ? insState.hoverPath : null,
          label: insState.data.label,
          hoverLabel: measured ? insState.hoverLabel : null,
          dist: measured ? insState.dist : null,
          why: measured ? insState.why : null,
          /* La nota se escribe para la persona que va a arreglarlo, así que
           * viaja tal cual y se dibuja arriba de la columna: es lo primero que
           * se lee al abrir la imagen, antes que el selector y el CSS. */
          note: (note || '').trim() || null,
          sections: window.PreviewerInspect.sections(insState.data)
        }
      : null

    const res = await window.previewer.capturePanel({
      url,
      width: p.w,
      height: p.h,
      colorScheme: p.colorScheme,
      locale: p.locale,
      reducedMotion: p.reducedMotion,
      zoom: p.zoom,
      density: CAPTURE_DENSITY,
      mode,
      scrollTo,
      inspect: inspectSpec,
      fileName: shotName(p, date, mode),
      header: {
        name: p.name,
        size: `${p.w}×${p.h}`,
        when: stamp(date),
        url,
        variants: variants(p)
      }
    })
    if (!res.ok) { toast('No se pudo capturar: ' + res.reason); return }

    const notes = []
    if (res.truncated) notes.push('recortada, la página es larguísima')
    if (inspectSpec && res.inspected === false) {
      notes.push('sin el resalte: el elemento no aparece igual al recargar la página')
    }
    if (inspectSpec && res.column === false) notes.push('sin la columna de datos')
    /* Había una distancia en el panel y no está en la imagen: mejor decirlo
     * aquí que dejar que se descubra al abrir el archivo. */
    if (inspectSpec && !measured && insState.dist) {
      notes.push('sin la distancia: no estaba fijada, se fija con Mayúsculas + clic')
    }
    /* Nothing we do adds pixels an <img> never had, so when the page's own
     * bitmaps are the limit it is worth saying: the soft logo in the shot is the
     * page's, not the capture's, and no setting here would have fixed it. */
    if (res.ceiling) {
      notes.push(`la página tiene imágenes por debajo de @${res.density}x ` +
                 `(la mayor: ${res.ceiling.source}px de origen mostrados a ${res.ceiling.css}px)`)
    }
    toast(`Guardado en Descargas/previewer · ${res.width}×${res.height} @${res.density}x · ` +
          `${(res.bytes / 1e6).toFixed(1)} MB` +
          (notes.length ? ` (${notes.join('; ')})` : ''),
          { action: { label: 'Mostrar en Finder', run: () => window.previewer.reveal(res.file) } })
  } catch (err) {
    toast('Error en la captura: ' + ((err && err.message) || err))
  } finally {
    capturing = false
  }
}

/* ------------------------------------------------------ inspección */

/* Un solo frame inspecciona a la vez: el panel de propiedades es uno, y
 * repartirlo entre frames sólo añadiría la duda de a cuál pertenece lo que
 * estás leyendo. Encender el modo en otro frame lo apaga en el anterior.
 *
 * No se guarda en localStorage a propósito: es una herramienta de un rato, y
 * arrancar la app con un frame que no responde a los clics sería un misterio.
 *
 * `hover` guarda la última pareja medida y no se borra al salir la página con
 * el ratón: es lo que dibuja la captura, y para cuando pulsas «Capturar» el
 * puntero ya está fuera del frame. Con `locked`, además, el ratón ha dejado de
 * moverla: es la única forma de capturar una distancia concreta en vez de la
 * que hubiera bajo el puntero al salir del frame. */
const insState = {
  id: null, data: null, path: null,
  hoverPath: null, hoverLabel: null, dist: null, why: null, locked: false
}

/* Suelta lo medido y deja sólo el elemento seleccionado. */
function dropInsLock () {
  insState.hoverPath = null
  insState.hoverLabel = null
  insState.dist = null
  insState.why = null
  insState.locked = false
}

/* …y esto suelta también la selección. */
function dropInsSelection () {
  insState.data = null
  insState.path = null
  dropInsLock()
}

const inspector = $('#inspector')
const insBody = $('#ins-body')
const insNoteRow = $('#ins-note-row')
const insNoteInput = $('#ins-note')

/* La nota de la captura.
 *
 * El paso se pide al pulsar «Capturar» y no antes: un campo permanente en el
 * panel sería una caja vacía más que mirar, y de las dos cosas que puedes
 * querer hacer con el botón —capturar y capturar contando algo— la primera
 * sigue siendo un Enter. Se abre vacía siempre: una nota del error anterior
 * pegada en la captura del siguiente es peor que no tener nota, porque quien
 * la lee se la cree. */
function openInsNote () {
  insNoteRow.hidden = false
  insNoteInput.value = ''
  growInsNote()
  insNoteInput.focus()
}

function closeInsNote () {
  insNoteRow.hidden = true
  insNoteInput.value = ''
  growInsNote()
}

/* El alto lo pone el contenido: se suelta a `auto` para medirlo de verdad y se
 * fija en lo que mide, que el tope lo pone el max-height del CSS. */
function growInsNote () {
  insNoteInput.style.height = 'auto'
  insNoteInput.style.height = insNoteInput.scrollHeight + 'px'
}

function inspecting () {
  return insState.id ? state.panels.find((p) => p.id === insState.id) || null : null
}

function sendInspect (p, on, clear) {
  if (!p || !p.ready) return
  try {
    /* Una vez por carga de página: el preload se vuelve a ejecutar en cada
     * navegación y se lleva el módulo con él. Los mensajes llegan en orden,
     * así que para cuando el guest atienda «inspect» ya lo tiene evaluado. */
    if (on && !p.insArmed && inspectSource) {
      p.webview.send('inspect-source', inspectSource)
      p.insArmed = true
    }
    // `clear` es true (todo) o 'lock' (sólo la pareja medida).
    p.webview.send('inspect', { on, k: 1 / state.canvas.scale, clear: clear || false })
    lastInspectK = on ? Math.round((1 / state.canvas.scale) * 100) / 100 : null
  } catch (_) {}
}

function setInspect (p, on) {
  const previous = inspecting()
  if (previous && previous !== p) sendInspect(previous, false)

  insState.id = on ? p.id : null
  dropInsSelection()

  if (on) sendInspect(p, true, true)
  else if (p) sendInspect(p, false)

  for (const q of state.panels) {
    if (q.el) q.el.querySelector('.inspect').classList.toggle('on', q.id === insState.id)
  }
  paintInspector()
}

/* El contra-escalado de las etiquetas del overlay depende del zoom del lienzo,
 * así que hay que reenviarlo — pero sólo cuando cambia de verdad, no en cada
 * evento de rueda: un pan no toca la escala. */
let lastInspectK = null

function syncInspectScale () {
  const p = inspecting()
  if (!p) { lastInspectK = null; return }
  const k = Math.round((1 / state.canvas.scale) * 100) / 100
  if (k === lastInspectK) return
  lastInspectK = k
  sendInspect(p, true)
}

function paintInspector () {
  const p = inspecting()
  inspector.hidden = !p
  /* Lo que la nota describe es el elemento seleccionado: si cambia o se
   * suelta, la nota escrita ya no habla de lo que va a salir en la imagen. */
  if (!p || !insState.path) closeInsNote()
  if (!p) return

  $('#ins-frame').textContent = p.name
  insBody.innerHTML = ''

  if (!insState.data) {
    const hint = document.createElement('p')
    hint.className = 'ins-hint'
    /* Lo de medir distancias no se cuenta aquí: se cuenta cuando hay algo
     * seleccionado, que es cuando se puede hacer y donde va a salir. */
    hint.textContent = 'Clica un elemento del frame para ver sus propiedades.'
    insBody.appendChild(hint)
    return
  }

  const head = document.createElement('div')
  head.className = 'ins-sel'
  head.textContent = insState.data.label
  insBody.appendChild(head)

  /* Se crea siempre y se rellena aparte: es lo único que cambia al mover el
   * ratón, y reconstruir las filas de propiedades en cada hover sería tirar
   * medio panel a la basura para actualizar una línea. */
  const dist = document.createElement('div')
  dist.className = 'ins-dist'
  dist.innerHTML =
    '<div class="ins-dist-head"><span class="ins-dist-v"></span>' +
    '<span class="ins-dist-pin"></span></div>' +
    '<span class="ins-dist-to"></span><span class="ins-dist-why"></span>'
  insBody.appendChild(dist)

  /* En el mismo sitio en el que va a salir la medida: la pista enseña el gesto
   * y de paso enseña dónde mirar cuando lo hagas. */
  const tip = document.createElement('div')
  tip.className = 'ins-tip'
  tip.innerHTML = '<b>Mayúsculas + clic</b> en otro elemento para medir la distancia.'
  insBody.appendChild(tip)
  paintDistance()

  for (const sec of window.PreviewerInspect.sections(insState.data)) {
    const box = document.createElement('div')
    box.className = 'ins-sec'
    const title = document.createElement('div')
    title.className = 'ins-sec-title'
    title.textContent = sec.title
    box.appendChild(title)
    for (const row of sec.rows) box.appendChild(insRow(row))
    insBody.appendChild(box)
  }
}

/* La tipografía real se pregunta al proceso principal, que es quien puede
 * hablar por el protocolo de DevTools, y tarda unos milisegundos: el panel se
 * pinta ya y la fila se rellena cuando llega. Si para entonces has clicado
 * otra cosa, la respuesta se tira. */
async function askPlatformFont (p) {
  if (!insState.data || !insState.data.text || !insState.path) return
  const forPath = insState.path
  let name = null
  try {
    name = await window.previewer.platformFont(p.webview.getWebContentsId(), forPath)
  } catch (_) {}
  if (!name || insState.path !== forPath || !insState.data.text) return
  insState.data.text.rendered = name
  paintInspector()
}

function paintDistance () {
  const el = insBody.querySelector('.ins-dist')
  if (!el) return
  /* La pista ocupa el hueco de la medida mientras no haya ninguna fijada, y
   * desaparece para siempre en cuanto se fija la primera. No se esconde al
   * pasar el ratón por encima de otro elemento: quieta es una pista, y
   * apareciendo y desapareciendo con el ratón sería otra vez el parpadeo que
   * se acaba de quitar de aquí. */
  const tip = insBody.querySelector('.ins-tip')
  if (tip) tip.hidden = distLearned || insState.locked
  /* Sólo cuando la medida está fijada. En hover la cifra cambia con cada
   * movimiento del ratón, y un recuadro que parpadea al lado de las
   * propiedades del elemento seleccionado es ruido: mientras mides, el número
   * ya está donde estás mirando, dibujado dentro del frame junto a la línea. */
  const show = !!(insState.dist && insState.locked)
  el.hidden = !show
  if (!show) return
  el.querySelector('.ins-dist-v').textContent = insState.dist
  /* El rótulo explica de qué es este número: una medida fijada, que ya no
   * depende del ratón y que va a salir en la captura. */
  el.querySelector('.ins-dist-pin').textContent = 'fijado'
  el.querySelector('.ins-dist-to').textContent =
    'hasta ' + (insState.hoverLabel || 'el otro elemento')
  /* De dónde sale la distancia, cuando se puede saber sin inventar. */
  const why = el.querySelector('.ins-dist-why')
  why.hidden = !insState.why
  why.textContent = insState.why || ''
}

/* Cada valor es un botón: el gesto que sigue a leer un hex o un tamaño es
 * pegarlo en otro sitio. */
function insRow (row) {
  const el = document.createElement('button')
  el.className = 'ins-row'
  /* La pila de fuentes completa y el elemento del que viene un fondo heredado
   * son datos de segundo orden: caben en el tooltip y no en la fila. */
  el.title = (row.note ? row.note + '\n' : '') + 'Copiar «' + row.v + '»'

  const k = document.createElement('span')
  k.className = 'ins-k'
  k.textContent = row.k

  const v = document.createElement('span')
  v.className = 'ins-v'
  if (row.swatch) {
    const dot = document.createElement('span')
    dot.className = 'ins-swatch'
    dot.style.background = row.swatch
    v.appendChild(dot)
  }
  const text = document.createElement('span')
  text.className = 'ins-vt'
  text.textContent = row.v
  v.appendChild(text)
  if (row.tag) {
    const tag = document.createElement('span')
    tag.className = 'ins-tag' + (row.bad ? ' bad' : '')
    tag.textContent = row.tag
    v.appendChild(tag)
  }

  el.append(k, v)
  el.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(row.v)
      toast('Copiado: ' + row.v)
    } catch (_) { toast('No se pudo copiar al portapapeles') }
  })
  return el
}

/* ------------------------------------------------------------- popover */

let popoverCleanup = null
let popoverAnchor = null

/* Recolocar es idempotente, así que un acordeón que se despliega puede volver
 * a llamarlo para no acabar desbordando por abajo. */
function placePopover () {
  if (!popoverAnchor || popover.hidden) return
  const rect = popoverAnchor.getBoundingClientRect()
  const pr = popover.getBoundingClientRect()
  const left = Math.min(rect.left, window.innerWidth - pr.width - 10)
  const top = Math.min(rect.bottom + 6, window.innerHeight - pr.height - 10)
  popover.style.left = Math.max(8, left) + 'px'
  popover.style.top = Math.max(8, top) + 'px'
}

function openPopover (anchor, build, className) {
  closePopover()
  popover.innerHTML = ''
  popover.className = className || ''
  build(popover)
  popover.hidden = false
  popoverAnchor = anchor
  placePopover()

  const onDown = (e) => { if (!popover.contains(e.target)) closePopover() }
  const onKey = (e) => { if (e.key === 'Escape') closePopover() }
  setTimeout(() => {
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('keydown', onKey, true)
  }, 0)
  popoverCleanup = () => {
    document.removeEventListener('mousedown', onDown, true)
    document.removeEventListener('keydown', onKey, true)
  }
  const input = popover.querySelector('input.text')
  if (input) input.focus()
}

function closePopover () {
  popover.hidden = true
  popoverAnchor = null
  if (popoverCleanup) popoverCleanup()
  popoverCleanup = null
}

function menuItem (label, meta, onClick, checked) {
  const b = document.createElement('button')
  b.className = 'item' + (checked ? ' checked' : '')
  b.innerHTML = `<span>${label}</span>` + (meta ? `<span class="meta">${meta}</span>` : '')
  b.addEventListener('click', (e) => { e.preventDefault(); onClick(e) })
  return b
}

function menuHead (text) {
  const d = document.createElement('div')
  d.className = 'head'
  d.textContent = text
  return d
}

function menuSep () {
  const d = document.createElement('div')
  d.className = 'sep'
  return d
}

/* Chevron hacia la derecha; el CSS lo gira 90° cuando el acordeón abre. */
const CHEVRON_ICON =
  '<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true" fill="none" ' +
  'stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M6 3.5 10.5 8 6 12.5"/></svg>'

/* Sección plegable para las listas largas —idioma, zoom— que en un menú de
 * panel se consultan poco y ocupan mucho. Nace cerrada: la cabecera lleva el
 * valor activo, así que no hace falta abrirla sólo para saber en qué está. */
function menuAccordion (title, summary, buildBody) {
  const wrap = document.createElement('div')
  wrap.className = 'acc'

  const head = document.createElement('button')
  head.className = 'item acc-head'
  head.innerHTML =
    `<span class="acc-chevron">${CHEVRON_ICON}</span><span>${title}</span>` +
    `<span class="meta">${summary}</span>`

  const body = document.createElement('div')
  body.className = 'acc-body'
  body.hidden = true
  buildBody(body)

  head.addEventListener('click', (e) => {
    e.preventDefault()
    body.hidden = !body.hidden
    wrap.classList.toggle('open', !body.hidden)
    placePopover()
  })

  wrap.append(head, body)
  return wrap
}

/* ------------------------------------------------------- interactions */

function withShield (onMove, onUp, cursor) {
  shield.hidden = false
  shield.style.cursor = cursor || 'default'
  const move = (e) => onMove(e)
  const up = (e) => {
    shield.hidden = true
    window.removeEventListener('mousemove', move)
    window.removeEventListener('mouseup', up)
    if (onUp) onUp(e)
  }
  window.addEventListener('mousemove', move)
  window.addEventListener('mouseup', up)
}

function wirePanelChrome (p) {
  const bar = p.el.querySelector('.panel-bar')

  /* Arrastrar por el título mueve la selección entera. Como en Figma: si el
   * panel no estaba seleccionado, pasa a ser la selección; con ⇧/⌘ se añade o
   * se quita del grupo. */
  bar.addEventListener('mousedown', (e) => {
    if (e.target.closest('button') || e.button !== 0) return
    if (e.shiftKey || e.metaKey) toggleSelected(p)
    else if (!isSelected(p)) setSelection([p.id])

    const group = selectedPanels()
    if (!group.includes(p)) return /* el ⇧-clic acaba de sacarlo del grupo */

    const from = group.map((q) => ({ q, px: q.x, py: q.y }))
    const start = { x: e.clientX, y: e.clientY }
    withShield((ev) => {
      const s = state.canvas.scale
      const dx = (ev.clientX - start.x) / s
      const dy = (ev.clientY - start.y) / s
      for (const it of from) {
        it.q.x = Math.round(it.px + dx)
        it.q.y = Math.round(it.py + dy)
        it.q.el.style.transform = `translate(${it.q.x}px, ${it.q.y}px)`
      }
    }, save, 'grabbing')
  })

  /* El clic derecho sobre el título abre el mismo menú que el «⋯». */
  bar.addEventListener('contextmenu', (e) => {
    if (e.target.closest('button')) return
    e.preventDefault()
    e.stopPropagation()
    openPanelMenu(p, pointAnchor(e.clientX, e.clientY))
  })

  p.el.querySelector('.panel-grip').addEventListener('mousedown', (e) => {
    e.stopPropagation()
    const start = { x: e.clientX, y: e.clientY, w: p.w, h: p.h }
    withShield((ev) => {
      const s = state.canvas.scale
      p.w = Math.max(240, Math.round(start.w + (ev.clientX - start.x) / s))
      p.h = Math.max(240, Math.round(start.h + (ev.clientY - start.y) / s))
      p.name = `${p.w}×${p.h}`
      layoutPanel(p)
    }, save, 'nwse-resize')
  })

  p.el.querySelector('.close').addEventListener('click', () => removePanel(p))

  p.el.querySelector('.inspect').addEventListener('click', () => {
    setInspect(p, insState.id !== p.id)
  })

  p.el.querySelector('.theme').addEventListener('click', () => {
    const order = ['auto', 'light', 'dark']
    p.colorScheme = order[(order.indexOf(p.colorScheme) + 1) % order.length]
    applyEmulation(p)
    layoutPanel(p)
    save()
  })

  p.el.querySelector('.more').addEventListener('click', (e) => {
    openPanelMenu(p, e.currentTarget)
  })
}

function openPanelMenu (p, anchor) {
  openPopover(anchor, (root) => {
    root.appendChild(menuHead('Esquema de color'))
    for (const scheme of ['auto', 'light', 'dark']) {
      root.appendChild(menuItem(
        { auto: 'Automático', light: 'Claro', dark: 'Oscuro' }[scheme],
        p.colorScheme === scheme ? '●' : '',
        () => {
          p.colorScheme = scheme
          applyEmulation(p); layoutPanel(p); save(); closePopover()
        },
        p.colorScheme === scheme
      ))
    }

    root.appendChild(menuSep())

    const active = window.LOCALES.find((l) => l.code === p.locale)
    root.appendChild(menuAccordion('Idioma', active ? active.label : p.locale, (body) => {
      for (const loc of window.LOCALES) {
        body.appendChild(menuItem(
          loc.label,
          p.locale === loc.code ? '●' : '',
          () => {
            p.locale = loc.code
            applyEmulation(p)
            p.webview.reload()
            layoutPanel(p); save(); closePopover()
          },
          p.locale === loc.code
        ))
      }
    }))

    root.appendChild(menuAccordion('Zoom de página', Math.round(p.zoom * 100) + '%', (body) => {
      for (const z of [0.5, 0.75, 1, 1.25, 1.5, 2]) {
        body.appendChild(menuItem(
          Math.round(z * 100) + '%',
          p.zoom === z ? '●' : '',
          () => {
            p.zoom = z
            try { p.webview.setZoomFactor(z) } catch (_) {}
            layoutPanel(p); save(); closePopover()
          },
          p.zoom === z
        ))
      }
    }))

    root.appendChild(menuSep())
    root.appendChild(menuItem(
      p.reducedMotion ? 'Movimiento reducido: sí' : 'Movimiento reducido: no', '',
      () => {
        p.reducedMotion = !p.reducedMotion
        applyEmulation(p); layoutPanel(p); save(); closePopover()
      }))
    root.appendChild(menuItem('Duplicar panel', '', () => {
      addPanel(serialize(p)); closePopover()
    }))
    root.appendChild(menuItem(
      insState.id === p.id ? 'Salir del modo inspección' : 'Inspeccionar elementos', '',
      () => { setInspect(p, insState.id !== p.id); closePopover() }))
    root.appendChild(menuItem('Screenshot de la página', 'JPG', () => {
      closePopover(); screenshotPanel(p, 'full')
    }))
    root.appendChild(menuItem('Screenshot del viewport', 'JPG', () => {
      closePopover(); screenshotPanel(p, 'viewport')
    }))
    root.appendChild(menuItem('Abrir DevTools', '', () => {
      window.previewer.openDevTools(p.webview.getWebContentsId()); closePopover()
    }))
    root.appendChild(menuItem('Recargar panel', '', () => {
      p.webview.reload(); closePopover()
    }))
    root.appendChild(menuItem('Quitar panel', '', () => {
      removePanel(p); closePopover()
    }))
  }, 'panel')
}

function openAddMenu (anchor) {
  openPopover(anchor, (root) => {
    root.appendChild(menuHead('Tamaño personalizado'))
    const input = document.createElement('input')
    input.className = 'text'
    input.placeholder = '1280x800'
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return
      const m = input.value.trim().match(/^(\d{2,5})\s*[x×*, ]\s*(\d{2,5})$/i)
      if (!m) { toast('Formato: ancho x alto (p. ej. 1280x800)'); return }
      addPanel({ name: `${m[1]}×${m[2]}`, w: +m[1], h: +m[2], dpr: 2 })
      closePopover()
    })
    root.appendChild(input)

    for (const group of window.DEVICE_PRESETS) {
      root.appendChild(menuSep())
      root.appendChild(menuHead(group.group))
      for (const d of group.items) {
        root.appendChild(menuItem(d.name, `${d.w}×${d.h}`, () => {
          addPanel(d); closePopover()
        }))
      }
    }
  })
}

/* Nombre en curso del bloque de guardado: null = modo botón, string = modo
 * input. Vive fuera de openSetsMenu para sobrevivir a los repintados. */
let setsDraft = null

/* Set que se está renombrando: { name, draft } o null. */
let setsRenaming = null

/* Lápiz sólido de dos piezas —capuchón y cuerpo con punta—: a 12px las
 * siluetas rellenas leen mejor que un contorno. Hereda color con currentColor. */
const PENCIL_ICON =
  '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">' +
  '<path fill="currentColor" d="M10.9 2.3 13.7 5.1 12.2 6.6 9.4 3.8Z' +
  'M8.7 4.5 11.5 7.3 5.4 13.4 2.2 14 2.8 10.8Z"/></svg>'

/* Flecha de retorno: dice «pulsa aquí» y «Enter también vale» a la vez. */
const ENTER_ICON =
  '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" fill="none" ' +
  'stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M12.5 4V9H4"/><path d="M6.5 6.5 4 9l2.5 2.5"/></svg>'

/* Reconstruimos el objeto en vez de delete + reasignar para que el set
 * renombrado no salte al final de la lista. */
function renameSet (from, to) {
  const next = {}
  for (const [name, set] of Object.entries(sets)) next[name === from ? to : name] = set
  sets = next
  saveSets()
}

function openSetsMenu (anchor) {
  const repaint = () => openSetsMenu(anchor)

  openPopover(anchor, (root) => {
    root.appendChild(menuHead('Guardar'))
    root.appendChild(setsDraft === null ? saveCta(repaint) : saveForm(repaint))

    const names = Object.keys(sets)
    root.appendChild(menuSep())
    root.appendChild(menuHead(names.length ? 'Sets guardados' : 'Sin sets guardados'))
    for (const name of names) root.appendChild(setItem(name, repaint))
  }, 'wide')
}

/* ------------------------------------------------- menú del lienzo */

/* openPopover sólo pide getBoundingClientRect, así que el cursor puede hacer
 * de anclaje: un rect de tamaño cero deja el menú justo bajo el puntero. */
function pointAnchor (x, y) {
  return { getBoundingClientRect: () => ({ left: x, top: y, right: x, bottom: y, width: 0, height: 0 }) }
}

function openCanvasMenu (x, y) {
  openPopover(pointAnchor(x, y), (root) => {
    /* Sin fit(): alinear no es lo mismo que encajar. Quien quiera ambas cosas
     * tiene el botón «Encajar» al lado del zoom. */
    root.appendChild(menuItem('Reordenar en fila', '', () => {
      arrange(); render(); save(); closePopover()
    }))
    root.appendChild(menuItem('Recargar todo', '⌘R', () => { reloadAll(); closePopover() }))

    root.appendChild(menuSep())
    /* Vuelve a dejar las páginas como para un visitante nuevo: cookies de
     * sesión, banners de consentimiento, onboarding y flags en localStorage.
     * Afecta a todos los paneles porque comparten partición. */
    root.appendChild(menuItem('Limpiar caché y recargar', '', async () => {
      closePopover()
      await window.previewer.clearStorage('persist:previewer')
      reloadAll()
      toast('Caché, cookies y storage borrados')
    }))
  })
}

function saveCta (repaint) {
  const b = document.createElement('button')
  b.className = 'save-cta'
  b.innerHTML = '<span>Guardar set actual</span><span class="plus">＋</span>'
  b.addEventListener('click', (e) => {
    e.preventDefault()
    setsRenaming = null /* nunca dos inputs abiertos a la vez */
    setsDraft = ''
    repaint()
  })
  return b
}

/* El aviso de nombre repetido es reactivo: se recalcula al teclear en vez de
 * repintar el menú, así no se pierde el foco ni el cursor a media escritura. */
function saveForm (repaint) {
  const wrap = document.createElement('div')
  wrap.className = 'save-form'

  const row = document.createElement('div')
  row.className = 'set-item'

  const input = document.createElement('input')
  input.className = 'text'
  input.placeholder = 'Nombre del set…'
  input.value = setsDraft

  const ok = document.createElement('button')
  ok.className = 'set-act ok'
  ok.innerHTML = ENTER_ICON
  ok.title = 'Guardar (Enter)'

  const cancel = document.createElement('button')
  cancel.className = 'set-act'
  cancel.textContent = '✕'
  cancel.title = 'Cancelar'

  const warn = document.createElement('div')
  warn.className = 'warn'

  /* Sólo aparece al chocar con un nombre existente: ahí hay que elegir. */
  const btnRow = document.createElement('div')
  btnRow.className = 'btn-row'
  const bOver = miniBtn('Sobrescribir', 'primary')
  const bCopy = miniBtn('Guardar copia')
  btnRow.append(bOver, bCopy)

  row.append(input, ok, cancel)
  wrap.append(row, warn, btnRow)

  const commit = (name) => {
    const fresh = !sets[name]
    sets[name] = currentSet()
    saveSets()
    setsDraft = null
    toast(fresh ? `Set «${name}» guardado` : `Set «${name}» actualizado`)
    repaint()
  }

  const sync = () => {
    setsDraft = input.value
    const name = input.value.trim()
    const clash = !!name && !!sets[name]
    warn.hidden = !clash
    btnRow.hidden = !clash
    ok.disabled = clash || !name
    if (clash) {
      warn.textContent = `Ya existe un set «${name}»`
      bCopy.querySelector('span').textContent = `Guardar como «${uniqueSetName(name)}»`
    }
  }

  input.addEventListener('input', sync)
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return
    e.preventDefault()
    const name = input.value.trim()
    if (!name || sets[name]) return /* con conflicto hay que elegir a mano */
    commit(name)
  })

  ok.addEventListener('mousedown', (e) => e.preventDefault())
  ok.addEventListener('click', (e) => {
    e.preventDefault()
    const name = input.value.trim()
    if (name && !sets[name]) commit(name)
  })
  cancel.addEventListener('mousedown', (e) => e.preventDefault())
  cancel.addEventListener('click', (e) => {
    e.preventDefault()
    setsDraft = null
    repaint()
  })
  bOver.addEventListener('click', () => commit(input.value.trim()))
  bCopy.addEventListener('click', () => commit(uniqueSetName(input.value.trim())))

  sync()
  /* Tras el foco que da openPopover, el cursor al final del nombre. */
  setTimeout(() => {
    input.focus()
    input.setSelectionRange(input.value.length, input.value.length)
  }, 0)
  return wrap
}

function setItem (name, repaint) {
  if (setsRenaming && setsRenaming.name === name) return renameRow(name, repaint)

  const row = document.createElement('div')
  row.className = 'set-item'

  const url = sets[name].url

  const open = document.createElement('button')
  open.className = 'set-open'
  open.innerHTML = '<span class="set-name"></span>'
  open.firstChild.textContent = name
  open.title = url
    ? `${name} — ${url}`
    : `${name} — sin URL guardada; sobrescribe el set para añadirla`

  /* Los sets creados antes de que el formato incluyera la URL no pueden
   * navegar: se marcan para que se distingan de los que sí lo hacen. */
  if (!url) {
    const tag = document.createElement('span')
    tag.className = 'set-tag'
    tag.textContent = 'sin URL'
    open.appendChild(tag)
  }
  open.addEventListener('click', (e) => {
    e.preventDefault()
    replaceSet(sets[name])
    closePopover()
  })

  const edit = document.createElement('button')
  edit.className = 'set-act'
  edit.innerHTML = PENCIL_ICON
  edit.title = `Renombrar «${name}»`
  edit.addEventListener('click', (e) => {
    e.preventDefault()
    setsDraft = null /* nunca dos inputs abiertos a la vez */
    setsRenaming = { name, draft: name }
    repaint()
  })

  const del = document.createElement('button')
  del.className = 'set-act del'
  del.textContent = '✕'
  del.title = `Borrar «${name}»`
  del.addEventListener('click', (e) => {
    e.preventDefault()
    delete sets[name]
    saveSets()
    repaint()
  })

  row.append(open, edit, del)
  return row
}

/* Renombrar rechaza colisiones en vez de ofrecer sobrescribir: aquí no hay
 * nada que fusionar y pisar otro set sería perder sus paneles. */
function renameRow (name, repaint) {
  const wrap = document.createElement('div')
  wrap.className = 'set-rename'

  const row = document.createElement('div')
  row.className = 'set-item'

  const input = document.createElement('input')
  input.className = 'text'
  input.value = setsRenaming.draft
  input.placeholder = 'Nuevo nombre…'

  const ok = document.createElement('button')
  ok.className = 'set-act ok'
  ok.textContent = '✓'
  ok.title = 'Renombrar'

  const cancel = document.createElement('button')
  cancel.className = 'set-act'
  cancel.textContent = '✕'
  cancel.title = 'Cancelar'

  const warn = document.createElement('div')
  warn.className = 'warn'

  row.append(input, ok, cancel)
  wrap.append(row, warn)

  const clashes = () => {
    const v = input.value.trim()
    return !!v && v !== name && !!sets[v]
  }

  const sync = () => {
    setsRenaming.draft = input.value
    const bad = clashes()
    warn.hidden = !bad
    if (bad) warn.textContent = `Ya existe un set «${input.value.trim()}»`
    ok.disabled = bad || !input.value.trim()
  }

  const commit = () => {
    const v = input.value.trim()
    if (!v || clashes()) return
    if (v !== name) {
      renameSet(name, v)
      toast(`Set renombrado a «${v}»`)
    }
    setsRenaming = null
    repaint()
  }

  input.addEventListener('input', sync)
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return
    e.preventDefault()
    commit()
  })
  ok.addEventListener('mousedown', (e) => e.preventDefault())
  ok.addEventListener('click', (e) => { e.preventDefault(); commit() })
  cancel.addEventListener('mousedown', (e) => e.preventDefault())
  cancel.addEventListener('click', (e) => {
    e.preventDefault()
    setsRenaming = null
    repaint()
  })

  sync()
  setTimeout(() => { input.focus(); input.select() }, 0)
  return wrap
}

function miniBtn (label, variant) {
  const b = document.createElement('button')
  b.className = 'mini' + (variant ? ' ' + variant : '')
  b.innerHTML = '<span></span>'
  b.firstChild.textContent = label
  /* No robar el foco al input: el cursor sigue donde estaba tras pulsar. */
  b.addEventListener('mousedown', (e) => e.preventDefault())
  return b
}

/* ------------------------------------------------------- pan and zoom */

let spaceDown = false

function setPanMode (down) {
  if (spaceDown === down) return
  spaceDown = down
  panOverlay.hidden = !down
}

panOverlay.addEventListener('mousedown', (e) => {
  const start = { x: e.clientX, y: e.clientY, cx: state.canvas.x, cy: state.canvas.y }
  panOverlay.classList.add('dragging')
  withShield((ev) => {
    state.canvas.x = start.cx + (ev.clientX - start.x)
    state.canvas.y = start.cy + (ev.clientY - start.y)
    applyTransform()
  }, () => { panOverlay.classList.remove('dragging'); save() }, 'grabbing')
})

function startPan (e) {
  const start = { x: e.clientX, y: e.clientY, cx: state.canvas.x, cy: state.canvas.y }
  withShield((ev) => {
    state.canvas.x = start.cx + (ev.clientX - start.x)
    state.canvas.y = start.cy + (ev.clientY - start.y)
    applyTransform()
  }, save, 'grabbing')
}

/* Recuadro de selección al arrastrar con el izquierdo sobre el fondo. Trabaja
 * en coordenadas de pantalla —el marquee es fijo, no vive dentro del lienzo—
 * y compara contra el rect real de cada panel, así el zoom no entra en juego. */
function startMarquee (e) {
  const additive = e.shiftKey || e.metaKey
  const base = additive ? [...selection] : []
  if (!additive) clearSelection()

  const x0 = e.clientX
  const y0 = e.clientY
  let dragging = false

  withShield((ev) => {
    if (!dragging) {
      /* Un clic limpio no debe pintar recuadro: hasta 3px es un clic. */
      if (Math.abs(ev.clientX - x0) + Math.abs(ev.clientY - y0) < 3) return
      dragging = true
      marquee.hidden = false
    }
    const box = {
      left: Math.min(x0, ev.clientX),
      top: Math.min(y0, ev.clientY),
      right: Math.max(x0, ev.clientX),
      bottom: Math.max(y0, ev.clientY)
    }
    marquee.style.left = box.left + 'px'
    marquee.style.top = box.top + 'px'
    marquee.style.width = (box.right - box.left) + 'px'
    marquee.style.height = (box.bottom - box.top) + 'px'

    const hit = state.panels.filter((p) => intersects(p.el.getBoundingClientRect(), box))
    setSelection([...base, ...hit.map((p) => p.id)])
  }, () => { marquee.hidden = true }, 'crosshair')
}

function intersects (a, b) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
}

/* El izquierdo selecciona, el central mueve el lienzo (también sobre un panel)
 * y el derecho se reserva para el menú contextual. Para mover el lienzo con el
 * izquierdo está espacio + arrastrar, que va por #pan-overlay. */
viewport.addEventListener('mousedown', (e) => {
  if (e.button === 2 || e.target.closest('button')) return
  if (e.button === 1) { startPan(e); return }
  if (e.button !== 0 || e.target.closest('.panel')) return
  startMarquee(e)
})

/* Clic derecho sobre el fondo del lienzo. Dentro de un panel no tocamos nada:
 * el menú del panel vive en su «···» y la página se queda con el suyo. */
viewport.addEventListener('contextmenu', (e) => {
  if (e.target.closest('.panel')) return
  e.preventDefault()
  openCanvasMenu(e.clientX, e.clientY)
})

// Wheel over the canvas background (outside any page): zoom with the
// modifier, pan otherwise — inside a page the guest handles it natively.
viewport.addEventListener('wheel', (e) => {
  if (e.metaKey || e.ctrlKey) {
    e.preventDefault()
    // Trackpad pinch reaches here as a synthetic ctrlKey wheel event with
    // much smaller deltas than an actual mouse wheel, so it needs a
    // steeper multiplier to feel comparable.
    const speed = (e.ctrlKey && !e.metaKey) ? 0.02 : 0.005
    zoomAt(state.canvas.scale * (1 - e.deltaY * speed), e.clientX, e.clientY)
  } else {
    state.canvas.x -= e.deltaX
    state.canvas.y -= e.deltaY
    applyTransform()
    save()
  }
}, { passive: false })

/* ------------------------------------------------------------ shortcuts */

function handleShortcut ({ key, shift }) {
  switch (key) {
    case 'r': case 'R': reloadAll(); break
    case '0': fit(); break
    case '=': case '+': zoomBy(1.2); break
    case '-': zoomBy(1 / 1.2); break
    case 'l': case 'L': urlInput.focus(); urlInput.select(); break
    case 'd': case 'D':
      if (shift) { for (const p of state.panels) { p.colorScheme = 'dark'; applyEmulation(p); layoutPanel(p) } save() }
      break
  }
}

window.addEventListener('keydown', (e) => {
  const typing = ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)
  if (e.code === 'Space' && !typing) { e.preventDefault(); setPanMode(true); return }
  /* Con un menú abierto, Escape es suyo: lo cierra openPopover. */
  if (e.key === 'Escape' && popover.hidden && !typing) {
    /* Con el modo activo Escape es suyo, tenga el foco la página o el lienzo:
     * mismos pasos que dentro del frame —suelta lo fijado, luego la selección,
     * y a la última sale del modo. */
    if (insState.id) {
      const p = inspecting()
      if (insState.locked) {
        dropInsLock()
        sendInspect(p, true, 'lock')
        paintDistance()
      } else if (insState.data) {
        dropInsSelection()
        sendInspect(p, true, true)
        paintInspector()
      } else {
        setInspect(p, false)
      }
      return
    }
    clearSelection()
    return
  }
  if (e.metaKey || e.ctrlKey) {
    const handled = ['r', 'R', '0', '=', '+', '-', 'l', 'L', 'd', 'D']
    if (handled.includes(e.key)) {
      e.preventDefault()
      handleShortcut({ key: e.key, shift: e.shiftKey })
    }
  }
})

window.addEventListener('keyup', (e) => {
  if (e.code === 'Space') setPanMode(false)
})

window.addEventListener('blur', () => setPanMode(false))

/* --------------------------------------------------------------- chrome */

toastActionEl.addEventListener('click', () => {
  if (toastAction) toastAction.run()
})

$('#url-form').addEventListener('submit', (e) => {
  e.preventDefault()
  loadAll(urlInput.value)
  urlInput.blur()
})

urlInput.addEventListener('focus', () => urlInput.select())

$('#btn-reload').addEventListener('click', reloadAll)
$('#btn-back').addEventListener('click', () => {
  for (const p of state.panels) { try { p.webview.goBack() } catch (_) {} }
})
$('#btn-forward').addEventListener('click', () => {
  for (const p of state.panels) { try { p.webview.goForward() } catch (_) {} }
})

$('#btn-add').addEventListener('click', (e) => openAddMenu(e.currentTarget))
$('#empty-add').addEventListener('click', (e) => openAddMenu(e.currentTarget))
$('#btn-sets').addEventListener('click', (e) => {
  setsDraft = null
  setsRenaming = null
  openSetsMenu(e.currentTarget)
})

$('#ins-close').addEventListener('click', () => setInspect(inspecting(), false))
$('#ins-shot').addEventListener('click', () => {
  const p = inspecting()
  if (!p) return
  if (!insState.path) { toast('Clica primero un elemento del frame'); return }
  /* Con una captura en marcha no se abre la nota: la escribirías para que
   * screenshotPanel la tirase por estar ocupado. */
  if (capturing) return
  // Primer clic: abre la nota. Segundo: captura con lo que haya escrito.
  if (insNoteRow.hidden) { openInsNote(); return }
  const note = insNoteInput.value
  closeInsNote()
  screenshotPanel(p, 'viewport', true, note)
})

/* El botón y el Enter son el mismo gesto, así que pasan por el mismo sitio. */
$('#ins-note-go').addEventListener('click', () => $('#ins-shot').click())

insNoteInput.addEventListener('input', growInsNote)

insNoteInput.addEventListener('keydown', (e) => {
  /* Enter captura con nota o sin ella: el paso nuevo nunca puede dejarte sin
   * la captura de siempre, sólo ofrecerte contar algo de camino. Lo mismo hace
   * el botón ⏎ de al lado, para quien esté con el ratón.
   *
   * Con ⇧ parte la línea, como en cualquier chat: la nota que enumera dos
   * cosas se lee mejor en dos renglones, y los saltos llegan a la imagen. */
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    $('#ins-shot').click()
    return
  }
  if (e.key === 'Escape') { e.preventDefault(); closeInsNote() }
})

/* El panel se puede mover: es grande y el frame que estás mirando puede
 * quedar justo debajo. Reutiliza el shield del resto de arrastres. */
$('#inspector').querySelector('.ins-bar').addEventListener('mousedown', (e) => {
  if (e.target.closest('button') || e.button !== 0) return
  const r = inspector.getBoundingClientRect()
  const start = { x: e.clientX, y: e.clientY }
  withShield((ev) => {
    inspector.style.left = Math.max(8, r.left + ev.clientX - start.x) + 'px'
    inspector.style.top = Math.max(8, r.top + ev.clientY - start.y) + 'px'
    inspector.style.right = 'auto'
  }, null, 'grabbing')
})

$('#zoom-in').addEventListener('click', () => zoomBy(1.2))
$('#zoom-out').addEventListener('click', () => zoomBy(1 / 1.2))
$('#zoom-level').addEventListener('click', () => {
  const rect = viewport.getBoundingClientRect()
  zoomAt(1, rect.left + rect.width / 2, rect.top + rect.height / 2)
})
$('#btn-fit').addEventListener('click', fit)

for (const btn of document.querySelectorAll('.toggle[data-sync]')) {
  btn.addEventListener('click', () => {
    const key = btn.dataset.sync
    state.sync[key] = !state.sync[key]
    btn.classList.toggle('on', state.sync[key])
    save()
  })
}

$('#scroll-mode').addEventListener('click', (e) => {
  state.scrollMode = state.scrollMode === 'ratio' ? 'absolute' : 'ratio'
  e.currentTarget.textContent = state.scrollMode === 'ratio' ? '%' : 'px'
  e.currentTarget.title = state.scrollMode === 'ratio'
    ? 'Scroll proporcional (cada panel a su propio %)'
    : 'Scroll absoluto (mismos píxeles en todos)'
  save()
})

function syncChrome () {
  urlInput.value = state.url
  urlStatus.className = 'scheme ' + (isLocal(state.url) ? 'local' : 'remote')
  for (const btn of document.querySelectorAll('.toggle[data-sync]')) {
    btn.classList.toggle('on', !!state.sync[btn.dataset.sync])
  }
  $('#scroll-mode').textContent = state.scrollMode === 'ratio' ? '%' : 'px'
}

/* ----------------------------------------------------------- bootstrap */

;(async function boot () {
  guestPreload = await window.previewer.guestPreloadPath()
  inspectSource = await window.previewer.inspectSource()
  restore()
  syncChrome()
  render()
})()
