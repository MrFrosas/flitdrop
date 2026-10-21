// Remet les traductions d'une page dont le balisage a changé : on associe par
// texte anglais (dans l'ordre), pas par numéro. Usage : node tools/i18n-remap.mjs slug oldHtmlPath
import { readFileSync, writeFileSync } from 'node:fs'
import { parse } from 'node-html-parser'
import { collectUnits } from './i18n-pages.mjs'
const [,, slug, oldPath] = process.argv
const R = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const units = (html) => { const out = []; collectUnits(parse(html, { comment: true }), (u) => out.push(u)); return out }
const oldU = units(readFileSync(oldPath, 'utf8'))
const newU = units(readFileSync(`${R}/site/${slug}.html`, 'utf8'))
let missing = 0
for (const lang of ['fr', 'de']) {
  const f = `${R}/tools/i18n/${lang}/${slug}.json`
  const map = JSON.parse(readFileSync(f, 'utf8'))
  const pool = new Map()
  for (const u of oldU) { if (map[u.id] == null) continue; if (!pool.has(u.en)) pool.set(u.en, []); pool.get(u.en).push(map[u.id]) }
  const out = {}
  for (const u of newU) {
    const q = pool.get(u.en)
    if (q && q.length) out[u.id] = q.length > 1 ? q.shift() : q[0]
    else { missing++; console.log('MISSING', lang, u.id, JSON.stringify(u.en).slice(0, 120)) }
  }
  writeFileSync(f, JSON.stringify(out, null, 2) + '\n')
}
console.log(slug, 'old', oldU.length, 'new', newU.length, 'missing', missing)
