// Génère build/icon.png (512) et build/tray.png (32) sans dépendance :
// motif radar Flitdrop (fond bleu nuit, anneaux, point lumineux).
import zlib from 'node:zlib'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

function crc32(buf) {
  let c
  const table = []
  for (let n = 0; n < 256; n++) {
    c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  let crc = 0xffffffff
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function encodePNG(size, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // profondeur
  ihdr[9] = 6 // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function mix(a, b, t) {
  return Math.round(a + (b - a) * t)
}

function drawIcon(size) {
  const rgba = Buffer.alloc(size * size * 4)
  const c = size / 2
  const corner = size * 0.22
  const accent = [89, 183, 255]
  const glow = [141, 224, 255]
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      // rectangle arrondi
      const dx = Math.max(Math.abs(x - c) - (c - corner), 0)
      const dy = Math.max(Math.abs(y - c) - (c - corner), 0)
      const dCorner = Math.sqrt(dx * dx + dy * dy)
      const alpha = dCorner > corner ? 0 : dCorner > corner - 2 ? Math.round(255 * (corner - dCorner) / 2) : 255
      // fond dégradé radial bleu nuit
      const d = Math.sqrt((x - c) ** 2 + (y - c * 0.85) ** 2) / size
      let r = mix(20, 9, Math.min(1, d * 1.6))
      let g = mix(36, 13, Math.min(1, d * 1.6))
      let b = mix(63, 21, Math.min(1, d * 1.6))
      // anneaux
      const dist = Math.sqrt((x - c) ** 2 + (y - c) ** 2)
      for (const [rr, op] of [
        [size * 0.34, 0.35],
        [size * 0.22, 0.55],
      ]) {
        const w = size * 0.008
        const t = Math.abs(dist - rr)
        if (t < w * 2) {
          const k = op * Math.max(0, 1 - t / (w * 2))
          r = mix(r, accent[0], k)
          g = mix(g, accent[1], k)
          b = mix(b, accent[2], k)
        }
      }
      // halo + point central
      const dot = size * 0.075
      if (dist < dot * 2.6) {
        const k = Math.max(0, 1 - dist / (dot * 2.6)) * 0.5
        r = mix(r, accent[0], k)
        g = mix(g, accent[1], k)
        b = mix(b, accent[2], k)
      }
      if (dist < dot) {
        const k = Math.max(0.75, 1 - dist / dot)
        r = mix(r, glow[0], k)
        g = mix(g, glow[1], k)
        b = mix(b, glow[2], k)
      }
      // satellite en haut à droite
      const sd = Math.sqrt((x - size * 0.72) ** 2 + (y - size * 0.28) ** 2)
      if (sd < size * 0.045) {
        r = glow[0]
        g = glow[1]
        b = glow[2]
      }
      rgba[i] = r
      rgba[i + 1] = g
      rgba[i + 2] = b
      rgba[i + 3] = alpha
    }
  }
  return encodePNG(size, rgba)
}

// Assemble un .ico (Windows) en embarquant des PNG (supporté depuis Vista).
// Un vrai .ico multi-résolutions donne une icône nette à l'exe et à l'installeur.
function buildIco(sizes) {
  const pngs = sizes.map((s) => drawIcon(s))
  const count = pngs.length
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // réservé
  header.writeUInt16LE(1, 2) // type = icône
  header.writeUInt16LE(count, 4)
  const dir = Buffer.alloc(16 * count)
  let offset = 6 + 16 * count
  pngs.forEach((png, i) => {
    const s = sizes[i]
    const e = i * 16
    dir[e] = s >= 256 ? 0 : s // largeur (0 = 256)
    dir[e + 1] = s >= 256 ? 0 : s // hauteur
    dir[e + 2] = 0 // palette
    dir[e + 3] = 0 // réservé
    dir.writeUInt16LE(1, e + 4) // plans
    dir.writeUInt16LE(32, e + 6) // bits par pixel
    dir.writeUInt32LE(png.length, e + 8)
    dir.writeUInt32LE(offset, e + 12)
    offset += png.length
  })
  return Buffer.concat([header, dir, ...pngs])
}

fs.mkdirSync(path.join(here, 'build'), { recursive: true })
fs.writeFileSync(path.join(here, 'build', 'icon.png'), drawIcon(512))
fs.writeFileSync(path.join(here, 'build', 'tray.png'), drawIcon(32))
fs.writeFileSync(path.join(here, 'build', 'icon.ico'), buildIco([16, 24, 32, 48, 64, 128, 256]))
console.log('icônes générées dans apps/desktop/build/ (png, tray, ico)')
