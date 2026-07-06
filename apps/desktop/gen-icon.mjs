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

function smooth(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

// distance d'un point (px,py) au segment [a,b] : trace la flèche en capsules à
// bords nets, avec un anti-crénelage propre à toutes les tailles (16 -> 512).
function sdSeg(px, py, ax, ay, bx, by) {
  const vx = bx - ax
  const vy = by - ay
  const wx = px - ax
  const wy = py - ay
  const t = Math.max(0, Math.min(1, (wx * vx + wy * vy) / (vx * vx + vy * vy)))
  const dx = wx - t * vx
  const dy = wy - t * vy
  return Math.sqrt(dx * dx + dy * dy)
}

// Icône Flitdrop : carré arrondi, dégradé diagonal cyan -> bleu franc (aspect
// « App Store », vif et net même à 16 px), avec une flèche d'envoi blanche.
// Volontairement contrastée : elle doit se reconnaître d'un coup d'œil et
// inspirer confiance, là où l'ancien radar bleu nuit passait pour un carré terne.
function drawIcon(size) {
  const rgba = Buffer.alloc(size * size * 4)
  const c = size / 2
  const corner = size * 0.225
  const top = [66, 200, 255] // #42C8FF
  const bot = [10, 92, 255] // #0A5CFF
  const stroke = size * 0.075
  const tipY = c - size * 0.205
  const tailY = c + size * 0.225
  const armDX = size * 0.165
  const armDY = size * 0.17
  const aa = size * 0.012 + 0.6
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      // masque rectangle arrondi (bord anti-crénelé)
      const dx = Math.max(Math.abs(x - c) - (c - corner), 0)
      const dy = Math.max(Math.abs(y - c) - (c - corner), 0)
      const dCorner = Math.sqrt(dx * dx + dy * dy)
      const maskA = 1 - smooth(corner - 1, corner + 0.5, dCorner)
      if (maskA <= 0) {
        rgba[i + 3] = 0
        continue
      }
      // fond : dégradé diagonal + léger éclat en haut (gloss)
      const g = Math.min(1, Math.max(0, (x + y) / (2 * size)))
      let r = mix(top[0], bot[0], g)
      let gg = mix(top[1], bot[1], g)
      let b = mix(top[2], bot[2], g)
      const gloss = smooth(0.5, 0, y / size) * 0.1
      r = Math.min(255, r + 255 * gloss)
      gg = Math.min(255, gg + 255 * gloss)
      b = Math.min(255, b + 255 * gloss)
      // flèche = union de 3 capsules (hampe + deux branches du chevron)
      const dArrow = Math.min(
        sdSeg(x, y, c, tailY, c, tipY),
        sdSeg(x, y, c - armDX, tipY + armDY, c, tipY),
        sdSeg(x, y, c + armDX, tipY + armDY, c, tipY)
      )
      // ombre portée discrète sous la flèche (décalée vers le bas) : juste ce
      // qu'il faut de profondeur, sans halo diffus.
      const soff = size * 0.022
      const dShadow = Math.min(
        sdSeg(x, y - soff, c, tailY, c, tipY),
        sdSeg(x, y - soff, c - armDX, tipY + armDY, c, tipY),
        sdSeg(x, y - soff, c + armDX, tipY + armDY, c, tipY)
      )
      const shadowCov = (1 - smooth(stroke, stroke + aa * 1.6, dShadow)) * 0.1
      r = mix(r, 6, shadowCov)
      gg = mix(gg, 24, shadowCov)
      b = mix(b, 60, shadowCov)
      const arrowCov = 1 - smooth(stroke - aa, stroke + aa, dArrow)
      r = mix(r, 255, arrowCov)
      gg = mix(gg, 255, arrowCov)
      b = mix(b, 255, arrowCov)
      rgba[i] = r
      rgba[i + 1] = gg
      rgba[i + 2] = b
      rgba[i + 3] = Math.round(255 * maskA)
    }
  }
  return encodePNG(size, rgba)
}

// Icône de la barre de menu macOS : une "template image". macOS n'utilise QUE le
// canal alpha (les pixels sont noirs), puis recolore le glyphe selon le thème de la
// barre (noir en clair, blanc en sombre) et l'aligne à la taille système. Donc pas
// de tuile ni de couleur ici : juste la flèche d'envoi, avec une marge, comme les
// icônes natives (Wi-Fi, AirDrop, batterie). C'est ce qui corrige l'aspect
// "carré bleu surdimensionné" de l'ancienne icône.
function drawTrayTemplate(size) {
  const rgba = Buffer.alloc(size * size * 4)
  const c = size / 2
  // flèche centrée avec ~15% de marge en haut/bas pour respirer dans la barre
  const tipY = size * 0.17
  const tailY = size * 0.83
  const armDX = size * 0.23
  const armDY = size * 0.23
  const stroke = size * 0.1
  const aa = size * 0.028 + 0.5
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      const dArrow = Math.min(
        sdSeg(x, y, c, tailY, c, tipY),
        sdSeg(x, y, c - armDX, tipY + armDY, c, tipY),
        sdSeg(x, y, c + armDX, tipY + armDY, c, tipY)
      )
      const cov = 1 - smooth(stroke - aa, stroke + aa, dArrow)
      // noir + alpha = coverage : macOS s'occupe de la teinte finale
      rgba[i] = 0
      rgba[i + 1] = 0
      rgba[i + 2] = 0
      rgba[i + 3] = Math.round(255 * cov)
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
// tray.png reste l'icône COULEUR (Windows/Linux affichent des icônes de zone de
// notification en couleur).
fs.writeFileSync(path.join(here, 'build', 'tray.png'), drawIcon(32))
// trayTemplate*.png : glyphe monochrome pour la barre de menu macOS. @1x = 16 px,
// @2x = 32 px (macOS choisit selon l'écran). Le suffixe "Template" fait
// qu'Electron l'active en image template automatiquement.
fs.writeFileSync(path.join(here, 'build', 'trayTemplate.png'), drawTrayTemplate(16))
fs.writeFileSync(path.join(here, 'build', 'trayTemplate@2x.png'), drawTrayTemplate(32))
fs.writeFileSync(path.join(here, 'build', 'icon.ico'), buildIco([16, 24, 32, 48, 64, 128, 256]))
console.log('icônes générées dans apps/desktop/build/ (png, tray, trayTemplate@1x/@2x, ico)')
