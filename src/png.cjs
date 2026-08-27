/* Minimal PNG reader/writer, just enough to glue capture slices together.
 *
 * Why not a canvas: composing a tall page in the renderer means one canvas the
 * size of the whole strip, and both the GPU (16384px max texture) and the 2D
 * canvas (area caps) refuse to go that big, so the old code had to drop the
 * density to make long pages fit. Here the slices are decoded one at a time and
 * the rows are deflated straight into the output file, so height is unbounded
 * and memory stays at roughly one slice. Nothing is ever resampled.
 *
 * Scope: 8-bit, non-interlaced, colour types 0/2/4/6 — which is everything
 * Chromium's Page.captureScreenshot emits. Output is always 8-bit RGBA.
 */

const fs = require('fs')
const zlib = require('zlib')

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32 (buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk (type, data) {
  const out = Buffer.allocUnsafe(data.length + 12)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 4, 'ascii')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

/* ------------------------------------------------------------------ read */

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }

/* Cheap enough to run on every slice before committing to an output size. */
function readHeader (buf) {
  if (buf.length < 33 || !buf.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error('no parece un PNG')
  }
  if (buf.toString('ascii', 12, 16) !== 'IHDR') throw new Error('PNG sin IHDR')
  const header = {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    depth: buf[24],
    colorType: buf[25],
    interlace: buf[28]
  }
  if (header.depth !== 8) throw new Error(`PNG de ${header.depth} bits no soportado`)
  if (header.interlace !== 0) throw new Error('PNG entrelazado no soportado')
  if (!CHANNELS[header.colorType] || header.colorType === 3) {
    throw new Error(`tipo de color PNG ${header.colorType} no soportado`)
  }
  return header
}

function paeth (a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

function unfilter (raw, width, height, bpp) {
  const stride = width * bpp
  const out = Buffer.allocUnsafe(stride * height)
  let pos = 0
  for (let y = 0; y < height; y++) {
    const type = raw[pos++]
    const base = y * stride
    const prev = base - stride
    for (let i = 0; i < stride; i++) {
      const x = raw[pos + i]
      const a = i >= bpp ? out[base + i - bpp] : 0
      const b = y > 0 ? out[prev + i] : 0
      switch (type) {
        case 0: out[base + i] = x; break
        case 1: out[base + i] = (x + a) & 0xff; break
        case 2: out[base + i] = (x + b) & 0xff; break
        case 3: out[base + i] = (x + ((a + b) >> 1)) & 0xff; break
        case 4: out[base + i] = (x + paeth(a, b, y > 0 && i >= bpp ? out[prev + i - bpp] : 0)) & 0xff; break
        default: throw new Error('filtro PNG desconocido: ' + type)
      }
    }
    pos += stride
  }
  return out
}

/* Decodes to a tightly packed 8-bit RGBA buffer. */
function decodeRgba (buf) {
  const header = readHeader(buf)
  const parts = []
  let pos = 8
  while (pos + 8 <= buf.length) {
    const length = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    if (type === 'IDAT') parts.push(buf.subarray(pos + 8, pos + 8 + length))
    pos += length + 12
    if (type === 'IEND') break
  }
  if (!parts.length) throw new Error('PNG sin datos de imagen')

  const channels = CHANNELS[header.colorType]
  const raw = unfilter(
    zlib.inflateSync(parts.length === 1 ? parts[0] : Buffer.concat(parts)),
    header.width, header.height, channels)

  if (channels === 4) return { width: header.width, height: header.height, data: raw }

  const px = header.width * header.height
  const rgba = Buffer.allocUnsafe(px * 4)
  for (let i = 0; i < px; i++) {
    const s = i * channels
    const d = i * 4
    if (header.colorType === 2) {
      rgba[d] = raw[s]; rgba[d + 1] = raw[s + 1]; rgba[d + 2] = raw[s + 2]; rgba[d + 3] = 0xff
    } else if (header.colorType === 0) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = raw[s]; rgba[d + 3] = 0xff
    } else {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = raw[s]; rgba[d + 3] = raw[s + 1]
    }
  }
  return { width: header.width, height: header.height, data: rgba }
}

/* ----------------------------------------------------------------- write */

/* Without a pHYs chunk a PNG has no stated physical size, and macOS falls back
 * to 72 dpi: a @2x shot is then read as an image twice as wide as it should be,
 * and anything that lays it out by that size (Quick Look, Slack's inline
 * preview, an import into a design tool) shows it at 200% — i.e. soft, from a
 * file that has all the pixels needed to be sharp. Its own screengrabs are
 * tagged 144 dpi for exactly this reason. So: 72 dpi per unit of density,
 * written in the pixels-per-metre the format actually stores. */
const PPM = (density) => Math.round((72 * density) / 0.0254)

function pHYs (density) {
  const data = Buffer.alloc(9)
  data.writeUInt32BE(PPM(density), 0)
  data.writeUInt32BE(PPM(density), 4)
  data[8] = 1  // unit: metre
  return data
}

/* Rows go in as raw RGBA and come out as IDAT chunks on the file as the
 * deflate stream produces them, so nothing large is ever held whole. */
class PngWriter {
  constructor (file, width, height, density = 1) {
    this.width = width
    this.height = height
    this.rowsWritten = 0
    this.out = fs.createWriteStream(file)
    this.deflate = zlib.createDeflate({ level: 6 })

    const ihdr = Buffer.alloc(13)
    ihdr.writeUInt32BE(width, 0)
    ihdr.writeUInt32BE(height, 4)
    ihdr[8] = 8      // bit depth
    ihdr[9] = 6      // RGBA
    this.out.write(SIGNATURE)
    this.out.write(chunk('IHDR', ihdr))
    this.out.write(chunk('pHYs', pHYs(density)))

    this.deflate.on('data', (d) => { this.out.write(chunk('IDAT', d)) })

    this.failed = new Promise((_, reject) => {
      this.out.on('error', reject)
      this.deflate.on('error', reject)
    })
  }

  /* `rgba` holds `rows` scanlines of `width` RGBA pixels.
   *
   * Each scanline needs a filter byte in front of it. Rather than allocating a
   * joined buffer per row, rows are copied into one reused batch buffer whose
   * filter bytes are already zeroed — filter type 0, the bytes as they are.
   * Chromium's own encoder filters properly, but re-deriving filters here would
   * cost far more CPU than the few percent of size it would save. */
  async write (rgba, rows) {
    const stride = this.width * 4
    const batch = Math.max(1, Math.min(rows, Math.ceil(1e6 / (stride + 1))))

    for (let start = 0; start < rows; start += batch) {
      const n = Math.min(batch, rows - start)
      // A fresh buffer per batch: a stream holds on to the chunk it was handed
      // until zlib has consumed it, so a shared one would be rewritten
      // underneath a queued write.
      const buf = Buffer.allocUnsafe(n * (stride + 1))
      for (let y = 0; y < n; y++) {
        buf[y * (stride + 1)] = 0
        rgba.copy(buf, y * (stride + 1) + 1, (start + y) * stride, (start + y + 1) * stride)
      }
      if (!this.deflate.write(buf)) {
        await Promise.race([once(this.deflate, 'drain'), this.failed])
      }
      this.rowsWritten += n
    }
  }

  async finish () {
    if (this.rowsWritten !== this.height) {
      throw new Error(`faltan filas: ${this.rowsWritten} de ${this.height}`)
    }
    this.deflate.end()
    await Promise.race([once(this.deflate, 'end'), this.failed])
    this.out.write(chunk('IEND', Buffer.alloc(0)))
    this.out.end()
    await Promise.race([once(this.out, 'finish'), this.failed])
  }

  destroy () {
    try { this.deflate.destroy() } catch (_) {}
    try { this.out.destroy() } catch (_) {}
  }
}

function once (emitter, event) {
  return new Promise((resolve) => emitter.once(event, resolve))
}

/* Stacks equal-width PNG slices into one PNG on disk, top to bottom. */
async function stackVertical (slices, file, density = 1) {
  if (!slices.length) throw new Error('no hay nada que unir')
  const headers = slices.map(readHeader)
  const width = headers[0].width
  const odd = headers.findIndex((h) => h.width !== width)
  if (odd > -1) throw new Error(`el tramo ${odd} mide ${headers[odd].width}px y no ${width}px`)
  const height = headers.reduce((sum, h) => sum + h.height, 0)

  const writer = new PngWriter(file, width, height, density)
  try {
    for (const slice of slices) {
      const img = decodeRgba(slice)
      await writer.write(img.data, img.height)
    }
    await writer.finish()
  } catch (err) {
    writer.destroy()
    try { fs.unlinkSync(file) } catch (_) {}
    throw err
  }
  return { width, height }
}

module.exports = { readHeader, decodeRgba, stackVertical, PngWriter }
