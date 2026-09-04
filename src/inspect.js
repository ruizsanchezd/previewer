/* Inspect mode — the part that has to run *inside* a previewed page.
 *
 * It is loaded three different ways, which is what the preamble below is for:
 *
 *   - <script>-tagged by the renderer, which needs `sections()` to paint the
 *     floating panel (and nothing else in here).
 *   - read off disk as source by main.cjs and injected into the offscreen
 *     capture window, so a screenshot can redraw the very same overlay on a
 *     page that knows nothing about what was selected.
 *   - the same source, handed to guest/guest.cjs over IPC and evaluated there
 *     for the live frame. A <webview> preload runs sandboxed, where `require`
 *     reaches Electron's own modules and nothing else — a project file is not
 *     loadable from there, and trying takes the whole preload down with it.
 *
 * Hence a file that is standalone and free of imports: whatever it needs, it
 * has to carry.
 *
 * Two jobs live here, and only these two:
 *   read()    — computed properties of an element, already in the units a
 *               designer reads (px, hex), grouped for display.
 *   overlay() — the boxes, the labels and the distance measurements, drawn
 *               with plain divs in a fixed-position layer.
 *
 * Everything is addressed by selector path rather than by element reference,
 * because the capture resolves it in a freshly loaded copy of the page.
 */

;(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  root.PreviewerInspect = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const LAYER_ID = '__previewer_inspect'
  const ACCENT = '#4c8dff'
  const HOVER = '#f0f'

  /* ------------------------------------------------------------ paths -- */

  /* Elements when this runs live, selector paths when it runs inside a
   * capture. The paths are the click sync's, built by the guest — see
   * selectorFor() there. */
  function resolve (selector) {
    if (!selector) return null
    if (typeof selector !== 'string') return selector
    try { return document.querySelector(selector) } catch (_) { return null }
  }

  /* ------------------------------------------------------------- pick -- */

  const INLINEISH = { A: 1, BUTTON: 1, LABEL: 1, SUMMARY: 1 }

  function sameBox (a, b) {
    return Math.abs(a.width - b.width) < 1 && Math.abs(a.height - b.height) < 1 &&
           Math.abs(a.top - b.top) < 1 && Math.abs(a.left - b.left) < 1
  }

  /* What the pointer is over, but the element you *think* you are pointing at.
   *
   * Two corrections on top of elementFromPoint, both aimed at the same thing:
   * frameworks wrap what you see in layers you cannot see.
   *
   *   - A parent drawn at exactly the same box is the same surface as far as
   *     anyone looking at the screen is concerned, so climb to the outermost
   *     one. Otherwise clicking a button hands you an invisible <span>.
   *   - A parent that only holds this text and is inline or interactive is the
   *     thing with the padding, the background and the border radius — the
   *     button, not the label inside it. Blocks are left alone: a <div> around
   *     a <p> is a layout box, and stealing the click from the <p> would hide
   *     the typography, which is the main reason to be here.
   *
   * Alt/Option skips both and gives the literal deepest element.
   */
  function pick (x, y, raw) {
    let el = null
    try { el = document.elementFromPoint(x, y) } catch (_) { return null }
    if (!el || el.nodeType !== 1) return null
    if (raw || el === document.body || el === document.documentElement) return el

    let node = el
    for (let i = 0; i < 12; i++) {
      const up = node.parentElement
      if (!up || up === document.body || up === document.documentElement) break
      if (sameBox(node.getBoundingClientRect(), up.getBoundingClientRect())) { node = up; continue }
      break
    }

    for (let i = 0; i < 4; i++) {
      const up = node.parentElement
      if (!up || up === document.body || up === document.documentElement) break
      const text = (node.textContent || '').trim()
      if (!text || (up.textContent || '').trim() !== text) break
      const display = getComputedStyle(up).display
      const inline = display.indexOf('inline') === 0 || INLINEISH[up.tagName]
      if (!inline) break
      const a = node.getBoundingClientRect()
      const b = up.getBoundingClientRect()
      if (b.width - a.width > 48 || b.height - a.height > 48) break
      node = up
    }
    return node
  }

  /* ------------------------------------------------------------- read -- */

  const px = (n) => Math.round(n * 10) / 10 + 'px'

  /* Chromium serialises sRGB colours as rgb()/rgba(); anything authored in a
   * wider space (oklch, color()) computes to itself and is shown verbatim
   * rather than mangled into a hex it is not. */
  function hex (value) {
    const m = String(value || '').match(/^rgba?\(([^)]+)\)$/)
    if (!m) return value || null
    const parts = m[1].split(/[,/\s]+/).filter((s) => s !== '').map(Number)
    if (parts.length < 3 || parts.some(isNaN)) return value
    const [r, g, b] = parts
    const a = parts.length > 3 ? parts[3] : 1
    if (a === 0) return 'transparent'
    const out = '#' + [r, g, b].map((n) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0')).join('')
    return a < 1 ? out + ' · ' + Math.round(a * 100) + '%' : out
  }

  function isClear (value) {
    return !value || value === 'transparent' || /^rgba\([^)]*,\s*0\s*\)$/.test(value)
  }

  function parseRgb (value) {
    const m = String(value || '').match(/^rgba?\(([^)]+)\)$/)
    if (!m) return null
    const p = m[1].split(/[,/\s]+/).filter((x) => x !== '').map(Number)
    if (p.length < 3 || p.some(isNaN)) return null
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }
  }

  /* Contraste WCAG entre el texto y el fondo que tiene detrás.
   *
   * Es el número que convierte «este gris se ve raro» en «este gris incumple»,
   * y lo podemos dar gratis porque ya tenemos los dos colores. Sólo cuando se
   * puede saber de verdad: con un texto semitransparente o un fondo que es un
   * degradado o una imagen, el color real depende de lo que haya debajo y
   * cualquier cifra que diéramos sería inventada. */
  function channel (c) {
    const v = c / 255
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
  }

  function luminance (c) {
    return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b)
  }

  function contrast (textColor, bgColor, sizePx, weight) {
    const fg = parseRgb(textColor)
    const bg = parseRgb(bgColor)
    if (!fg || !bg || fg.a < 1 || bg.a < 1) return null
    const l1 = luminance(fg)
    const l2 = luminance(bg)
    const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
    // El umbral baja con el tamaño: texto grande se lee con menos contraste.
    const large = sizePx >= 24 || (sizePx >= 18.66 && weight >= 700)
    const aa = large ? 3 : 4.5
    const aaa = large ? 4.5 : 7
    return {
      ratio: Math.round(ratio * 100) / 100,
      level: ratio >= aaa ? 'AAA' : ratio >= aa ? 'AA' : 'insuficiente'
    }
  }

  /* La pila de fuentes computada trae las diez familias del reset de Tailwind
   * y llena media columna sin decir nada. Lo que se quiere saber es cuál se
   * está usando: la primera de la lista que exista de verdad. */
  const GENERIC = /^(system-ui|-apple-system|BlinkMacSystemFont|sans-serif|serif|monospace|cursive|fantasy|ui-monospace|ui-sans-serif|ui-serif|ui-rounded|math|emoji)$/i

  function usedFont (stack) {
    const list = String(stack || '').split(',')
      .map((x) => x.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean)
    for (const family of list) {
      if (GENERIC.test(family)) return { family, rest: list.length - 1 }
      try {
        if (document.fonts.check('16px "' + family + '"')) return { family, rest: list.length - 1 }
      } catch (_) {}
    }
    return { family: list[0] || String(stack || ''), rest: Math.max(0, list.length - 1) }
  }

  /* The element's own background is what someone editing the CSS will change,
   * so it is what gets reported — but on a transparent element that reads as
   * "no colour" when there plainly is one on screen, so the ancestor actually
   * painting it is reported alongside, flagged as inherited.
   *
   * Tres desenlaces, y hacen falta los tres: un color, «hay algo detrás y no
   * se puede saber qué» —una imagen o un degradado, donde el color real es el
   * del píxel— y «no hay nada», que es el caso de canvasBg(). */
  function effectiveBg (el) {
    let node = el.parentElement
    for (let i = 0; i < 40 && node; i++) {
      const cs = getComputedStyle(node)
      if (cs.backgroundImage !== 'none') return { unknown: true }
      if (!isClear(cs.backgroundColor)) return { color: cs.backgroundColor, from: label(node) }
      node = node.parentElement
    }
    return null
  }

  /* Cuando nadie de la cadena pinta un fondo, el que se ve es el del navegador,
   * y el contraste se puede calcular igual de bien: es el caso de cualquier
   * prototipo que no se molesta en poner un `background` en el `body`, y hasta
   * ahora era justo donde el panel se callaba.
   *
   * Sólo en claro, donde el lienzo es blanco y no hay duda. En oscuro el color
   * lo elige Chromium, no está expuesto en ninguna propiedad, y una cifra de
   * contraste sacada de un color adivinado es peor que ninguna cifra. */
  function canvasBg () {
    let scheme = 'normal'
    try { scheme = String(getComputedStyle(document.documentElement).colorScheme || 'normal') } catch (_) {}
    let dark = scheme === 'dark'
    if (!dark && scheme.indexOf('dark') > -1) {
      try { dark = matchMedia('(prefers-color-scheme: dark)').matches } catch (_) {}
    }
    return dark ? null : 'rgb(255, 255, 255)'
  }

  /* Cómo se llama un elemento en el resalte y en las cotas.
   *
   * La etiqueta está para *identificar* lo que estás señalando, no para
   * describirlo: encima del elemento, con el ratón puesto, ya lo estás viendo.
   * Con una web de utilidades, enseñar tres clases daba cosas como
   * `a.inline--block.bg-foreground.text-background…`, que es ruido tapando
   * justo lo que quieres mirar. La lista completa de clases sigue entera en el
   * panel, que es donde se consulta.
   *
   * Por orden de lo que mejor identifica a ojos de una persona: el id, una
   * clase que sea un nombre y no un ajuste, el texto que lleva dentro si es
   * corto —«a «Start free»» se entiende sin pensar— y si no, la etiqueta sola.
   */
  const CAP = 30

  /* Una clase de utilidad no nombra el elemento, lo configura. No hace falta
   * conocer Tailwind para distinguirlas: tienen forma de ajuste —una variante
   * con `:`, un valor numérico o de escala al final, o una de las palabras de
   * maquetación de siempre—. Un `hero-note` o un `btn-primary` no encaja en
   * ninguna de las tres. */
  const BARE = new RegExp('^(flex|grid|block|inline|inline-block|inline-flex|contents|hidden' +
    '|absolute|relative|fixed|sticky|static|isolate|container|truncate|uppercase|lowercase' +
    '|capitalize|italic|underline|antialiased|rounded|border|shadow|transition|group|peer' +
    '|visible|invisible|grow|shrink|sr-only|clearfix|active|open|show)$')
  /* `row` y `col` sueltos son del grid de Bootstrap, o sea ajustes, pero como
   * *nombre* `div.row` identifica mejor que `div` a secas, que es para lo que
   * sirve la etiqueta. Sus variantes con valor (`col-md-6`) las coge PREFIX. */

  const PREFIX = new RegExp('^(text|bg|border|rounded|font|leading|tracking|items|justify|self' +
    '|place|content|gap|space|divide|w|h|min|max|size|p|px|py|pt|pr|pb|pl|m|mx|my|mt|mr|mb|ml' +
    '|inset|top|right|bottom|left|z|opacity|shadow|ring|outline|cursor|overflow|object|aspect' +
    '|col|row|order|basis|flex|grid|translate|scale|rotate|skew|origin|duration|delay|ease' +
    '|animate|from|via|to|fill|stroke|backdrop|blur|whitespace|break|list|align|select|snap' +
    '|float|clear|table|indent|decoration|underline|line|placeholder|caret|accent|will|d)-')

  /* El prefijo basta: la lista de arriba *es* el vocabulario de las utilidades,
   * y lo que va detrás puede ser cualquier cosa (`gap-4`, `bg-foreground`,
   * `font-semibold`, `items-center`). Pedir además un número dejaba pasar
   * media biblioteca.
   *
   * Se equivoca a veces —un `content-wrapper` o un `list-item` de nombre
   * propio los tomará por ajustes—, y está bien que se equivoque hacia ese
   * lado: cuando descarta una clase buena, la etiqueta cae en el texto del
   * elemento o en su tag, que siguen identificándolo. Al revés, lo que sale es
   * el ruido que veníamos a quitar. */
  function isUtility (name) {
    if (name.indexOf(':') > -1) return true            // hover:, md:, dark:…
    if (/^css-[a-z0-9]{4,}$/i.test(name)) return true  // hash de emotion/styled
    // `inline--block` y compañía: hay quien duplica el guion.
    const flat = name.replace(/-{2,}/g, '-')
    return BARE.test(flat) || PREFIX.test(flat)
  }

  function cap (text) {
    return text.length > CAP ? text.slice(0, CAP - 1) + '…' : text
  }

  function label (el) {
    if (!el || el.nodeType !== 1) return ''
    const tag = el.tagName.toLowerCase()
    if (el.id) return cap(tag + '#' + el.id)

    const classes = (el.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean)
    const named = classes.find((name) => !isUtility(name))
    // Los CSS Modules cuelgan un hash del nombre real: `Card_root__x7f2a`.
    if (named) return cap(tag + '.' + named.replace(/__[A-Za-z0-9]{5,}$/, ''))

    const text = (el.textContent || '').trim().replace(/\s+/g, ' ')
    if (text && text.length <= 24 && isTextual(el)) return tag + ' «' + text + '»'
    return tag
  }

  /* Los ceros van sin unidad: `0 0 16px 0` se lee de un vistazo y `0px 0px
   * 16px 0px` hay que descifrarlo. */
  const unit = (n) => (n === 0 ? '0' : px(n))

  function sideList (cs, prefix) {
    const v = ['top', 'right', 'bottom', 'left'].map((s) => parseFloat(cs[prefix + '-' + s]) || 0)
    if (v.every((n) => n === 0)) return null
    if (v.every((n) => n === v[0])) return px(v[0])
    if (v[0] === v[2] && v[1] === v[3]) return unit(v[0]) + ' ' + unit(v[1])
    return v.map(unit).join(' ')
  }

  /* Antes se leía sólo `border-top`, y un elemento con nada más que un
   * `border-bottom` —un separador, una pestaña activa, un input subrayado—
   * salía en el panel como si no tuviera borde ninguno. Callar sobre algo que
   * se está viendo en la captura es el peor fallo que puede tener esto. */
  function borders (cs) {
    const each = ['top', 'right', 'bottom', 'left'].map((side) => ({
      side,
      w: parseFloat(cs['border-' + side + '-width']) || 0,
      style: cs['border-' + side + '-style'],
      color: cs['border-' + side + '-color']
    })).filter((b) => b.w > 0 && b.style !== 'none')
    if (!each.length) return null

    const desc = (b) => px(b.w) + ' ' + b.style + ' ' + hex(b.color)
    const uniform = each.length === 4 && each.every((b) =>
      b.w === each[0].w && b.style === each[0].style && b.color === each[0].color)
    return {
      text: uniform ? desc(each[0]) : each.map((b) => b.side + ' ' + desc(b)).join(' · '),
      // Un solo tono en la muestra de color: el del primer lado que hay.
      raw: each[0].color
    }
  }

  function radius (cs) {
    const v = ['top-left', 'top-right', 'bottom-right', 'bottom-left']
      .map((c) => cs['border-' + c + '-radius'])
    if (v.every((s) => parseFloat(s) === 0)) return null
    // Misma regla que en sideList: `6px 6px 0 0` se lee de un vistazo y
    // `6px 6px 0px 0px` hay que descifrarlo.
    const clean = v.map((s) => (parseFloat(s) === 0 ? '0' : s))
    return clean.every((s) => s === clean[0]) ? clean[0] : clean.join(' ')
  }

  function hasOwnText (el) {
    for (const node of el.childNodes) {
      if (node.nodeType === 3 && node.nodeValue.trim()) return true
    }
    return false
  }

  /* Un enlace o un botón cuyo texto vive en un <span> de dentro no tiene nodos
   * de texto propios, pero es tan «texto» como el resto: sus propiedades de
   * tipografía y su color son los que heredará ese span. Un único criterio
   * para las tres cosas —tipo, color de texto y tipografía— porque enseñar el
   * cuerpo y el contraste pero no el color era incoherente. */
  function isTextual (el) {
    return hasOwnText(el) || INLINEISH[el.tagName] === 1
  }

  /* Un valor de CSS que puede venir larguísimo —un degradado con seis paradas,
   * un grid-template de doce columnas— y que en el panel y en la columna de la
   * captura empuja todo lo demás fuera de la vista. Se corta: lo que importa es
   * de qué tipo es y cómo empieza. */
  function brief (value, max) {
    const text = String(value || '')
    return text.length > max ? text.slice(0, max - 1) + '…' : text
  }

  /* Cómo reparte el sitio un contenedor de flex o grid, y qué papel juega su
   * hijo dentro. Es la discusión de siempre entre diseño y desarrollo —«esto
   * tenía que ir centrado», «esto no tenía que crecer»— y hasta ahora el panel
   * sólo decía «display: flex» y te dejaba a medias. Cada línea sale sólo si
   * dice algo: los valores por defecto se callan. */
  function layout (el, cs) {
    const flex = cs.display.indexOf('flex') > -1
    const grid = cs.display.indexOf('grid') > -1
    const out = { flow: null, align: null, tracks: null, item: null }

    if (flex || grid) {
      const flow = []
      if (flex && cs.flexDirection !== 'row') flow.push(cs.flexDirection)
      if (flex && cs.flexWrap !== 'nowrap') flow.push(cs.flexWrap)
      out.flow = flow.length ? flow.join(' · ') : null

      const j = cs.justifyContent
      const a = cs.alignItems
      out.align = [
        j && j !== 'normal' && j !== 'flex-start' ? 'justify: ' + j : null,
        a && a !== 'normal' && a !== 'stretch' ? 'align: ' + a : null
      ].filter(Boolean).join(' · ') || null

      /* El computado son píxeles reales, no el `1fr` que se escribió: para
       * comprobar si una columna mide lo que debía es justo lo que se quiere. */
      if (grid && cs.gridTemplateColumns && cs.gridTemplateColumns !== 'none') {
        out.tracks = brief(cs.gridTemplateColumns, 90)
      }
    }

    const up = el.parentElement ? getComputedStyle(el.parentElement) : null
    const inside = up && (up.display.indexOf('flex') > -1 || up.display.indexOf('grid') > -1)
    // `0 1 auto` es el valor por defecto; Chromium lo serializa también como
    // `0 auto` según de dónde venga.
    if (inside && cs.flex && cs.flex !== '0 1 auto' && cs.flex !== '0 auto') out.item = cs.flex
    return out
  }

  function read (el) {
    if (!el || el.nodeType !== 1) return null
    const cs = getComputedStyle(el)
    const r = el.getBoundingClientRect()
    const classes = (el.getAttribute('class') || '').trim()
    const textual = isTextual(el)
    const flow = layout(el, cs)

    const data = {
      label: label(el),
      tag: el.tagName.toLowerCase(),
      classes: classes.length > 180 ? classes.slice(0, 180) + '…' : classes,
      kind: el.tagName === 'IMG' || el.tagName === 'SVG' ? 'image'
        : textual ? 'text' : 'box',
      box: {
        w: Math.round(r.width * 10) / 10,
        h: Math.round(r.height * 10) / 10,
        display: cs.display,
        position: cs.position === 'static' ? null : cs.position,
        padding: sideList(cs, 'padding'),
        margin: sideList(cs, 'margin'),
        gap: cs.display.indexOf('flex') >= 0 || cs.display.indexOf('grid') >= 0
          ? (parseFloat(cs.gap) ? cs.gap : null) : null,
        radius: radius(cs),
        flow: flow.flow,
        align: flow.align,
        tracks: flow.tracks,
        flex: flow.item,
        /* Un `z-index` sólo hace algo sobre un elemento posicionado, y cuando
         * hace algo es la explicación de por qué esto tapa aquello. */
        z: cs.position !== 'static' && cs.zIndex !== 'auto' ? cs.zIndex : null
      },
      text: null,
      contrast: null,
      colors: {
        text: textual ? hex(cs.color) : null,
        bg: isClear(cs.backgroundColor) ? null : hex(cs.backgroundColor),
        bgRaw: isClear(cs.backgroundColor) ? null : cs.backgroundColor,
        inherited: null,
        image: cs.backgroundImage !== 'none' ? brief(cs.backgroundImage, 120) : null
      },
      border: null,
      borderRaw: null,
      shadow: cs.boxShadow !== 'none' ? cs.boxShadow : null,
      opacity: cs.opacity !== '1' ? cs.opacity : null,
      image: null,
      bgUnknown: false
    }

    const edge = borders(cs)
    if (edge) {
      data.border = edge.text
      data.borderRaw = edge.raw
    }

    if (!data.colors.bg) {
      const inherited = effectiveBg(el)
      if (inherited && inherited.color) {
        data.colors.inherited = { value: hex(inherited.color), raw: inherited.color, from: inherited.from }
      }
      data.bgUnknown = !!(inherited && inherited.unknown)
    }

    if (textual) {
      const size = parseFloat(cs.fontSize) || 0
      const height = parseFloat(cs.lineHeight)
      const font = usedFont(cs.fontFamily)
      data.text = {
        family: font.family,
        rest: font.rest,
        /* Lo que el CSS pide primero, que no es siempre lo que se pinta ni
         * mucho menos: Chrome ignora `-apple-system` y `ui-sans-serif` —son
         * palabras de Safari y de la especificación que no implementa— y se
         * cae al siguiente de la pila. Enseñar sólo eso era enseñar la palabra
         * menos informativa de todas. La de verdad la trae `rendered`, que
         * pregunta al navegador qué fuente ha usado. */
        declared: (cs.fontFamily.split(',')[0] || '').trim().replace(/^["']|["']$/g, ''),
        rendered: null,
        stack: cs.fontFamily,
        size: cs.fontSize,
        /* El px es de quien programa y el ratio de quien diseña; los dos
         * caben en la misma línea. */
        lineHeight: cs.lineHeight === 'normal'
          ? 'normal'
          : cs.lineHeight + (size && height ? ` (${Math.round((height / size) * 100) / 100})` : ''),
        weight: cs.fontWeight,
        letterSpacing: cs.letterSpacing === 'normal' ? '0' : cs.letterSpacing,
        align: cs.textAlign,
        transform: cs.textTransform !== 'none' ? cs.textTransform : null
      }
      const behind = isClear(cs.backgroundColor)
        ? (data.colors.inherited
            ? data.colors.inherited.raw
            : (data.bgUnknown ? null : canvasBg()))
        : cs.backgroundColor
      /* Sólo si detrás hay un color plano: sobre un degradado o una imagen,
       * el contraste real depende del píxel y cualquier cifra sería inventada. */
      const gradient = data.colors.image && /gradient|url\(/.test(data.colors.image)
      data.contrast = behind && !gradient
        ? contrast(cs.color, behind, size, parseInt(cs.fontWeight, 10) || 400)
        : null
    }

    /* An <img> shown larger than the file behind it is the single most common
     * thing a QA screenshot is trying to prove, and it is invisible in the
     * numbers above. Same reasoning as the capture's own asset warning. */
    if (el.tagName === 'IMG' && el.naturalWidth) {
      const per = r.width ? el.naturalWidth / r.width : 0
      data.image = {
        natural: el.naturalWidth + '×' + el.naturalHeight,
        ratio: Math.round(per * 100) / 100,
        src: (el.currentSrc || el.src || '').split('/').pop().slice(0, 60)
      }
    }
    return data
  }

  /* Display groups. The renderer paints these as DOM and the capture writes
   * them into the info strip, so the grouping and the wording are decided
   * once, here, and the two never drift apart. */
  function sections (data) {
    if (!data) return []
    const out = []
    const box = [{ k: 'Tamaño', v: data.box.w + ' × ' + data.box.h }]
    if (data.box.padding) box.push({ k: 'Padding', v: data.box.padding })
    if (data.box.margin) box.push({ k: 'Margin', v: data.box.margin })
    if (data.box.gap) box.push({ k: 'Gap', v: data.box.gap })
    if (data.box.radius) box.push({ k: 'Radio', v: data.box.radius })
    /* `display: block` y `position: static` son el valor por defecto de casi
     * todo: una fila que casi nunca dice nada es una fila que se salta.
     *
     * En filas separadas y no en una: iban juntas bajo el rótulo «Display», y
     * en un elemento que sólo tenía `position` que contar la fila se leía como
     * «Display: relative», que no existe. */
    const display = data.box.display === 'block' || data.box.display === 'inline'
      ? null : data.box.display
    if (display) box.push({ k: 'Display', v: display })
    if (data.box.position) box.push({ k: 'Posición', v: data.box.position })
    if (data.box.flow) box.push({ k: 'Dirección', v: data.box.flow })
    if (data.box.align) box.push({ k: 'Alineación', v: data.box.align })
    if (data.box.tracks) box.push({ k: 'Columnas', v: data.box.tracks })
    if (data.box.flex) box.push({ k: 'Flex', v: data.box.flex })
    if (data.box.z) box.push({ k: 'z-index', v: data.box.z })
    if (data.opacity) box.push({ k: 'Opacidad', v: data.opacity })
    out.push({ title: 'Caja', rows: box })

    if (data.text) {
      out.push({
        title: 'Tipografía',
        rows: [
          /* La fuente que pinta va primero y lo que pide el CSS queda como
           * etiqueta. Las dos cosas hacen falta y no son la misma pregunta:
           * «Helvetica [-apple-system]» se lee como «pediste eso y te han
           * dado esto», que es justo el fallo que se quiere ver. */
          data.text.rendered && data.text.rendered !== data.text.declared
            ? { k: 'Familia', v: data.text.rendered, tag: data.text.declared, note: data.text.stack }
            : { k: 'Familia', v: data.text.rendered || data.text.family, note: data.text.stack },
          { k: 'Tamaño', v: data.text.size },
          { k: 'Interlineado', v: data.text.lineHeight },
          { k: 'Peso', v: data.text.weight },
          { k: 'Espaciado', v: data.text.letterSpacing }
        ].concat(data.text.transform ? [{ k: 'Transform', v: data.text.transform }] : [])
      })
    }

    const colors = []
    if (data.colors.text) colors.push({ k: 'Texto', v: data.colors.text, swatch: data.colors.text })
    if (data.colors.bg) colors.push({ k: 'Fondo', v: data.colors.bg, swatch: data.colors.bgRaw })
    else if (data.colors.inherited) {
      colors.push({
        k: 'Fondo',
        v: data.colors.inherited.value,
        tag: 'heredado',
        note: 'de ' + data.colors.inherited.from,
        swatch: data.colors.inherited.raw
      })
    }
    if (data.border) colors.push({ k: 'Borde', v: data.border, swatch: data.borderRaw })
    if (data.colors.image) colors.push({ k: 'Imagen de fondo', v: data.colors.image })
    if (data.shadow) colors.push({ k: 'Sombra', v: data.shadow })
    if (data.contrast) {
      colors.push({
        k: 'Contraste',
        v: data.contrast.ratio + ':1',
        tag: data.contrast.level,
        bad: data.contrast.level === 'insuficiente'
      })
    }
    if (colors.length) out.push({ title: 'Color', rows: colors })

    if (data.image) {
      out.push({
        title: 'Imagen',
        rows: [
          { k: 'Origen', v: data.image.natural + ' (' + data.image.ratio + '× lo mostrado)' },
          { k: 'Archivo', v: data.image.src }
        ]
      })
    }

    if (data.classes) out.push({ title: 'Clases', rows: [{ k: 'class', v: data.classes }] })
    return out
  }

  /* ---------------------------------------------------------- overlay -- */

  /* Every size in here is multiplied by --pk, the inverse of the canvas zoom,
   * so a label stays the same size on screen at 40% as at 100%. In a capture
   * the factor is 1 and the whole thing collapses to plain pixels. */
  const CSS = `
    #${LAYER_ID} { position: fixed; inset: 0; z-index: 2147483646; pointer-events: none;
      font: 400 calc(11px * var(--pk)) / 1.35 ui-monospace, SFMono-Regular, Menlo, monospace;
      color: #fff; -webkit-font-smoothing: antialiased; }
    #${LAYER_ID} * { box-sizing: border-box; }
    #${LAYER_ID} .pi-box { position: absolute; }
    /* Contorno y nada más: un velo de color encima falsea el color del
     * elemento, que es justo lo que la captura va a demostrar. */
    #${LAYER_ID} .pi-sel { outline: calc(2px * var(--pk)) solid ${ACCENT}; }
    #${LAYER_ID} .pi-hov { outline: calc(1.5px * var(--pk)) dashed ${HOVER}; }
    /* Fijado con Mayúsculas: trazo continuo. El discontinuo significa «esto es
     * donde está el ratón ahora mismo», y un elemento fijado ya no depende del
     * ratón —ni existe ratón dentro de una captura—. */
    #${LAYER_ID} .pi-lock { outline: calc(2px * var(--pk)) solid ${HOVER}; }
    #${LAYER_ID} .pi-aim { outline: calc(1.5px * var(--pk)) dashed ${ACCENT}; }
    #${LAYER_ID} .pi-chip { position: absolute; white-space: nowrap;
      padding: calc(2px * var(--pk)) calc(5px * var(--pk));
      border-radius: calc(3px * var(--pk)); background: ${ACCENT};
      font-weight: 600; letter-spacing: .01em; }
    #${LAYER_ID} .pi-chip.pi-h { background: ${HOVER}; }
    #${LAYER_ID} .pi-chip.pi-size { background: #111; }
    #${LAYER_ID} .pi-line { position: absolute; background: ${HOVER}; }
    #${LAYER_ID} .pi-guide { position: absolute; background: ${HOVER}66; }
  `

  function layer (k) {
    let el = document.getElementById(LAYER_ID)
    if (!el) {
      el = document.createElement('div')
      el.id = LAYER_ID
      const style = document.createElement('style')
      style.textContent = CSS
      el.appendChild(style)
      ;(document.body || document.documentElement).appendChild(el)
    }
    el.style.setProperty('--pk', String(k || 1))
    el.hidden = false
    /* Late-arriving page content can outrank us in the stacking order, and a
     * page that re-renders its body can drop us out of the DOM entirely. */
    const host = document.body || document.documentElement
    if (el.parentElement !== host) host.appendChild(el)
    else if (el.nextElementSibling) host.appendChild(el)
    return el
  }

  function add (parent, cls, style, text) {
    const el = document.createElement('div')
    el.className = cls
    el.setAttribute('style', style)
    if (text != null) el.textContent = text
    parent.appendChild(el)
    return el
  }

  const box = (r) => `left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px`

  function overlaps (a, b) {
    return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
  }

  /* La etiqueta quiere ir justo encima de su caja, pero arriba del viewport no
   * hay «encima», y con dos elementos pegados las dos etiquetas caen en el
   * mismo sitio y se tapan —que es el ruido que se venía a quitar—. Así que
   * hay cuatro sitios candidatos, por orden de preferencia, y se coge el
   * primero que quepa y que no pise a una etiqueta ya puesta. */
  function chip (root, r, text, hover, placed) {
    const el = add(root, 'pi-chip' + (hover ? ' pi-h' : ''), 'left:0;top:0;visibility:hidden', text)
    const box = el.getBoundingClientRect()
    const w = box.width
    const h = box.height
    const gap = 3

    const left = Math.max(2, r.left)
    const right = Math.max(2, Math.min(r.right - w, window.innerWidth - w - 2))
    const above = r.top - h - gap
    const below = r.bottom + gap
    const inside = r.top + gap

    const spots = [
      [left, above], [left, below], [right, above], [right, below], [left, inside]
    ]
    let pick = null
    for (const [x, y] of spots) {
      if (y < 0 || y + h > window.innerHeight) continue
      const candidate = { left: x, top: y, right: x + w, bottom: y + h }
      if ((placed || []).some((other) => overlaps(candidate, other))) continue
      pick = candidate
      break
    }
    if (!pick) {
      const y = above > 0 ? above : inside
      pick = { left, top: y, right: left + w, bottom: y + h }
    }

    el.setAttribute('style', `left:${pick.left}px;top:${pick.top}px;visibility:visible`)
    if (placed) placed.push(pick)
    return el
  }

  function sizeChip (root, r, placed) {
    if (!r || r.width < 46 || r.height < 18) return
    const el = add(root, 'pi-chip pi-size', 'left:0;top:0;visibility:hidden',
      Math.round(r.width) + ' × ' + Math.round(r.height))
    const b = el.getBoundingClientRect()
    const left = r.left + (r.width - b.width) / 2
    const top = r.top + (r.height - b.height) / 2
    el.setAttribute('style', `left:${left}px;top:${top}px;visibility:visible`)
    if (placed) placed.push({ left, top, right: left + b.width, bottom: top + b.height })
  }

  function overlapCentre (a0, a1, b0, b1) {
    const from = Math.max(a0, b0)
    const to = Math.min(a1, b1)
    if (to > from) return (from + to) / 2
    return ((a0 + a1) / 2 + (b0 + b1) / 2) / 2
  }

  /* Un elemento que sigue existiendo pero no ocupa nada —lo han escondido, o
   * la copia recién cargada lo dibuja vacío— daba un resalte de 0×0 invisible
   * y una captura que informaba de que había salido bien. Que no salga y que
   * el aviso lo diga. */
  function rectOf (el) {
    if (!el) return null
    const r = el.getBoundingClientRect()
    return r.width || r.height ? r : null
  }

  function contains (outer, inner) {
    return inner.left >= outer.left - 1 && inner.right <= outer.right + 1 &&
           inner.top >= outer.top - 1 && inner.bottom <= outer.bottom + 1
  }

  /* De dónde sale esa distancia.
   *
   * El número dice cuánto y no dice por qué, y el minuto que de verdad cuesta
   * arreglarlo es encontrar la propiedad que hay que tocar. Cuando los dos
   * elementos son hermanos, casi siempre es una de tres: el `gap` del
   * contenedor, un margen de uno de los dos, o —si uno está dentro del otro—
   * el `padding` del de fuera.
   *
   * Sólo se dice cuando las cuentas cuadran al píxel. Si el hueco no lo
   * explica ninguna de las tres, se calla: una atribución equivocada manda a
   * alguien a cambiar la línea que no era, y eso es peor que no decir nada. */
  const FIT = 1.5

  function origin (selEl, hovEl, axis, distance) {
    if (!selEl || !hovEl || !selEl.parentElement) return null
    const parent = selEl.parentElement
    if (hovEl.parentElement !== parent) return null

    const cs = getComputedStyle(parent)
    const spaced = cs.display.indexOf('flex') > -1 || cs.display.indexOf('grid') > -1
    const gapProp = axis === 'x' ? 'column-gap' : 'row-gap'
    const gap = spaced ? (parseFloat(cs[gapProp]) || 0) : 0

    if (gap && Math.abs(gap - distance) < FIT) {
      return { tag: 'gap', text: gapProp + ': ' + px(gap) + ' de ' + label(parent) }
    }

    const ra = selEl.getBoundingClientRect()
    const rb = hovEl.getBoundingClientRect()
    const firstIsSel = axis === 'x' ? ra.left <= rb.left : ra.top <= rb.top
    const first = firstIsSel ? selEl : hovEl
    const second = firstIsSel ? hovEl : selEl
    const endProp = axis === 'x' ? 'margin-right' : 'margin-bottom'
    const startProp = axis === 'x' ? 'margin-left' : 'margin-top'
    const m1 = parseFloat(getComputedStyle(first)[endProp]) || 0
    const m2 = parseFloat(getComputedStyle(second)[startProp]) || 0

    if (spaced) {
      // En flex y grid los márgenes no colapsan: se suman, y al gap.
      if ((m1 || m2) && Math.abs(gap + m1 + m2 - distance) < FIT) {
        const parts = []
        if (gap) parts.push(gapProp + ': ' + px(gap))
        if (m1) parts.push(endProp + ': ' + px(m1) + ' de ' + label(first))
        if (m2) parts.push(startProp + ': ' + px(m2) + ' de ' + label(second))
        return { tag: gap ? 'gap + margen' : 'margen', text: parts.join(' + ') }
      }
      return null
    }

    /* En flujo normal los márgenes verticales colapsan y gana el mayor, que es
     * exactamente la cuenta que nadie se espera: 24 y 16 pegados no son 40. */
    const winner = m1 >= m2 ? [endProp, m1, first] : [startProp, m2, second]
    if (winner[1] && Math.abs(winner[1] - distance) < FIT) {
      return {
        tag: 'margen',
        text: winner[0] + ': ' + px(winner[1]) + ' de ' + label(winner[2]) +
          (axis === 'y' && m1 && m2 ? ' (los dos colapsan y gana el mayor)' : '')
      }
    }
    return null
  }

  /* Para el caso anidado: la distancia a cada borde del contenedor suele ser
   * su padding, y decirlo ahorra el viaje de ir a comprobarlo. */
  function insetOrigin (outerEl, innerEl, side, distance) {
    if (!outerEl || !innerEl || innerEl.parentElement !== outerEl) return null
    const value = parseFloat(getComputedStyle(outerEl)['padding-' + side]) || 0
    if (!value || Math.abs(value - distance) >= FIT) return null
    return { tag: 'padding', text: 'padding-' + side + ': ' + px(value) + ' de ' + label(outerEl) }
  }

  /* The measurement, Figma-style: a gap on each axis where the two boxes are
   * apart, and the four insets when one is inside the other — which is the
   * common case (an element and its container) and the one people actually
   * want a number for. */
  function gaps (a, b) {
    if (contains(a, b) || contains(b, a)) {
      const outer = contains(a, b) ? a : b
      const inner = contains(a, b) ? b : a
      return {
        kind: 'inset',
        inner,
        outer,
        insets: {
          top: inner.top - outer.top,
          left: inner.left - outer.left,
          right: outer.right - inner.right,
          bottom: outer.bottom - inner.bottom
        }
      }
    }
    /* Con `>` en vez de `>=`, dos elementos pegados —el borde de uno es el
     * borde del otro, que es justo lo que se quiere comprobar cuando falta un
     * margen— no separaban en ningún eje y la cota salía como «solapados».
     * Pegados es 0px, y 0px es un dato. */
    const out = { kind: 'gap', x: null, y: null }
    if (b.left >= a.right) out.x = { from: a.right, to: b.left }
    else if (a.left >= b.right) out.x = { from: b.right, to: a.left }
    if (b.top >= a.bottom) out.y = { from: a.bottom, to: b.top }
    else if (a.top >= b.bottom) out.y = { from: b.bottom, to: a.top }
    if (out.x) out.x.at = overlapCentre(a.top, a.bottom, b.top, b.bottom)
    if (out.y) out.y.at = overlapCentre(a.left, a.right, b.left, b.right)
    return out
  }

  /* Las cotas van con su decimal, no redondeadas al entero.
   *
   * Redondear es tentador y es justo lo que no se puede hacer aquí: la
   * pregunta que trae a alguien a medir un hueco es «¿son 32 o son 36?», y un
   * 35,6 disfrazado de 36 contesta que sí a la pregunta equivocada. px() ya
   * enseña el decimal sólo cuando lo hay, así que en un hueco limpio no
   * aparece ruido ninguno.
   */

  /* La cifra de una cota va en el centro de su línea, y si ahí hay ya una
   * etiqueta se desliza *por* la línea hasta que quepa: sigue diciendo lo
   * mismo un poco más allá, y taparse unas a otras no dice nada. `along` es la
   * dirección en la que puede correr sin salirse de la medida. */
  function value (root, x, y, text, placed, along, span) {
    const el = add(root, 'pi-chip pi-h', 'left:0;top:0;visibility:hidden', text)
    const b = el.getBoundingClientRect()
    const step = (along === 'x' ? b.width : b.height) + 6

    /* Y si la etiqueta es más larga que la cota que mide, se aparta de entrada.
     * Centrada la tapaba entera —un hueco de 36px debajo de un «36px · gap» de
     * 150— y lo que quedaba en la imagen era una cifra flotando en medio de la
     * nada, sin la línea que dice contra qué mide. */
    const covers = span != null && (along === 'x' ? b.height : b.width) > span - 4
    const spots = covers ? [1, -1, 2, -2, 3, -3, 0] : [0, 1, -1, 2, -2, 3, -3]

    let pick = null
    for (const k of spots) {
      const cx = along === 'x' ? x + k * step : x
      const cy = along === 'x' ? y : y + k * step
      const box = {
        left: Math.max(2, cx - b.width / 2),
        top: Math.max(2, cy - b.height / 2)
      }
      box.right = box.left + b.width
      box.bottom = box.top + b.height
      if ((placed || []).some((other) => overlaps(box, other))) continue
      pick = box
      break
    }
    if (!pick) {
      pick = { left: Math.max(2, x - b.width / 2), top: Math.max(2, y - b.height / 2) }
      pick.right = pick.left + b.width
      pick.bottom = pick.top + b.height
    }
    el.setAttribute('style', `left:${pick.left}px;top:${pick.top}px;visibility:visible`)
    if (placed) placed.push(pick)
  }

  function drawGaps (root, a, b, k, placed, selEl, hovEl) {
    const g = gaps(a, b)
    const t = Math.max(1, 1 * k)
    const out = []
    const why = []

    if (g.kind === 'inset') {
      const { inner, outer, insets } = g
      const cx = inner.left + inner.width / 2
      const cy = inner.top + inner.height / 2
      /* Cada cota sale del centro del elemento de dentro hacia un borde del
       * de fuera: es como se leen en Figma, y así las cuatro se cruzan en un
       * punto en vez de solaparse por las esquinas. */
      const spans = {
        top: [cx, outer.top, t, insets.top],
        bottom: [cx, inner.bottom, t, insets.bottom],
        left: [outer.left, cy, insets.left, t],
        right: [inner.right, cy, insets.right, t]
      }
      // `a` es la caja seleccionada, así que quien contiene a quien también
      // se sabe en elementos, no sólo en rectángulos.
      const outerEl = contains(a, b) ? selEl : hovEl
      const innerEl = contains(a, b) ? hovEl : selEl
      for (const side of ['top', 'bottom', 'left', 'right']) {
        const n = Math.round(insets[side])
        if (n <= 0) continue
        const [x, y, w, h] = spans[side]
        const from = insetOrigin(outerEl, innerEl, side, insets[side])
        add(root, 'pi-line', `left:${x}px;top:${y}px;width:${w}px;height:${h}px`)
        value(root, x + w / 2, y + h / 2, px(insets[side]) + (from ? ' · ' + from.tag : ''),
          placed, w > h ? 'y' : 'x', w > h ? w : h)
        out.push(side + ' ' + px(insets[side]))
        if (from) why.push(from.text)
      }
      return { parts: out, why }
    }

    /* La cota va del borde de una caja al de la otra, y las dos guías
     * finas prolongan esos bordes a lo alto (o a lo ancho) de las dos: sin
     * ellas, una línea suelta en medio de la nada no dice contra qué mide. */
    const top = Math.min(a.top, b.top)
    const bottom = Math.max(a.bottom, b.bottom)
    const left = Math.min(a.left, b.left)
    const right = Math.max(a.right, b.right)

    if (g.x) {
      const w = g.x.to - g.x.from
      const from = origin(selEl, hovEl, 'x', w)
      add(root, 'pi-line', `left:${g.x.from}px;top:${g.x.at}px;width:${w}px;height:${t}px`)
      for (const x of [g.x.from, g.x.to]) {
        add(root, 'pi-guide', `left:${x}px;top:${top}px;width:${t}px;height:${bottom - top}px`)
      }
      // Línea horizontal: la cifra puede subir o bajar sin dejar de medirla.
      value(root, (g.x.from + g.x.to) / 2, g.x.at,
        px(w) + (from ? ' · ' + from.tag : ''), placed, 'y', w)
      out.push('horizontal ' + px(w))
      if (from) why.push(from.text)
    }
    if (g.y) {
      const h = g.y.to - g.y.from
      const from = origin(selEl, hovEl, 'y', h)
      add(root, 'pi-line', `left:${g.y.at}px;top:${g.y.from}px;width:${t}px;height:${h}px`)
      for (const y of [g.y.from, g.y.to]) {
        add(root, 'pi-guide', `left:${left}px;top:${y}px;width:${right - left}px;height:${t}px`)
      }
      value(root, g.y.at, (g.y.from + g.y.to) / 2,
        px(h) + (from ? ' · ' + from.tag : ''), placed, 'x', h)
      out.push('vertical ' + px(h))
      if (from) why.push(from.text)
    }
    if (!g.x && !g.y) out.push('se solapan')
    return { parts: out, why }
  }

  /* Paints the whole overlay from scratch on every call — a handful of divs,
   * so it is cheaper than working out what changed, and it is the only way
   * the boxes stay glued to their elements while the page scrolls or reflows.
   *
   * `select` and `hover` are elements when this runs live and selector paths
   * when it runs inside a capture. */
  function overlay (spec) {
    const k = spec.k || 1
    const sel = resolve(spec.select)
    const hov = resolve(spec.hover)
    const root = layer(k)
    for (const el of [...root.children]) { if (el.tagName !== 'STYLE') el.remove() }

    const selRect = rectOf(sel)
    const hovRect = hov && hov !== sel ? rectOf(hov) : null
    if (!selRect && !hovRect) return { ok: false, dist: null }

    const info = { ok: true, dist: null, why: null, label: hovRect ? label(hov) : null }

    /* El orden importa, y no es el obvio.
     *
     * Primero las cajas, después las cifras de las cotas y al final las
     * etiquetas de los elementos. Al contrario, la cifra se quedaba debajo de
     * una etiqueta ancha y no encontraba hueco por donde escapar: una medida
     * tiene que estar sobre su línea para significar algo, mientras que el
     * nombre de un elemento se lee igual de bien un poco más arriba o más
     * abajo. Manda apartarse el que puede. */
    const placed = []
    /* Tres lecturas del segundo resalte: discontinuo azul es «esto es lo que
     * estás señalando», discontinuo magenta «esto es contra lo que se está
     * midiendo mientras el ratón esté ahí», y continuo magenta «esto está
     * fijado». Sin nada seleccionado no hay nada que medir. */
    const measuring = !!selRect

    if (selRect) add(root, 'pi-box pi-sel', box(selRect))
    if (hovRect) {
      add(root, 'pi-box ' + (spec.locked ? 'pi-lock' : measuring ? 'pi-hov' : 'pi-aim'),
        box(hovRect))
    }

    if (selRect && hovRect) {
      const measured = drawGaps(root, selRect, hovRect, k, placed, sel, hov)
      info.dist = measured.parts.join(' · ')
      info.why = measured.why.join(' · ')
    } else {
      sizeChip(root, hovRect || selRect, placed)
    }

    if (selRect) chip(root, selRect, label(sel), false, placed)
    /* El segundo elemento no tiene sitio en el panel —a propósito: es una
     * referencia, no lo que se está inspeccionando— así que en una captura no
     * queda constancia de cuánto mide. Cabe en su etiqueta y ahí resuelve la
     * pregunta que sigue a «están a 36px»: «¿y cuánto mide ese?». */
    if (hovRect) {
      // Sin selección ya lo ha dicho sizeChip en medio de la caja: repetirlo
      // en la etiqueta sería el mismo dato dos veces a dos centímetros.
      const size = measuring
        ? ' · ' + Math.round(hovRect.width) + '×' + Math.round(hovRect.height)
        : ''
      chip(root, hovRect, label(hov) + size, measuring, placed)
    }
    return info
  }

  function hide () {
    const el = document.getElementById(LAYER_ID)
    if (el) el.hidden = true
  }

  function clear () {
    const el = document.getElementById(LAYER_ID)
    if (el) el.remove()
  }

  return { resolve, pick, read, sections, label, overlay, hide, clear }
})
