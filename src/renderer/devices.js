/* Device presets. `dpr` is informational only — it shows in the panel bar
 * so you know which physical density the size maps to. */
window.DEVICE_PRESETS = [
  { group: 'Móvil', items: [
    { name: 'iPhone SE',            w: 375,  h: 667,  dpr: 2 },
    { name: 'iPhone 15',            w: 393,  h: 852,  dpr: 3 },
    { name: 'iPhone 15 Pro Max',    w: 430,  h: 932,  dpr: 3 },
    { name: 'Pixel 8',              w: 412,  h: 915,  dpr: 2.6 },
    { name: 'Galaxy S24',           w: 360,  h: 780,  dpr: 3 }
  ] },
  { group: 'Tablet', items: [
    { name: 'iPad mini',            w: 744,  h: 1133, dpr: 2 },
    { name: 'iPad Air',             w: 820,  h: 1180, dpr: 2 },
    { name: 'iPad Pro 12.9"',       w: 1024, h: 1366, dpr: 2 },
    { name: 'iPad Pro (landscape)', w: 1366, h: 1024, dpr: 2 }
  ] },
  { group: 'Escritorio', items: [
    { name: 'Laptop pequeño',       w: 1280, h: 800,  dpr: 2 },
    { name: 'MacBook Air 13"',      w: 1440, h: 900,  dpr: 2 },
    { name: 'MacBook Pro 16"',      w: 1728, h: 1117, dpr: 2 },
    { name: 'Full HD',              w: 1920, h: 1080, dpr: 1 },
    { name: 'Ultrawide',            w: 2560, h: 1080, dpr: 1 }
  ] },
  { group: 'Breakpoints', items: [
    { name: 'sm',                   w: 640,  h: 900,  dpr: 2 },
    { name: 'md',                   w: 768,  h: 900,  dpr: 2 },
    { name: 'lg',                   w: 1024, h: 900,  dpr: 2 },
    { name: 'xl',                   w: 1280, h: 900,  dpr: 2 },
    { name: '2xl',                  w: 1536, h: 900,  dpr: 2 }
  ] }
]

window.DEFAULT_SET = [
  { name: 'iPhone 15',      w: 393,  h: 852,  dpr: 3 },
  { name: 'iPad Air',       w: 820,  h: 1180, dpr: 2 },
  { name: 'Laptop pequeño', w: 1280, h: 800,  dpr: 2 }
]

window.LOCALES = [
  { code: 'auto',  label: 'Idioma del sistema' },
  { code: 'es-ES', label: 'Español (ES)' },
  { code: 'en-US', label: 'English (US)' },
  { code: 'en-GB', label: 'English (UK)' },
  { code: 'fr-FR', label: 'Français' },
  { code: 'de-DE', label: 'Deutsch' },
  { code: 'pt-BR', label: 'Português (BR)' },
  { code: 'ca-ES', label: 'Català' },
  { code: 'ar-SA', label: 'العربية (RTL)' },
  { code: 'ja-JP', label: '日本語' }
]
