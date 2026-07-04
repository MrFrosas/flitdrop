// Génère l'image de fond du .dmg macOS (build/background.png + @2x).
// Outil ponctuel : npm i -D playwright && npx playwright install chromium
// L'image laisse la place aux deux icônes (app à gauche, Applications à droite)
// que le .dmg pose par-dessus, et affiche le nom + une consigne d'ouverture.
import { chromium } from 'playwright'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const out = path.join(here, '..', 'apps', 'desktop', 'build')

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  * { margin: 0; box-sizing: border-box; }
  html, body { width: 540px; height: 380px; }
  body {
    font-family: -apple-system, 'SF Pro Display', system-ui, sans-serif;
    color: #f5f5f7;
    background:
      radial-gradient(120% 90% at 50% -20%, #16263f 0%, transparent 60%),
      linear-gradient(160deg, #0d1420 0%, #05070c 100%);
    position: relative; overflow: hidden;
  }
  .rings { position: absolute; top: -140px; left: 50%; transform: translateX(-50%); width: 420px; height: 420px; }
  .rings i { position: absolute; inset: 0; border: 1px solid rgba(89,183,255,0.10); border-radius: 50%; }
  .rings i:nth-child(2){ inset: 60px; } .rings i:nth-child(3){ inset: 120px; }
  header { position: absolute; top: 30px; left: 0; right: 0; text-align: center; }
  .brand { display:inline-flex; align-items:center; gap:9px; font-size: 26px; font-weight: 700; letter-spacing: -0.02em; }
  .dot { width: 13px; height: 13px; border-radius: 50%; background: #0a84ff; box-shadow: 0 0 16px #0a84ff; }
  .tag { margin-top: 4px; font-size: 13px; color: #9aa7bd; }
  .arrow { position: absolute; top: 205px; left: 232px; width: 76px; text-align: center; color: #59b7ff; font-size: 30px; opacity: 0.9; }
  .drop { position: absolute; top: 172px; left: 96px; width: 96px; text-align: center; font-size: 11.5px; color: #9aa7bd; }
  .apps { position: absolute; top: 172px; left: 352px; width: 96px; text-align: center; font-size: 11.5px; color: #9aa7bd; }
  footer { position: absolute; bottom: 22px; left: 30px; right: 30px; text-align: center; font-size: 11px; line-height: 1.55; color: #8090a6; }
  footer b { color: #cdd7e6; }
  code { font-family: ui-monospace, 'SF Mono', monospace; color: #8de0ff; background: rgba(255,255,255,0.06); padding: 1px 5px; border-radius: 4px; }
</style></head><body>
  <div class="rings"><i></i><i></i><i></i></div>
  <header>
    <div class="brand"><span class="dot"></span>Flitdrop</div>
    <div class="tag">The AirDrop for every device</div>
  </header>
  <div class="drop">Drag here</div>
  <div class="arrow">&#8594;</div>
  <div class="apps">to Applications</div>
  <footer>First launch: <b>Control-click Flitdrop &rarr; Open</b>. If macOS says it is &ldquo;damaged&rdquo;,<br>open Terminal and run <code>xattr -cr /Applications/Flitdrop.app</code></footer>
</body></html>`

const browser = await chromium.launch()
for (const [scale, name] of [[1, 'background.png'], [2, 'background@2x.png']]) {
  const ctx = await browser.newContext({ viewport: { width: 540, height: 380 }, deviceScaleFactor: scale })
  const page = await ctx.newPage()
  await page.setContent(html, { waitUntil: 'networkidle' })
  await page.waitForTimeout(300)
  await page.screenshot({ path: path.join(out, name) })
  await ctx.close()
  console.log('généré', name)
}
await browser.close()
console.log('fonds dmg dans apps/desktop/build/')
