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
- `src/png.cjs` — lector/escritor PNG mínimo; une los tramos de una captura en streaming
  (el PNG resultante es el paso intermedio hacia el JPEG final).
- `src/preload.cjs` — puente seguro entre el renderer y el proceso principal.
- `src/guest/guest.cjs` — script inyectado en cada página previsualizada.
- `src/renderer/` — el lienzo: paneles, pan/zoom, barra de herramientas, menús.

## Atajos y gestos

| Gesto | Acción |
|---|---|
| Rueda sobre una página | Scroll sincronizado en todos los paneles |
| `⌘` + rueda | Zoom del lienzo |
| `espacio` + arrastrar (o botón central) | Mover el lienzo |
| Arrastrar sobre el fondo | Recuadro de selección; `⇧` suma a la selección |
| `Esc` | Deseleccionar |
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
duplicar, DevTools, recargar, quitar y **screenshot**. Lo que no está en `auto` aparece
como etiqueta en el título del panel.

El título del panel se encoge con el zoom: por debajo de 210px de ancho en pantalla
suelta las medidas, y por debajo de 108px deja sólo el `⋯`, que lleva todas las
acciones. Así los títulos nunca se solapan entre paneles.

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

**El icono** se genera de `build/icon.png` a 1024×1024. Tiene que ser **opaco de borde a
borde**, sin transparencia, sin esquinas redondeadas propias y sin sombra: macOS 26 aplica
él mismo la máscara, la sombra y el brillo del borde. Comprobado a mano: en cuanto el PNG
tiene un solo píxel transparente, Tahoe deja de tratarlo como icono moderno y lo mete
dentro de una caja gris clara con el dibujo reducido. La plantilla de 824×824 con márgenes
que recomiendan los blogs y la propia documentación antigua de Apple provoca justo eso.

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
