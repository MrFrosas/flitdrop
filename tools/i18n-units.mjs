// Garde-fou des traductions FR/DE : photo des unités traduisibles des pages EN
// (snapshot) avant une retouche, puis comparaison (diff) : échoue si le nombre
// ou l'ordre des unités change, et liste les unités dont le texte a changé
// (à retraduire dans tools/i18n/<lang>/<slug>.json).
// node tools/i18n-units.mjs snapshot <out.json> | diff <before.json> <out-changes.json>
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { extractUnits } from './i18n-pages.mjs'
const SITE = new URL('../site/', import.meta.url).pathname
const slugs = readdirSync(SITE).filter(f => f.endsWith('.html') && !['index.html','404.html','brand.html','privacy.html','legal.html'].includes(f)).map(f => f.slice(0,-5))
const snap = () => Object.fromEntries(slugs.map(s => [s, extractUnits(readFileSync(SITE + s + '.html','utf8'))]))
const [mode, a, b] = process.argv.slice(2)
if (mode === 'snapshot') { writeFileSync(a, JSON.stringify(snap(), null, 1)); console.log('snapshot', slugs.length, 'pages') }
else if (mode === 'diff') {
  const before = JSON.parse(readFileSync(a,'utf8')), now = snap(), changes = {}; let bad = 0, n = 0
  for (const s of slugs) {
    const A = before[s], B = now[s]
    if (A.length !== B.length) { bad++; console.log('NUMEROTATION CASSEE', s, A.length, '->', B.length); continue }
    for (let i = 0; i < A.length; i++) {
      if (A[i].kind !== B[i].kind) { bad++; console.log('TYPE CHANGE', s, i, A[i].kind, B[i].kind) }
      if (A[i].en !== B[i].en) { (changes[s] ||= []).push({ id: i, kind: B[i].kind, old_en: A[i].en, new_en: B[i].en }); n++ }
    }
  }
  writeFileSync(b, JSON.stringify(changes, null, 1))
  console.log(bad ? `ECHEC : ${bad} page(s) désalignée(s)` : 'alignement OK', '|', n, 'unité(s) modifiée(s)')
  process.exit(bad ? 1 : 0)
}
