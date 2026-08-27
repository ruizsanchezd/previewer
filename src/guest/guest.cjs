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
