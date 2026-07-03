// Capture de vraies captures d'écran des interfaces pour le README.
// Outil ponctuel : Playwright n'est PAS une dépendance du projet.
//   npm i -D playwright && npx playwright install chromium
// Prérequis : le serveur dev tourne sur :47777 (npm run dev) et un appairage
// a été créé. Passe le jeton admin et le fragment d'appairage en arguments.
//   node tools/screenshots.mjs <adminToken> <pairFragment>
import { chromium } from 'playwright'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const out = path.join(here, '..', 'docs', 'screenshots')
const [token, frag] = process.argv.slice(2)
const BASE = 'http://127.0.0.1:47777'

const shots = [
  { name: 'desktop-dark', url: `${BASE}/app/?k=${token}`, w: 1280, h: 800, scheme: 'dark', wait: 1400 },
  { name: 'desktop-light', url: `${BASE}/app/?k=${token}`, w: 1280, h: 800, scheme: 'light', wait: 1400 },
  { name: 'phone-light', url: `${BASE}/s/#${frag}`, w: 390, h: 844, scheme: 'light', wait: 1400, mobile: true },
  { name: 'phone-dark', url: `${BASE}/s/#${frag}`, w: 390, h: 844, scheme: 'dark', wait: 1400, mobile: true },
]

const browser = await chromium.launch()
for (const s of shots) {
  const ctx = await browser.newContext({
    viewport: { width: s.w, height: s.h },
    colorScheme: s.scheme,
    deviceScaleFactor: 2,
    isMobile: !!s.mobile,
  })
  const page = await ctx.newPage()
  await page.goto(s.url, { waitUntil: 'networkidle' })
  await page.waitForTimeout(s.wait)
  await page.screenshot({ path: path.join(out, s.name + '.png') })
  await ctx.close()
  console.log('capturé', s.name)
}
await browser.close()
console.log('captures dans docs/screenshots/')
