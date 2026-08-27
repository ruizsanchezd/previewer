# Previewer

App de Electron: lienzo multi-dispositivo para revisar una misma página en varias
resoluciones a la vez. Sin build, sin framework, sin dependencias más allá de Electron.
`npm start` y ya.

El `README.md` explica el qué y el porqué de casi todo, y está mantenido al día. **Léelo
antes de tocar las capturas**, que es la parte con más decisiones no obvias detrás.

## Si el usuario quiere publicar o actualizar la app

El proceso está acordado y escrito en el README, en **"Publicar una versión"**. Léelo y
guíale por los pasos; no improvises uno nuevo ni asumas que se acuerda. En resumen: para
desarrollar nunca se reinstala nada (`npm start` ya es la app), y la app instalada sólo
cambia cuando alguien compila un DMG a mano y lo reparte. Fusionar una PR no actualiza la
app de nadie. La sección de al lado, "Repo y contribuciones", cubre el flujo de PRs, y la
de "Si algún día molesta ese paso" explica qué desbloquearía la cuenta de Apple Developer
y por qué todavía no se ha pagado.

## Cómo trabaja aquí el usuario

- **Es diseñador, no desarrollador.** Explica las cosas en términos de lo que se ve y de
  lo que cuesta, no de API. Si una decisión técnica tiene una consecuencia visible o de
  rendimiento, dila; los detalles de implementación van en el código y en el README.
- **Escribe por dictado de voz**, así que a veces hay palabras raras o mal transcritas.
  Interpreta por contexto en vez de tomarlo al pie de la letra.
- **La premisa es siempre la solución más ligera** que cumpla el objetivo. Antes de
  proponer algo, mira qué consume: memoria, procesos, dependencias nuevas. Si hay dos
  caminos, di cuál pesa menos y por qué.
- Quiere **opinión y recomendación**, no un menú de opciones. Si no estás de acuerdo con
  lo que propone, dilo y argumenta; ha cambiado de idea con datos más de una vez.

## Para qué se usan las capturas

QA rápido: mirar cómo queda la página entera antes de lanzar, compartirla con desarrollo,
comparar. **No hay pretensiones de fidelidad absoluta.** Que se vea nítido para tomar una
decisión y seguir. Esto es lo que justifica el JPEG con pérdida, y lo que debería
justificar decisiones parecidas en el futuro.

Los destinos reales son Slack y Figma:

- **Slack** previsualiza en línea si el archivo no pesa demasiado; si pesa, lo degrada a
  adjunto y pierde todo el sentido. Otra razón para el JPEG.
- **Figma** pixela la imagen al importarla, por su propia compresión, **da igual la
  resolución que le des**. No es un problema que se arregle desde aquí: se resuelve con un
  plugin de importación de imágenes grandes. No optimices las capturas pensando en Figma.

## Menos opciones, mejores valores por defecto

Había un selector de densidad `@1x/@2x/@3x` y se quitó a propósito. El usuario no tiene
información para elegir bien en el momento de capturar —depende de dónde acabe la imagen,
que aún no sabe— y equivocarse cuesta repetir la captura.

**Antes de añadir un ajuste, pregúntate si puedes elegir tú el valor correcto.** Casi
siempre puedes.

## Al tocar las capturas

- **Verifica en Vista Previa, no con la barra espaciadora.** Quick Look enseña un proxy
  degradado de las imágenes grandes y te hará perseguir un problema de nitidez que no
  existe. El README lo explica entero en "Por qué JPEG y no PNG".
- Comprueba dpi y dimensiones reales con `sips -g pixelWidth -g pixelHeight -g dpiWidth
  -g dpiHeight <archivo>`. Los MB de un archivo no dicen nada de sus píxeles: fue lo que
  despistó al comparar con otra herramienta.
- La memoria es la restricción real. La imagen entera descomprimida son cientos de MB;
  todo el diseño de esta parte (tramos, escritura en streaming, conversión fuera de
  proceso) existe para que eso nunca entre en el heap de la app. No lo deshagas por
  comodidad.

## Idioma

Interfaz, textos de error visibles y README, en español.

Los comentarios del código están **mezclados**: `main.cjs` y `png.cjs` casi todo en
inglés, `renderer.js` con bastante español. No unifiques nada por tu cuenta; sigue el
idioma de lo que haya alrededor de lo que estés tocando.
