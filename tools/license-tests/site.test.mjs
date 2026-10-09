// Tests des scripts du site liés à Pro : js/pro.js retire ?claim= de l'adresse avant
// toute mesure, js/analytics.js n'envoie jamais de paramètre de requête (sauf utm_*),
// Paddle.js n'est jamais chargé à la simple visite de /pro.
//   node --test tools/license-tests/*.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')

function fakeStorage(init = {}) {
  const m = new Map(Object.entries(init))
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), key: () => null, length: 0, _m: m }
}

// Exécute un script du site dans un faux navigateur (rien du DOM n'est prêt : readyState
// « loading », comme un script synchrone du <head>).
function runInPage(file, { url, window: extra = {}, local = {}, session = {} } = {}) {
  const u = new URL(url)
  const calls = { replaceState: [], scripts: [], fetches: [] }
  const location = { href: u.href, pathname: u.pathname, search: u.search, hash: u.hash, origin: u.origin, hostname: u.hostname }
  const el = () => ({ setAttribute() {}, appendChild() {}, addEventListener() {}, style: {}, classList: { add() {}, remove() {}, toggle() {} } })
  const document = {
    readyState: 'loading',
    referrer: extra.referrer || '',
    cookie: '',
    addEventListener() {},
    createElement: () => {
      const s = el()
      calls.scripts.push(s)
      return s
    },
    getElementsByTagName: () => [{ parentNode: { insertBefore() {} } }],
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: () => null,
    head: { appendChild(s) { calls.scripts.push(s) } },
    documentElement: { getAttribute: () => 'en', appendChild() {} },
    body: { insertBefore() {} },
  }
  const window = {
    location,
    document,
    navigator: { language: 'en-US', languages: ['en-US'] },
    history: {
      state: null,
      replaceState(_s, _t, next) {
        calls.replaceState.push(next)
        const n = new URL(next, u)
        location.href = n.href
        location.search = n.search
        location.pathname = n.pathname
      },
    },
    localStorage: fakeStorage(local),
    sessionStorage: fakeStorage(session),
    fetch: (...a) => {
      calls.fetches.push(String(a[0]))
      return new Promise(() => {})
    },
    setTimeout: () => 0,
    clearTimeout() {},
    addEventListener() {},
    requestAnimationFrame() {},
    URL,
    URLSearchParams,
    Intl,
    Date,
    JSON,
    ...extra,
  }
  window.window = window
  window.self = window
  vm.runInNewContext(read(file), window, { filename: file })
  return { window, calls, location }
}

const CLAIM = '0123456789abcdef0123456789abcdef'

test('pro.js : ?claim=, ?early= et ?lang= quittent l’adresse dès le chargement, utm_* restent', () => {
  const { calls, window } = runInPage('site/js/pro.js', { url: `https://flitdrop.com/fr/pro?claim=${CLAIM}&early=1&utm_source=app#top` })
  assert.deepEqual(calls.replaceState, ['/fr/pro?utm_source=app#top'])
  const stash = JSON.parse(window.sessionStorage.getItem('fd_pro'))
  assert.equal(stash.c, CLAIM)
  assert.equal(stash.e, true)
  assert.equal(calls.fetches.length, 0, 'aucune requête avant que la page soit prête')
  assert.ok(!calls.scripts.some((s) => String(s.src || '').includes('paddle')), 'Paddle.js pas chargé')
})

test('pro.js : rien n’est retiré pendant la redirection vers la page traduite ; claim inventé retiré quand même', () => {
  const r = runInPage('site/js/pro.js', { url: `https://flitdrop.com/pro?claim=${CLAIM}&lang=fr`, window: { __fdLangRedirect: true } })
  assert.deepEqual(r.calls.replaceState, [])
  const bad = runInPage('site/js/pro.js', { url: 'https://flitdrop.com/pro?claim=pas-un-claim' })
  assert.deepEqual(bad.calls.replaceState, ['/pro'])
  assert.equal(bad.window.sessionStorage.getItem('fd_pro'), null)
  // sans paramètre : adresse intacte
  assert.deepEqual(runInPage('site/js/pro.js', { url: 'https://flitdrop.com/de/pro' }).calls.replaceState, [])
})

test('pages /pro : pro.js chargé avant analytics.js, sans prix barré, Paddle seulement au clic', () => {
  for (const page of ['site/pro.html', 'site/fr/pro.html', 'site/de/pro.html']) {
    const html = read(page)
    const pro = html.indexOf('<script src="/js/pro.js"></script>')
    const analytics = html.indexOf('<script async src="/js/analytics.js"></script>')
    assert.ok(pro > 0 && analytics > pro, `${page} : pro.js synchrone, avant analytics.js`)
    assert.ok(!/defer src="\/js\/pro\.js"/.test(html))
    assert.ok(!html.includes('proPriceWas') && !/<s[\s>]/.test(html), `${page} : aucun prix barré`)
    assert.match(html, /id="proEarly"[^>]*>[^<]*\{date\}[^<]*\{price\}/, `${page} : ligne du prix de lancement`)
    assert.match(html, /href="(\/(fr|de))?\/refund#withdraw"/, `${page} : lien de rétractation`)
  }
  const js = read('site/js/pro.js')
  assert.ok(!js.includes('PricePreview'), 'plus d’aperçu de prix Paddle.js à l’affichage')
  // loadPaddle n'est appelé que depuis buy()
  assert.equal((js.match(/loadPaddle\(\)\.then/g) || []).length, 1)
  assert.match(js, /function buy\(\)[\s\S]*?loadPaddle\(\)/)
  assert.ok(js.includes("window.profitwell = { isLoaded: true }"))
})

test('analytics.js : PostHog et GA4 ne reçoivent jamais de paramètre de requête (sauf utm_*)', () => {
  const consent = JSON.stringify({ v: 1, analytics: true, t: Date.now() })
  const { window } = runInPage('site/js/analytics.js', {
    url: `https://flitdrop.com/fr/pro?claim=${CLAIM}&utm_campaign=lancement`,
    local: { fd_consent: consent },
    window: { referrer: `https://flitdrop.com/pro?claim=${CLAIM}` },
  })
  const clean = window.fdCleanUrl
  assert.equal(clean(`https://flitdrop.com/fr/pro?claim=${CLAIM}&early=1&utm_source=app#buy`), 'https://flitdrop.com/fr/pro?utm_source=app#buy')
  assert.equal(clean('https://www.google.com/search?q=flitdrop'), 'https://www.google.com/search')
  assert.equal(clean('https://flitdrop.com/pro'), 'https://flitdrop.com/pro')

  // PostHog : before_send nettoie toutes les adresses, sans changer le filtre de consentement
  const init = window.posthog._i[0]
  const before = init[1].before_send
  const ev = before({
    event: '$pageview',
    properties: {
      $current_url: `https://flitdrop.com/fr/pro?claim=${CLAIM}`,
      $referrer: `https://flitdrop.com/pro?claim=${CLAIM}&lang=fr`,
      $set_once: { $initial_current_url: `https://flitdrop.com/pro?claim=${CLAIM}` },
      $pathname: '/fr/pro',
    },
    $set: { $session_entry_url: `https://flitdrop.com/pro?claim=${CLAIM}&utm_source=x` },
  })
  assert.ok(!JSON.stringify(ev).includes(CLAIM))
  assert.equal(ev.properties.$current_url, 'https://flitdrop.com/fr/pro')
  assert.equal(ev.$set.$session_entry_url, 'https://flitdrop.com/pro?utm_source=x')

  // GA4 : page_location et page_referrer nettoyés pour tous les événements
  const dl = JSON.parse(JSON.stringify(window.dataLayer.map((a) => Array.from(a)))) // objets d'un autre contexte
  const set = dl.find((a) => a[0] === 'set')
  assert.deepEqual(set[1], { page_location: 'https://flitdrop.com/fr/pro?utm_campaign=lancement', page_referrer: 'https://flitdrop.com/pro' })
  const config = dl.find((a) => a[0] === 'config')
  assert.equal(config[2].page_location, 'https://flitdrop.com/fr/pro?utm_campaign=lancement')
  assert.equal(config[2].cookie_expires, 34128000)
  assert.ok(!JSON.stringify(dl).includes(CLAIM))
})

test('analytics.js : Clarity ne démarre jamais tant qu’un ?claim= est dans l’adresse ; le refus reste respecté', () => {
  const granted = JSON.stringify({ v: 1, analytics: true, t: Date.now() })
  const withClaim = runInPage('site/js/analytics.js', { url: `https://flitdrop.com/pro?claim=${CLAIM}`, local: { fd_consent: granted } })
  assert.equal(withClaim.window.clarity, undefined)
  const clean = runInPage('site/js/analytics.js', { url: 'https://flitdrop.com/pro', local: { fd_consent: granted } })
  assert.equal(typeof clean.window.clarity, 'function')
  // refus mémorisé : ni PostHog, ni GA4, ni Clarity
  const refused = runInPage('site/js/analytics.js', { url: 'https://flitdrop.com/pro', local: { fd_consent: JSON.stringify({ v: 1, analytics: false, t: Date.now() }) } })
  assert.equal(refused.window.posthog._i.length, 0)
  assert.equal(refused.window.dataLayer, undefined)
  assert.equal(refused.window.clarity, undefined)
})

test('page /refund : fonction de rétractation en tête, trois champs, sans motif, alternatives gardées', () => {
  for (const page of ['site/refund.html', 'site/fr/refund.html', 'site/de/refund.html']) {
    const html = read(page)
    const form = /<form class="withdraw-form" id="withdraw"[\s\S]*?<\/form>/.exec(html)
    assert.ok(form, page)
    const inputs = form[0].match(/<input[^>]*>/g)
    assert.deepEqual(inputs.map((i) => /name="([^"]+)"/.exec(i)[1]), ['name', 'email', 'order'], page)
    assert.ok(!/textarea|reason|motif/i.test(form[0]), `${page} : aucun motif demandé`)
    assert.ok(html.indexOf('id="withdrawOpen"') < html.indexOf('<h2'), `${page} : en tête de page`)
    assert.ok(html.includes('href="https://paddle.net"') && html.includes('id="refundMail"'), `${page} : Paddle et e-mail restent proposés`)
    assert.ok(html.includes('<script defer src="/js/withdraw.js"></script>'))
  }
  const fr = read('site/fr/refund.html')
  for (const label of ['Renoncer au contrat ici', 'Nom et prénom', "Adresse e-mail utilisée pour l'achat (l'accusé de réception y sera envoyé)", "Numéro de commande ou date d'achat (sur le reçu Paddle)", 'Confirmer la rétractation', 'Ou renoncer chez Paddle (paddle.net)']) {
    assert.ok(fr.includes(label.replace(/'/g, "'")) || fr.includes(label.replace(/'/g, '&#39;')), label)
  }
  const de = read('site/de/refund.html')
  for (const label of ['Vertrag hier widerrufen', 'Vor- und Nachname', 'E-Mail-Adresse des Kaufs (dorthin geht die Eingangsbestätigung)', 'Bestellnummer oder Kaufdatum (auf der Quittung von Paddle)', 'Widerruf bestätigen', 'Oder bei Paddle widerrufen (paddle.net)']) {
    assert.ok(de.includes(label), label)
  }
  // le CSP général autorise l'appel (même domaine)
  assert.match(read('site/_headers'), /\/\*\n[\s\S]*connect-src 'self'/)
})
