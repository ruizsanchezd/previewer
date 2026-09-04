# Previewer

Lienzo multi-dispositivo para revisar una misma página en varias resoluciones a la vez,
con scroll, clicks y navegación sincronizados. Pensado para revisar `localhost` mientras
desarrollas, pero funciona con cualquier URL.

## Arrancar

```bash
npm install
npm start
```

Si `npm install` avisa de que el postinstall de Electron está bloqueado
(`npm warn allow-scripts`), ejecuta `npm approve-scripts` y vuelve a instalar:
es el paso que descarga el binario de Electron.

`npm start` ejecuta el código de `src/` tal cual: es la app de verdad, no una versión de
pruebas. **Para desarrollar no hace falta reinstalar nada nunca.** El `.app` de
Aplicaciones es una foto congelada de la última vez que se compiló y se queda como esté
hasta que se vuelva a compilar a mano; ver "Publicar una versión". Para cambios de
interfaz basta ⌘R en la ventana, sin reiniciar.

Ojo: la app instalada y `npm start` **comparten la carpeta de datos** (macOS no distingue
`previewer` de `Previewer`), así que los sets y el estado guardados son los mismos en las
dos. Cómodo, pero si se cambia el formato de lo que se guarda en `localStorage`, se cambia
también para la app instalada.

## Cómo funciona

Cada panel es un `<webview>` de Electron con un preload propio (`src/guest/guest.cjs`)
que corre dentro de la página. Ese script es el que reporta el scroll, los clicks y los
inputs al proceso renderer, que los reenvía al resto de paneles. Por eso el sync funciona
con cualquier URL: no dependemos de iframes ni de que la web permita ser embebida.

- `src/main.cjs` — proceso principal; ventana, emulación (esquema de color, idioma) vía CDP
  y las capturas.
- `src/png.cjs` — lector/escritor PNG mínimo; une los tramos de una captura en streaming,
  en vertical o pegando la columna de datos a la derecha (el PNG resultante es el paso
  intermedio hacia el JPEG final).
- `src/preload.cjs` — puente seguro entre el renderer y el proceso principal.
- `src/guest/guest.cjs` — script inyectado en cada página previsualizada.
- `src/inspect.js` — modo inspección: lee las propiedades de un elemento y dibuja el
  resalte y las cotas. Es el único archivo que corre en tres sitios a la vez (el frame
  vivo, la captura y el renderer), y el porqué está explicado en su cabecera.
- `src/renderer/` — el lienzo: paneles, pan/zoom, barra de herramientas, menús.

## Atajos y gestos

| Gesto | Acción |
|---|---|
| Rueda sobre una página | Scroll sincronizado en todos los paneles |
| `⌘` + rueda | Zoom del lienzo |
| `espacio` + arrastrar (o botón central) | Mover el lienzo |
| Arrastrar sobre el fondo | Recuadro de selección; `⇧` suma a la selección |
| `Esc` | Deseleccionar (en modo inspección: suelta lo fijado, luego la selección, luego sale) |
| `Alt` señalando, en modo inspección | El elemento exacto bajo el cursor, sin heurística |
| `⇧` + clic, en modo inspección | Fija el elemento contra el que se mide, para poder capturar la distancia |
| `Enter` en la nota de la captura | Captura, con nota o sin ella (`Esc` cierra la nota sin capturar) |
| Arrastrar el título de un panel | Mover ese panel, o toda la selección si está dentro |
| Arrastrar la esquina inferior derecha | Redimensionar el panel |
| `⌘R` | Recargar todos los paneles |
| `⌘0` | Encajar todo en pantalla |
| `⌘L` | Foco en la barra de URL |
| `⌘+` / `⌘-` | Zoom del lienzo |
| `⇧⌘D` | Poner todos los paneles en modo oscuro |

## Barra superior

- **Scroll / Clicks / Nav** — activan o desactivan cada tipo de sincronización.
- **% / px** — scroll proporcional (cada panel a su propio porcentaje, recomendado cuando
  el móvil es mucho más largo que el desktop) o absoluto (los mismos píxeles en todos).
- **+ Dispositivo** — presets de móvil, tablet, escritorio y breakpoints, o un tamaño
  personalizado escribiendo `1280x800`.
- **Sets** — guarda la composición actual con un nombre y recupérala luego.

## Menú del lienzo (clic derecho sobre el fondo)

Reordenar en fila, recargar todo y **limpiar caché y recargar** (borra caché, cookies y
storage de la sesión compartida, para volver a ver la web como un visitante nuevo:
banner de consentimiento, onboarding, logout, flags guardados).

## Por panel (menú `⋯`)

Esquema de color (auto/claro/oscuro), idioma, zoom de página, movimiento reducido,
duplicar, **inspeccionar elementos**, DevTools, recargar, quitar y **screenshot**. Lo que
no está en `auto` aparece como etiqueta en el título del panel.

El título del panel se encoge con el zoom: por debajo de 210px de ancho en pantalla
suelta las medidas, y por debajo de 108px deja sólo el `⋯`, que lleva todas las
acciones. Así los títulos nunca se solapan entre paneles.

## Inspeccionar elementos

La retícula del título de cada panel enciende el **modo inspección** en ese panel, a lo
CSS Peeper: pasas el ratón por encima y se resalta el elemento con su selector; clicas y
un panel flotante te da sus propiedades ya calculadas. Cada valor es un botón: al pulsarlo
se copia.

Lo que sale, y por qué eso y no la lista entera de propiedades computadas:

- **Caja** — tamaño, padding, margin, gap y radio, y en un contenedor de flex o grid
  también **cómo reparte el sitio**: dirección, `justify`/`align`, y los anchos reales de
  las columnas de un grid (el computado son píxeles, no el `1fr` que se escribió, que es
  justo lo que hace falta para comprobar si una columna mide lo que debía). Si el elemento
  es *hijo* de un flex o un grid, su `flex`, que es lo que explica por qué mide lo que
  mide. Todo eso sólo cuando no es el valor por defecto: `display: block`, `position:
  static`, `flex-direction: row` y compañía se callan, porque una fila que casi nunca
  informa es una fila que se aprende a saltar. El `z-index` aparece sólo si el elemento
  está posicionado, que es cuando hace algo.
- **Tipografía** — la **fuente que está pintando de verdad**, y como etiqueta la que
  pide el CSS: «Helvetica `-apple-system`» se lee como «pediste eso y te han dado esto».
  Las dos cosas hacen falta y no son la misma pregunta.

  Hace falta preguntárselo al navegador —hay un comando del protocolo de DevTools que
  dice qué fuente de sistema ha usado para los glifos de un nodo— porque el CSS computado
  no lo sabe, y lo que dice engaña: **Chrome ignora `-apple-system` y `ui-sans-serif`**,
  que son palabras de Safari y de la especificación que no implementa, y se cae al
  siguiente de la pila. Un `system-ui` o un `BlinkMacSystemFont` sí le valen y dan San
  Francisco; sin ellos, lo que sale es Helvetica pelada. Enseñar la primera palabra de la
  pila era enseñar precisamente la que el navegador no mira.

  De paso sale gratis el caso que más importa: si pides `JetBrains Mono` y la columna
  dice «Menlo `JetBrains Mono`», la fuente no está cargando.

  El interlineado va en px y en ratio, que es como lo piensa cada uno de los dos lados.
- **Color** — texto, fondo (y si el elemento es transparente, el que hay detrás, marcado
  como heredado), borde, sombra y el **contraste WCAG** del texto contra su fondo, con su
  nivel AA/AAA. Es el número que convierte «este gris se ve raro» en «este gris incumple»,
  y sale gratis porque los dos colores ya están ahí.

  El borde se lee **lado a lado**, no sólo el de arriba: un separador, una pestaña activa
  o un input subrayado no tienen más que `border-bottom`, y antes salían como si no
  tuvieran borde ninguno. Si los cuatro lados coinciden se resume en uno.

  El contraste no se calcula cuando no se puede saber de verdad: sobre un degradado, una
  imagen o un texto semitransparente, el color real depende del píxel y cualquier cifra
  sería inventada. Sí se calcula cuando **nadie pinta un fondo** y el que se ve es el
  blanco del navegador —el caso de cualquier prototipo que no se molesta en poner un
  `background` en el `body`, donde antes el panel se callaba justo cuando más fácil era
  contestar—. En modo oscuro sin fondo declarado se calla: el color del lienzo lo elige
  Chromium, no está en ninguna propiedad, y un contraste sacado de un color adivinado es
  peor que ningún contraste.
- **Imagen** — el tamaño del archivo frente al que se muestra. Es lo que explica un logo
  borroso, y no se ve en ninguna otra cifra.
La lista de clases se enseñaba abajo y se ha quitado: en una web de utilidades era un
párrafo de treinta clases seguidas que no contestaba a ninguna pregunta, y lo que cada una
hace ya sale computado —en píxeles y en hex— en su sección. El nombre que identifica al
elemento sigue arriba, en la cabecera del panel.

Las secciones van **separadas entre sí** más de lo que pide el texto. El panel no se lee
de arriba abajo: se busca un bloque concreto, y el hueco es lo que deja ver dónde acaba
uno y empieza el siguiente sin tener que leerlos.

Con un elemento seleccionado, **pasar el ratón por otro mide la distancia entre los dos**.
Si están separados sale la separación de cada eje; si uno está dentro del otro, las cuatro
distancias a sus bordes. Es la manera corta de explicarle a alguien que ese botón está a
32px cuando debería estar a 24.

Las cotas van **con su decimal cuando lo hay**. Redondear al entero es tentador y es justo
lo que no se puede hacer: la pregunta que trae a alguien a medir un hueco es «¿son 32 o son
36?», y un 35,6 disfrazado de 36 contesta que sí a la pregunta equivocada. En un hueco
limpio el decimal no aparece, así que no añade ruido.

Mientras mides, la cifra vive **dentro del frame**, junto a la línea: es donde estás
mirando, y un recuadro cambiando al lado de las propiedades del elemento seleccionado —a
cada movimiento del ratón— era ruido en la única parte del panel que no debería moverse.
**Al panel sube sólo la medida fijada.**

**`⇧` + clic sobre el segundo elemento fija la medida.** Mientras está fijada el ratón deja
de mandar —el segundo resalte pasa de trazo discontinuo a continuo, y aparece en el panel
marcada como «fijado»—, así que puedes irte hasta el botón de capturar sin llevártela por
delante. Es la única forma de **fotografiar** un espaciado concreto: sin fijar, al salir del
frame el puntero cruza media página y reasigna la pareja a lo que pisó por el borde. Otro
`⇧` + clic la mueve a un tercer elemento, `⇧` + clic sobre el propio seleccionado la suelta,
y `Esc` también.

El segundo elemento no aparece en el panel a propósito: es una referencia, no lo que estás
inspeccionando. Lo único que lleva es **su tamaño en la etiqueta**, porque en una captura
no queda constancia de él en ningún otro sitio y es la pregunta que sigue a «están a 36px».

Y cuando se puede saber, **dice de dónde sale esa distancia**: `column-gap: 32px de
div.row`, `margin-top: 48px de h2`, `padding-left: 24px de section.hero`. El número dice
cuánto y no dice por qué, y el minuto que de verdad cuesta arreglarlo es encontrar la
propiedad que hay que tocar. Mira las tres cosas que la explican casi siempre —el `gap`
del contenedor cuando son hermanos, un margen de uno de los dos, el `padding` del de
fuera cuando uno está dentro— y **sólo lo dice si las cuentas cuadran al píxel**: si el
hueco no lo explica ninguna, se calla, porque una atribución equivocada manda a alguien a
cambiar la línea que no era y eso es peor que no decir nada.

Un detalle que agradece cualquiera: en flujo normal los márgenes verticales colapsan y
gana el mayor, así que un `margin-bottom: 24px` seguido de un `margin-top: 16px` son 24px
y no 40. Cuando pasa, lo dice.

### Que el gesto se cuente solo

Un atajo que no está en ningún sitio no existe, así que la app lo cuenta ella, en dos
tiempos y sin repetirse para siempre.

**La primera selección de tu vida** saca un globo **pegado al cursor**, ahí mismo donde
acabas de clicar: «Mayúsculas + clic para seleccionar un segundo elemento». Sale una vez y
nunca más —se recuerda entre sesiones—, se va a los seis segundos o al siguiente clic o
tecla, lo que pase antes, y no dice para qué sirve a propósito: en cuanto pruebas aparece
la cota y eso se explica solo mucho mejor que una frase. Va en gris oscuro y no en el azul
ni en el magenta del inspector, que son los colores con los que se habla de un elemento.

**Después, la misma idea vive en el panel**, en el hueco donde va a salir la medida: una
línea en gris que aparece con cada elemento que seleccionas y **desaparece para siempre en
cuanto fijas tu primera distancia**. El disparador de callarse es haberlo usado, no haber
pasado diez veces ni haber cambiado de sesión: quien ya lo sabe deja de leerlo el mismo día
y a quien no le ha hecho falta todavía le sigue estando ahí el día que la necesite.

Y va en ese hueco y no en el estado vacío del panel —donde estaba— porque un gesto se
explica donde se puede hacer y donde va a salir el resultado. En el estado vacío se leía
antes de tener nada seleccionado, o sea antes de que significara nada, y justo al
seleccionar —cuando pasaba a significar algo— es cuando se iba de la pantalla.

- Mientras el modo está activo **los clics no llegan a la página**: no navega, no abre
  menús y no se propaga al resto de paneles. Sólo selecciona.
- **`Esc` va por pasos**: suelta lo fijado, luego la selección y, a la última, sale del
  modo. Funciona igual con el foco dentro del frame o en el lienzo.
- **`Alt` mientras señalas** salta la heurística y te da el elemento exacto bajo el
  cursor. Por defecto se sube al elemento que *ves*: si un framework envuelve el texto de
  un botón en tres capas invisibles, lo que quieres es el botón, no el `<span>` de dentro.
- **La etiqueta del resalte identifica, no describe.** Con el ratón encima ya estás viendo
  el elemento, así que sobra enumerarle las clases: en una web de utilidades salían cosas
  como `a.inline--block.bg-foreground.text-background…` tapando justo lo que querías
  mirar. Por orden de lo que mejor identifica algo a ojos de una persona: el id, una clase
  que sea un nombre y no un ajuste, el texto que lleva dentro si es corto —`a «Start
  free»` se entiende sin pensar— y si no, la etiqueta sola.

  Distinguir una clase-nombre de una clase-ajuste no necesita conocer Tailwind: las de
  ajuste tienen forma de ajuste (una variante con `:`, o un prefijo del vocabulario de
  siempre —`bg-`, `text-`, `mt-`, `items-`…—). Se equivoca hacia el lado bueno: si
  descarta una clase que sí era un nombre, la etiqueta cae en el texto o en el tag, que
  siguen identificando; al revés, lo que sale es el ruido que veníamos a quitar.
- **Las etiquetas se apartan entre ellas**, y quien se aparta es la etiqueta, nunca la
  cifra de una cota: una medida tiene que estar sobre su línea para significar algo,
  mientras que el nombre de un elemento se lee igual un poco más arriba o más abajo. Con
  dos elementos a 20px, si no, las tres cosas caían en la misma banda.
- Un panel a la vez, y no se guarda al cerrar la app: es una herramienta de un rato, y
  arrancar con un frame que no responde a los clics sería un misterio.
- El resalte **no tiñe** el elemento seleccionado, sólo lo bordea: un velo de color encima
  falsearía justo el color que la captura va a demostrar.

Lo único que se inyecta en la página es una capa de `<div>`s que se borra al salir; las
propiedades son valores computados, así que no hay que interpretar el CSS de nadie.

## Screenshot

Dos opciones en el menú `⋯` de cada panel, y las dos guardan un JPEG en
`~/Descargas/previewer/`. Al pulsar el aviso que sale abajo se revela el archivo en el
Finder.

- **Screenshot de la página** — la página completa, de una pieza.
- **Screenshot del viewport** — sólo lo que ves, en el punto de scroll en el que estés.

No hay nada que elegir: **siempre `@2x`, siempre JPEG**. El porqué de las dos cosas está
más abajo.

Arriba llevan una franja con el dispositivo, el viewport, la URL, el tamaño real de la
página (o el offset de scroll), la densidad, las variantes activas y la fecha.

### Capturar en modo inspección

El botón **Capturar** del panel de inspección guarda el viewport con el resalte, las cotas
y la distancia fijada dibujados, y **una columna de datos pegada a la derecha** con
la cabecera y las propiedades del elemento. Es una imagen que se explica sola: se la pasas
a desarrollo y ya está.

La columna va al lado y no en la franja de arriba porque los datos son altos y estrechos.
En franja, un elemento con diez propiedades ocupaba casi tanto como el viewport que estaba
describiendo; en columna el texto se apila donde hay sitio de sobra —a lo alto— y se lee de
arriba abajo de una pasada. En este modo la franja de arriba no se dibuja: la cabecera va
dentro de la columna y sería la misma información dos veces.

Si los datos son más altos que la página, la imagen crece y el hueco bajo la página se
rellena con el fondo de la columna.

#### La nota

Al pulsar **Capturar** aparece una línea para escribir una **nota opcional**: qué está mal
en esa pantalla. `Enter` captura —con nota o sin ella—, `Esc` cierra la línea sin capturar.
Al lado hay un botón azul con un `⏎` que hace lo mismo que el `Enter`: el placeholder que
cuenta cómo se termina esto desaparece en cuanto escribes la primera letra, y justo
entonces es cuando hace falta. El botón está siempre que la línea está abierta, así no
aparece de golpe a media frase.

El campo **crece a lo alto** conforme escribes, hasta unas seis líneas, y de ahí en
adelante hace scroll. Una nota rara vez cabe en un renglón, y un campo de una línea con el
texto desfilando por dentro es justo el que no te deja releer lo que has escrito antes de
capturar. `⇧` + `Enter` parte la línea, como en cualquier chat, y los saltos llegan a la
imagen.
La nota sale **arriba de la columna, antes del selector**, en sans y en blanco: es lo único
de la imagen escrito por una persona para otra, y lo primero que hay que leer. El selector
y el CSS son el material de apoyo de lo que dice la nota.

La columna ya contaba *qué* es el elemento, pero no *qué le pasa*, y eso acababa en el
mensaje de Slack, que se separa de la imagen en cuanto alguien la reenvía. Con la nota
dentro del PNG, la captura sigue explicándose sola después del tercer reenvío.

Se pide al pulsar el botón y no antes por dos razones. Un campo fijo en el panel es una
caja vacía más que mirar y que pide ser rellenada, y el panel viene de una limpieza de
ruido. Y se abre siempre vacía —no recuerda la anterior— porque una nota del error de
antes pegada en la captura de ahora es peor que no tener nota: quien la lee se la cree.
Cambiar de elemento seleccionado también la cierra, por lo mismo.

En las capturas normales, sin inspección, no hay nota: ahí sólo está la franja de arriba,
que es de una línea y va apretada. Si algún día hace falta, es el sitio.

Sólo viewport, nunca página entera: acotar un elemento en una imagen de 8000px de alto no
le sirve a nadie.

La captura corre en su propia ventana, sobre una copia recién cargada de la página, así
que no sabe nada de lo que seleccionaste: se le pasan las rutas de los elementos y
**vuelve a dibujar el overlay con el mismo código** que el frame vivo. Eso es lo que hace
que salga a `@2x` y nítida en vez de a la resolución a la que tengas el lienzo.

El precio es que en una web que se dibuja distinta en cada carga el elemento puede no
estar en el mismo sitio. Si no lo encuentra, la captura sale sin el resalte —con las
propiedades en la franja, que siguen siendo válidas— y el aviso lo dice.

**A la imagen sólo va la distancia fijada** con `⇧` + clic. Antes iba la última que
hubiera, y la última que hay casi nunca es la que se quería: al salir del frame camino del
botón, el puntero cruza media página y la reasigna a lo que pisó por el borde, así que la
imagen salía con una caja magenta y unas cotas que nadie había pedido —en una captura cuyo
destino es explicarle algo a otra persona—. Si había una medida a medias sin fijar, el
aviso posterior lo dice en vez de dejar que se descubra al abrir el archivo.

Dentro de la imagen el segundo elemento se dibuja siempre con **trazo continuo**, aunque en
vivo estuviera en discontinuo: el discontinuo significa «aquí está el ratón», y en una
imagen no hay ratón. Lo que hay es una medida.

Las capturas se hacen en una **ventana offscreen aparte**, del tamaño exacto del
dispositivo, nunca desde el `<webview>` visible: capturar un guest no es fiable en
Electron, el panel en pantalla está rasterizado a la escala del lienzo (sale borroso si
estás alejado con el zoom), y así el panel vivo no se toca.

La ventana comparte la sesión (`persist:previewer`), así que los logins se mantienen,
pero **la página se carga de nuevo**: el estado que sólo vive en la página en marcha (un
modal abierto, un formulario a medio rellenar) no se reproduce.

### Por qué sale nítida

La resolución es todo el diseño de esta parte, y hay cuatro decisiones detrás:

- **La densidad se fija, no se hereda.** `Emulation.setDeviceMetricsOverride` clava el
  `deviceScaleFactor`, así que una captura es `@2x` en cualquier pantalla y venga del
  preset que venga. Si se la dejas a la ventana offscreen, hereda la escala del monitor,
  que en uno no-Retina significa `@1x` sin avisar. Y un preset `@1x` describe el
  dispositivo, no lo nítida que debe salir una captura de revisión.
- **La página se renderiza, no se fotografía scrolleando.** Cada tramo es un
  `Page.captureScreenshot` con `captureBeyondViewport` y un `clip`: le pides al
  compositor que dibuje una ventana sobre el layout completo. Los tramos encajan al píxel
  y los `fixed`/`sticky` se pintan **una vez** donde les toca, así que ya no hace falta
  esconderlos.
- **Los tramos existen sólo por la GPU.** Una superficie de más de 16384px de alto vuelve
  en blanco (y puede llevarse por delante el proceso de GPU). Se cortan tan altos como
  ese techo permite: una página normal son dos o tres tramos.
- **Nada se reescala después.** Los tramos se comprimen directamente a un PNG del disco
  (`src/png.cjs`, un lector/escritor mínimo sobre `zlib`), que es lo que luego se convierte
  a JPEG. Antes se cosían sobre un canvas del renderer, y como un canvas de ese tamaño no
  se puede crear, a las páginas largas había que bajarles la densidad para que cupieran:
  cuanto más larga la página, más borrosa la imagen.

La franja de cabecera también la dibuja la propia página, y se captura como un tramo
más, para que sea texto de verdad al mismo `@Nx` en vez de un bitmap escalado.

El modo viewport sí sigue scrolleando y capturando una pantalla real: en un punto de
scroll dado, eso es lo que de verdad se ve de los elementos `fixed`, y un render
compositado de la página completa no puede mostrarlo.

### Por qué JPEG y no PNG

Contraintuitivo, así que conviene dejarlo escrito: **en PNG estas capturas se ven
borrosas con la barra espaciadora, y en JPEG no.**

Quick Look construye su vista previa con un presupuesto fijo de píxeles. Una captura de
página completa es enorme —2560 × 18718 en un preset de portátil es lo normal—, así que
hay que reducirla mucho para caber en ese presupuesto, y con un PNG no existe forma
barata de hacerlo: hay que descomprimir la imagen entera primero. Quick Look se rinde y
enseña un proxy tosco. La degradación es **gradual**, peor cuanto más larga la página, y
por eso es tan fácil leerla como "la captura ha salido mal". No ha salido mal: el mismo
archivo abierto con Vista Previa se ve perfecto.

El JPEG lleva la decodificación a escala reducida dentro del propio códec, así que la
misma imagen enorme se previsualiza bien. Medido sobre una captura de 48 megapíxeles:

| | peso | Quick Look |
|---|---|---|
| PNG | 3,9 MB | proxy degradado |
| JPEG q95 | 3,3 MB | correcto |

O sea que además pesa menos, lo que de paso hace que Slack la previsualice en línea en
vez de degradarla a adjunto. Como son capturas de QA —mirar espaciados, ver qué se ha
roto, seguir— el sin pérdida no aporta nada aquí y cuesta la previsualización.

Un solo formato para todas, sin umbrales por longitud: las cortas salen baratas igual.

Detalles de implementación que importan si tocas esto:

- La conversión la hace `sips`, que viene con macOS y corre **fuera de proceso**. Con la
  utilidad de imágenes de Electron habría que meter la imagen descomprimida en el heap de
  la app: ~190 MB de golpe en una captura normal.
- Los tramos se siguen cosiendo **sin pérdida** a un PNG temporal. Pedirle a Chromium los
  tramos ya en JPEG ahorraría ese archivo, pero obligaría a descomprimir y recomprimir
  cada tramo: perder calidad dos veces para ahorrar un archivo que vive dos décimas de
  segundo.
- Si `sips` falla o se cuelga (tope de 30s, muy por dentro del límite general de captura),
  se queda el PNG y la captura no se pierde.
- El PNG lleva un chunk `pHYs` que declara 144 dpi (72 × la densidad), y `sips` lo
  arrastra al JPEG. Sin él macOS asume 72 dpi y coloca la imagen al 200% en cualquier
  herramienta que la sitúe por su tamaño físico. **Esto no era la causa de lo del Quick
  Look** —se investigó y se descartó— pero es correcto de todas formas.

### Lo que la densidad no puede arreglar

`@2x` afila todo lo que dibuja el navegador —texto, bordes, sombras, SVG— pero un `<img>`
nunca puede salir mejor que el archivo que tiene detrás. Muchas webs sirven bitmaps a
poco más de 1:1 con su tamaño en CSS, y ampliarlos no añade información.

Por eso, al terminar, el aviso dice si la propia página traía imágenes por debajo de
`@2x`, y cuál es la peor. Si sale ese aviso, el logo blandurrio de la captura es de la
página, no de la captura, y no hay ajuste aquí que lo arregle.

Ojo también con cómo miras el archivo: a `@2x` una captura de 1280px de ancho son 2560px,
y verla al 100% equivale a mirar la web al 200%. Para juzgarla, ajústala al ancho.

### Antes de capturar

Se recorre la página entera y se vuelve arriba, para disparar el lazy loading y los
efectos de scroll-reveal. Dos detalles que importan más de lo que parece:

- El scroll se hace a saltos, no suave (`scroll-behavior: auto`), y se comprueba que la
  página haya llegado de verdad. Con scroll suave, volver arriba desde el final tarda
  bastante: ship.studio se capturaba a 773px del top y la tira empezaba por el medio.
- Después se espera a que la página **deje de moverse** —dos fotogramas iguales
  seguidos— en vez de una pausa fija. La barra de navegación de ship.studio tarda unos
  dos segundos en volver a aparecer, y con una pausa fija salía a medio fundido.

**Límites conocidos:** lo que sólo aparece tras una interacción (un acordeón cerrado, un
menú) no sale. En webs cuyo texto aparece con el scroll, ese texto se captura en el
estado que tiene con la página arriba, que puede ser más apagado que al leerlo en vivo:
para esa sección concreta, usa el modo viewport. Las páginas de más de 60000px de alto
se recortan ahí, y el aviso te lo dice.

## Repo y contribuciones

El remoto es `https://github.com/ruizsanchezd/previewer`, privado. `main` es la fuente de
la verdad y lleva siempre la última versión publicada. `dist/` y `node_modules/` no se
suben.

Tener remoto no obliga a nada: se trabaja en local igual que siempre y se hace `push`
cuando apetece. Para una funcionalidad grande, rama aparte, y `main` se queda entretanto
con la versión que funciona.

Si alguien del equipo aporta mejoras: rama y Pull Request, nunca commits directos a
`main`. Antes de fusionar, `git pull` y `npm start` para verlo funcionando de verdad.

**Lo que hay que tener claro: fusionar una PR no actualiza la app de nadie.** GitHub
guarda código, no la aplicación; son cosas separadas y no hay ninguna conexión entre
ellas. Ni la app del equipo ni la del propio Daniel cambian hasta que alguien compila un
DMG y lo reparte. Eso es deliberado y es una ventaja: se pueden acumular varias PRs y
publicar una sola versión cuando convenga, en vez de que cada merge mueva algo.

## Publicar una versión

El ciclo completo, del cambio fusionado a los Macs del equipo:

1. `git pull` y `npm start`, y comprobar que lo que se va a publicar funciona.
2. Subir la versión en `package.json` (`1.0.0` → `1.1.0`).
3. `npm run dist` → deja `dist/Previewer-1.1.0-arm64.dmg`.
4. Abrir ese DMG y arrastrar a Aplicaciones. macOS pregunta si reemplaza: sí. **No hay
   que desinstalar la anterior.**
5. Commit del cambio de versión, `git tag v1.1.0`, `git push && git push --tags`.
6. Colgar el DMG en un Release de GitHub sobre ese tag (`gh release create v1.1.0
   dist/Previewer-1.1.0-arm64.dmg`), para que "la última versión" sea un sitio y no un
   mensaje de Slack perdido.
7. Avisar al equipo. Cada uno arrastra el DMG nuevo a Aplicaciones y **repite el paso de
   autorización** de abajo: la aprobación de macOS es por versión, no por app.

No compiles en cada cambio: acumula mejoras y publica cuando la app ya se usaría así.
Compilar cuesta un rato y no aporta nada mientras se itera.

```bash
npm run dist          # Apple Silicon → dist/Previewer-1.1.0-arm64.dmg (~93 MB)
npm run dist:intel    # sólo si alguien sigue con un Mac Intel
```

Sale un `.dmg` que se abre, se arrastra a Aplicaciones y ya. No hay actualización
automática, y no por descuido: ver "Si algún día molesta ese paso".

Sólo macOS: la conversión a JPEG usa `sips`, que es de macOS y no tiene equivalente
gratis en Windows sin meter dependencias.

**El icono** se genera de `build/icon.png` a 1024×1024. El dibujo tiene que llegar **de
borde a borde**, sin márgenes y sin sombra propia: macOS 26 aplica él mismo la máscara, la
sombra y el brillo del borde. La plantilla de 824×824 con márgenes que recomiendan los
blogs y la documentación antigua de Apple es justo lo que no hay que hacer: Tahoe deja de
tratarlo como icono moderno y lo mete dentro de una caja gris clara con el dibujo reducido.

Lo que sí conviene es recortar el PNG con **la propia esquina redondeada del sistema**
(a 1024, radio de unos 256 px, transparente fuera). Comprobado a mano renderizando el
icono real con `NSWorkspace.icon(forFile:)`:

- Como icono de la **app**, da igual: Tahoe enmascara encima y el resultado con esquina
  recortada y sin recortar es el mismo. No hay caja gris mientras el dibujo llegue al
  borde — lo que la provoca es el margen, no la transparencia.
- Como icono del **volumen del DMG** — el disco que se monta al abrir el instalador — sí
  importa: ahí macOS **no** enmascara nada, pinta el `.icns` tal cual. Con el PNG opaco
  sale un cuadrado a sangre con las esquinas casi rectas; con la esquina ya recortada sale
  el icono con su forma correcta.

### Lo que tienen que hacer tus compañeros la primera vez

La app está firmada "ad-hoc": lo mínimo para que arranque en Apple Silicon, pero sin
identidad de desarrollador de Apple. macOS avisa la primera vez y hay que autorizarla a
mano:

1. Arrastrar `Previewer.app` a Aplicaciones y abrirla. Sale un aviso de que no se puede
   comprobar si contiene malware.
2. **Ajustes del Sistema → Privacidad y seguridad**, bajar hasta el aviso de Previewer y
   pulsar **Abrir de todos modos**.
3. Confirmar. A partir de ahí abre con doble clic como cualquier app.

(Desde macOS Sequoia el atajo de clic derecho → Abrir ya no sirve para apps sin firmar;
hay que pasar por Ajustes.) La alternativa por terminal es
`xattr -dr com.apple.quarantine /Applications/Previewer.app`.

Son 30 segundos y **sólo la primera vez de cada versión**: una vez autorizada, abre con
doble clic para siempre. Dos avisos: hace falta ser administrador del Mac, así que en
equipos gestionados por IT con cuentas sin permisos esto se atasca; y al instalar una
versión nueva hay que repetirlo, porque para macOS cada build sin identidad de
desarrollador es un programa distinto.

### Si algún día molesta ese paso

Se quita con una cuenta de Apple Developer (99 €/año): firma con Developer ID +
notarización y la app abre con doble clic desde el primer momento, sin avisos. Los
entitlements y el hardened runtime ya están puestos en `build/entitlements.mac.plist`,
así que el cambio es quitar `"identity": "-"` de `package.json` y añadir las credenciales
de notarización.

Esa cuenta es también lo que desbloquearía la **actualización automática** (que la app
mire los Releases de GitHub y se actualice sola, sin DMG ni avisos). El mecanismo de
macOS se niega a reemplazar una app firmada ad-hoc: comprueba que la versión nueva viene
del mismo desarrollador que la instalada, y sin identidad real no hay nada que comparar.

Así que los 99 € compran tres cosas de golpe —instalar sin avisos, actualizar sin avisos
y actualizar solo— y hasta entonces el reparto es a mano. El momento de plantearlo es
cuando dé pereza avisar al equipo de que hay versión nueva, no antes.

## Notas

- Todos los paneles comparten la sesión `persist:previewer`, así que si te logueas en uno
  quedas logueado en todos.
- Los certificados autofirmados se aceptan sólo en hosts locales.
- El estado (URL, paneles, posición del lienzo, sets) se guarda en `localStorage`.
