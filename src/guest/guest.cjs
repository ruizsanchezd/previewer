/* Runs inside every previewed page (webview preload, isolated world).
 * Talks to the host renderer over ipcRenderer.sendToHost / .on.
 * Everything here must survive on any third-party page, so it stays
 * defensive: no assumptions about frameworks, no globals leaked. */

const { ipcRenderer } = require('electron')

const SUPPRESS_MS = 180
let suppressScrollUntil = 0
let replaying = false
let queuedScroll = false
let appliedY = null

/* ---------------------------------------------- smooth-scroll bridge -- */

/* Lenis, ScrollSmoother and Locomotive hijack the wheel and re-assert their
 * own target every frame, so a plain `window.scrollTo` gets overwritten on
 * the next tick and the panel drifts back. Reaching them means talking to
 * the page's own world, and this preload runs in an isolated one: it shares
 * the DOM but not the globals, so `window.lenis` is never visible from here.
 * Hence a one-time <script> planted in the page, addressed over DOM events
 * and attributes (the only channel both worlds agree on).
 *
 * If a CSP blocks the injection the script never runs, the ready flag never
 * appears, and we stay on the native path — which is the correct one for
 * every page without a hijacker anyway. */

const BRIDGE_EVENT = '__previewer_scroll'
const BRIDGE_READY = 'data-previewer-bridge'
const BRIDGE_TARGET = 'data-previewer-scroll-y'

const BRIDGE_SOURCE = `(function () {
  var root = document.documentElement
  function engine () {
    var l = window.lenis || window.__lenis
    if (l && typeof l.scrollTo === 'function') {
      return ['lenis', function (y) { l.scrollTo(y, { immediate: true, force: true, lock: true }) }]
    }
    var S = window.ScrollSmoother
    var s = S && typeof S.get === 'function' ? S.get() : null
    if (s && typeof s.scrollTo === 'function') {
      return ['scrollsmoother', function (y) { s.scrollTo(y, false) }]
    }
    var loco = window.locoScroll || window.locomotive
    if (loco && typeof loco.scrollTo === 'function') {
      return ['locomotive', function (y) { loco.scrollTo(y, { duration: 0, disableLerp: true }) }]
    }
    return null
  }
  window.addEventListener('${BRIDGE_EVENT}', function () {
    var y = parseFloat(root.getAttribute('${BRIDGE_TARGET}')) || 0
    // Re-checked per event on purpose: these instances are built after load
    // and can be torn down and rebuilt on client-side navigation.
    var found = engine()
    if (found) {
      root.setAttribute('data-previewer-engine', found[0])
      try { found[1](y); return } catch (_) {}
    } else {
      root.removeAttribute('data-previewer-engine')
    }
    window.scrollTo({ top: y, left: 0, behavior: 'instant' })
  })
  root.setAttribute('${BRIDGE_READY}', '1')
})()`

function installBridge () {
  const root = document.documentElement
  if (!root || root.hasAttribute(BRIDGE_READY)) return
  try {
    const s = document.createElement('script')
    s.textContent = BRIDGE_SOURCE
    root.appendChild(s)
    s.remove()
  } catch (_) {}
}

installBridge()

/* ---------------------------------------------------------- scroll -- */

function maxScroll () {
  const doc = document.documentElement
  const body = document.body
  const height = Math.max(
    doc ? doc.scrollHeight : 0,
    body ? body.scrollHeight : 0
  )
  return Math.max(0, height - window.innerHeight)
}

function currentRatio () {
  const max = maxScroll()
  return max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0
}

// Two guards, because a time window alone is not enough: pages with
// `html { scroll-behavior: smooth }` keep firing scroll events long after
// SUPPRESS_MS, and those late intermediate positions used to travel back
// to the panel that started the gesture and drag it backwards.
function emitScroll () {
  queuedScroll = false
  if (performance.now() < suppressScrollUntil) return
  if (appliedY !== null && Math.abs(window.scrollY - appliedY) <= 2) return
  appliedY = null
  ipcRenderer.sendToHost('scroll', {
    ratio: currentRatio(),
    y: window.scrollY,
    max: maxScroll()
  })
}

window.addEventListener('scroll', () => {
  if (queuedScroll) return
  queuedScroll = true
  requestAnimationFrame(emitScroll)
}, { passive: true, capture: true })

/* `scrollTo(x, y)` is the same as `behavior: 'auto'`, which resolves to the
 * element's computed `scroll-behavior`. On any page that sets
 * `html { scroll-behavior: smooth }` — most Tailwind/Next templates do —
 * every synced scroll turned into a 300-800ms animation. 'instant' is the
 * one value that overrides the CSS. */
function nativeScrollTo (target) {
  try {
    window.scrollTo({ top: target, left: 0, behavior: 'instant' })
  } catch (_) {
    window.scrollTo(0, target)
  }
}

function applyScroll (target) {
  appliedY = Math.round(target)
  suppressScrollUntil = performance.now() + SUPPRESS_MS
  if (document.documentElement.hasAttribute(BRIDGE_READY)) {
    document.documentElement.setAttribute(BRIDGE_TARGET, String(target))
    window.dispatchEvent(new Event(BRIDGE_EVENT))
    return
  }
  nativeScrollTo(target)
}

ipcRenderer.on('scroll', (_e, { mode, ratio, y }) => {
  applyScroll(mode === 'absolute' ? y : ratio * maxScroll())
})

/* ----------------------------------------------------------- input -- */

/* Positional, so it survives a reload and does not depend on class names a
 * framework may hash differently. Inspect mode and the capture both address
 * elements by these paths: the capture has to find the same element again in
 * a freshly loaded copy of the page. */
function selectorFor (el) {
  if (!el || el.nodeType !== 1) return null
  const parts = []
  let node = el
  let depth = 0
  while (node && node.nodeType === 1 && node !== document.documentElement && depth < 60) {
    let index = 1
    let sibling = node
    while ((sibling = sibling.previousElementSibling)) {
      if (sibling.tagName === node.tagName) index++
    }
    parts.unshift(node.tagName.toLowerCase() + ':nth-of-type(' + index + ')')
    node = node.parentElement
    depth++
  }
  return parts.length ? 'html > ' + parts.join(' > ') : null
}

function resolve (selector) {
  if (!selector) return null
  try { return document.querySelector(selector) } catch (_) { return null }
}

document.addEventListener('click', (e) => {
  if (replaying || !e.isTrusted) return
  const selector = selectorFor(e.target)
  if (!selector) return
  const rect = e.target.getBoundingClientRect()
  ipcRenderer.sendToHost('click', {
    selector,
    offsetX: rect.width ? (e.clientX - rect.left) / rect.width : 0.5,
    offsetY: rect.height ? (e.clientY - rect.top) / rect.height : 0.5
  })
}, true)

ipcRenderer.on('click', (_e, { selector, offsetX, offsetY }) => {
  const el = resolve(selector)
  if (!el) return
  const rect = el.getBoundingClientRect()
  replaying = true
  try {
    el.dispatchEvent(new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: rect.left + rect.width * (offsetX || 0.5),
      clientY: rect.top + rect.height * (offsetY || 0.5)
    }))
  } finally {
    setTimeout(() => { replaying = false }, 0)
  }
})

document.addEventListener('input', (e) => {
  if (replaying || !e.isTrusted) return
  const el = e.target
  if (!el || !('value' in el)) return
  if (el.type === 'password') return
  const selector = selectorFor(el)
  if (!selector) return
  ipcRenderer.sendToHost('input', {
    selector,
    value: el.value,
    checked: !!el.checked
  })
}, true)

ipcRenderer.on('input', (_e, { selector, value, checked }) => {
  const el = resolve(selector)
  if (!el || !('value' in el)) return
  replaying = true
  try {
    if (el.type === 'checkbox' || el.type === 'radio') el.checked = checked
    else el.value = value
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  } finally {
    setTimeout(() => { replaying = false }, 0)
  }
})

/* ---------------------------------------------------- inspect mode -- */

/* Hover highlights, click selects, and once something is selected every
 * further hover measures the distance to it. The panel with the values lives
 * up in the host; from here we only send what it needs.
 *
 * Shift-click fixes the element being measured against, and while it is fixed
 * the hover stops moving it. Without that there is no way to *photograph* a
 * distance: the measured pair is set by the pointer, and on the way out of the
 * frame to reach the capture button the pointer crosses half the page and
 * reassigns it to whatever it left over.
 *
 * The listeners are attached and detached with the mode rather than left in
 * place behind a flag: while the mode is off a previewed page carries nothing
 * of ours but the scroll bridge it already had.
 *
 * The selected/hovered pair is deliberately *not* cleared when the pointer
 * leaves the page. It is what the screenshot redraws, and by the time anyone
 * reaches the capture button the pointer is long gone from the frame. */

/* The drawing and the property reading live in src/inspect.js, which cannot
 * be `require`d from a sandboxed preload: the host hands us the source and it
 * is evaluated here, in this isolated world. Same source the capture injects,
 * so the overlay in a screenshot is drawn by exactly the same code.
 *
 * new Function rather than a <script> in the page: an isolated world is not
 * subject to the page's own Content-Security-Policy, and a page that forbids
 * inline script would otherwise silently have no inspect mode. */
let inspect = null

ipcRenderer.on('inspect-source', (_e, source) => {
  if (inspect) return
  try {
    const factory = new Function(source + ';return PreviewerInspect')
    inspect = factory()
  } catch (err) {
    ipcRenderer.sendToHost('inspect-broken', { reason: String((err && err.message) || err) })
  }
})

const ins = {
  on: false, sel: null, hov: null, lock: false,
  k: 1, x: 0, y: 0, last: 0, tail: null, raw: false,
  /* Dónde se clicó por última vez y si toca enseñar ahí la pista. Quién decide
   * eso es el host, que es quien recuerda si ya se enseñó; aquí sólo se pinta.
   * Vive en el estado y no en una variable del momento porque la capa se
   * repinta entera con cada movimiento del ratón: sin esto, la pista duraría
   * hasta el píxel siguiente. */
  px: 0, py: 0, tip: null, tipTail: null
}

const TIP_MS = 6000

function insTip (show) {
  if (!show && !ins.tip) return
  clearTimeout(ins.tipTail)
  ins.tip = show ? { x: ins.px, y: ins.py } : null
  if (show) ins.tipTail = setTimeout(() => { insTip(false) }, TIP_MS)
  insRedraw()
}

/* Ni una vuelta por requestAnimationFrame, a diferencia del scroll de arriba.
 *
 * La primera versión encolaba el trabajo en un rAF y se protegía con un flag
 * para no encolar dos veces. Si el frame deja de recibir fotogramas —la
 * ventana tapada, sin foco, el compositor en reposo— ese callback no llega
 * nunca, el flag se queda puesto y a partir de ahí todos los movimientos del
 * ratón se descartan: el hover se muere en silencio hasta apagar y encender el
 * modo. Salía intermitente, que es lo peor que podía pasar.
 *
 * Un reloj no se puede atascar. A 25 Hz —40 ms de periodo, que es lo que mide
 * INS_MS— sobra para un puntero, y el trabajo
 * —medir un elemento y mover seis divs— es de sobra más barato que eso. El
 * temporizador de cola es para que la última posición no se quede sin pintar
 * cuando el movimiento acaba dentro de la ventana de espera. */
const INS_MS = 40

function insReport () {
  const info = inspect.overlay({
    select: ins.sel, hover: ins.hov, k: ins.k, locked: ins.lock, tip: ins.tip
  })
  ipcRenderer.sendToHost('inspect-hover', {
    label: info.label,
    dist: info.dist,
    why: info.why,
    locked: ins.lock,
    hoverPath: ins.hov && ins.hov !== ins.sel ? selectorFor(ins.hov) : null
  })
}

function insTrack () {
  clearTimeout(ins.tail)
  ins.last = performance.now()
  if (!ins.on || !inspect) return
  const found = inspect.pick(ins.x, ins.y, ins.raw)
  if (!found || found === ins.hov) return
  ins.hov = found
  insReport()
}

const insMove = (e) => {
  /* Con la pareja fijada el ratón deja de mandar: puede pasearse por donde
   * quiera hasta el botón de capturar sin llevarse la medida por delante. */
  if (ins.lock) return
  ins.x = e.clientX
  ins.y = e.clientY
  ins.raw = e.altKey
  clearTimeout(ins.tail)
  ins.tail = setTimeout(insTrack, INS_MS + 5)
  const now = performance.now()
  if (now - ins.last < INS_MS) return
  ins.last = now
  insTrack()
}

/* Swallowed wholesale: a click that reaches the page navigates away from the
 * thing being inspected, and mousedown alone is enough to start a carousel
 * drag or open a menu. The pointer events go too — a page listening on those
 * instead sees the same gesture. */
const insSwallow = (e) => {
  if (!e.isTrusted || !inspect) return
  e.preventDefault()
  e.stopPropagation()
  if (e.type !== 'click') return
  const found = inspect.pick(e.clientX, e.clientY, e.altKey)
  if (!found) return

  /* Mayúsculas y no Opción: `alt` ya significa «el elemento literal, sin subir
   * al ancestro que comparte caja» en pick(), y ese matiz hace falta también
   * al fijar el segundo elemento. */
  if (e.shiftKey && ins.sel) {
    // Ya lo ha hecho: la pista no tiene nada más que decir.
    insTip(false)
    // Sobre el propio elemento seleccionado, el gesto suelta el pestillo.
    ins.lock = found !== ins.sel
    ins.hov = ins.lock ? found : ins.sel
    insReport()
    return
  }

  ins.sel = found
  ins.hov = found
  ins.lock = false
  ins.px = e.clientX
  ins.py = e.clientY
  /* La pista se va al primer clic siguiente: si estás clicando, o ya lo has
   * entendido o estás a otra cosa. El host dirá si hay que volver a ponerla. */
  insTip(false)
  inspect.overlay({ select: ins.sel, hover: null, k: ins.k })
  ipcRenderer.sendToHost('inspect-pick', {
    data: inspect.read(found),
    path: selectorFor(found)
  })
}

const insKey = (e) => {
  if (ins.tip) insTip(false)
  if (e.key !== 'Escape') return
  e.preventDefault()
  e.stopPropagation()
  ipcRenderer.sendToHost('inspect-escape', { hadSelection: !!ins.sel, hadLock: ins.lock })
}

/* Aquí no hace falta reloj ninguno, al contrario que en el hover: el navegador
 * ya emite los eventos de scroll al ritmo de los fotogramas, y si el frame no
 * está pintando tampoco hay nada que ver — un resalte desfasado en una ventana
 * que no se dibuja es invisible, y en cuanto vuelve a pintar el siguiente
 * evento lo recoloca. */
const insRedraw = () => {
  if (!ins.on || !inspect || (!ins.sel && !ins.hov)) return
  inspect.overlay({
    select: ins.sel, hover: ins.hov, k: ins.k, locked: ins.lock, tip: ins.tip
  })
}

const INS_EVENTS = [
  ['mousemove', insMove],
  ['click', insSwallow],
  ['mousedown', insSwallow],
  ['mouseup', insSwallow],
  ['pointerdown', insSwallow],
  ['pointerup', insSwallow],
  ['keydown', insKey]
]

/* La pista de la primera vez, que la pide el host tras el primer clic. */
ipcRenderer.on('inspect-tip', () => {
  if (!ins.on || !inspect || !ins.sel) return
  insTip(true)
})

ipcRenderer.on('inspect', (_e, { on, k, clear }) => {
  /* Sin el módulo no hay modo posible, y quedarse encendido sin responder es
   * peor que no encenderse: que lo sepa el host. */
  if (on && !inspect) {
    ipcRenderer.sendToHost('inspect-broken', { reason: 'no llegó el código del inspector' })
    return
  }
  ins.k = k || 1
  if (clear === 'lock') {
    ins.lock = false
    ins.hov = ins.sel
  } else if (clear) {
    ins.sel = null
    ins.hov = null
    ins.lock = false
    ins.tip = null
  }

  if (on && !ins.on) {
    ins.on = true
    for (const [type, fn] of INS_EVENTS) {
      window.addEventListener(type, fn, { capture: true, passive: false })
    }
    window.addEventListener('scroll', insRedraw, { capture: true, passive: true })
    window.addEventListener('resize', insRedraw)
  } else if (!on && ins.on) {
    ins.on = false
    for (const [type, fn] of INS_EVENTS) window.removeEventListener(type, fn, true)
    window.removeEventListener('scroll', insRedraw, true)
    window.removeEventListener('resize', insRedraw)
    clearTimeout(ins.tail)
    clearTimeout(ins.tipTail)
    ins.sel = null
    ins.hov = null
    ins.lock = false
    ins.tip = null
    if (inspect) inspect.clear()
    return
  }
  insRedraw()
})

/* --------------------------------------------- canvas gestures/keys -- */

// The wheel lands inside the page, so plain scrolling stays native and
// direct. Only the zoom modifier is handed back up to the canvas.
window.addEventListener('wheel', (e) => {
  if (!(e.metaKey || e.ctrlKey)) return
  e.preventDefault()
  ipcRenderer.sendToHost('wheel-zoom', {
    deltaY: e.deltaY,
    clientX: e.clientX,
    clientY: e.clientY,
    ctrlKey: e.ctrlKey,
    metaKey: e.metaKey
  })
}, { passive: false, capture: true })

function isTyping (el) {
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
}

window.addEventListener('keydown', (e) => {
  const typing = isTyping(document.activeElement)
  if (e.code === 'Space' && !typing) {
    e.preventDefault()
    ipcRenderer.sendToHost('pan-key', { down: true })
    return
  }
  if (e.metaKey || e.ctrlKey) {
    ipcRenderer.sendToHost('shortcut', {
      key: e.key, meta: e.metaKey, ctrl: e.ctrlKey, shift: e.shiftKey
    })
  }
}, true)

window.addEventListener('keyup', (e) => {
  if (e.code === 'Space') ipcRenderer.sendToHost('pan-key', { down: false })
}, true)

window.addEventListener('blur', () => {
  ipcRenderer.sendToHost('pan-key', { down: false })
})

/* ------------------------------------------------------------ ready -- */

window.addEventListener('DOMContentLoaded', () => {
  installBridge() // in case <html> did not exist yet at document_start
  ipcRenderer.sendToHost('page-ready', {
    title: document.title,
    href: location.href
  })
})
