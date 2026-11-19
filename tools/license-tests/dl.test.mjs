// Installeur servi en direct pour le Microsoft Store : GET /dl/Flitdrop-Setup-<v>-store.exe
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { onRequest } from '../../functions/dl/[file].js'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

function upstream(status, body = 'MZ', extra = {}) {
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    return new Response(init.method === 'HEAD' ? null : body, { status, headers: { 'content-length': String(body.length), ...extra } })
  }
  return calls
}
const get = (file, init = {}) => onRequest({ request: new Request('https://flitdrop.com/dl/' + file, init), params: { file } })

test('dl : 200 sans redirection, octets de la release, nom gardé', async () => {
  const calls = upstream(200, 'MZ-octets')
  const r = await get('Flitdrop-Setup-0.7.1-store.exe')
  assert.equal(r.status, 200)
  assert.equal(await r.text(), 'MZ-octets')
  assert.equal(r.headers.get('location'), null)
  assert.equal(r.headers.get('content-type'), 'application/octet-stream')
  assert.match(r.headers.get('content-disposition'), /Flitdrop-Setup-0\.7\.1-store\.exe/)
  assert.equal(calls[0].url, 'https://github.com/MrFrosas/flitdrop/releases/download/v0.7.1/Flitdrop-Setup-0.7.1.exe')
  assert.equal(calls[0].init.redirect, 'follow')
})

test('dl : reprise (Range) relayée, HEAD sans corps', async () => {
  const calls = upstream(206, 'Z', { 'content-range': 'bytes 1-1/2' })
  const r = await get('Flitdrop-Setup-0.7.1.exe', { headers: { range: 'bytes=1-' } })
  assert.equal(r.status, 206)
  assert.equal(r.headers.get('content-range'), 'bytes 1-1/2')
  assert.equal(calls[0].init.headers.get('range'), 'bytes=1-')
  upstream(200)
  const h = await get('Flitdrop-Setup-0.7.1-store.exe', { method: 'HEAD' })
  assert.equal(h.status, 200)
  assert.equal(await h.text(), '')
})

test('dl : tout autre nom refusé sans appeler GitHub', async () => {
  const calls = upstream(200)
  for (const f of ['../secret', 'Flitdrop-Setup-0.7.1.exe.blockmap', 'Flitdrop-0.7.1-arm64.dmg', 'Flitdrop-Setup-0.7.1-store.exe?x', 'latest.yml', 'Flitdrop-Setup-1.2.3.4.exe']) {
    assert.equal((await get(f)).status, 404, f)
  }
  assert.equal((await get('Flitdrop-Setup-0.7.1.exe', { method: 'POST' })).status, 405)
  assert.equal(calls.length, 0)
})

test('dl : version absente de GitHub = 404, autre panne = 502', async () => {
  upstream(404)
  assert.equal((await get('Flitdrop-Setup-9.9.9-store.exe')).status, 404)
  upstream(500)
  assert.equal((await get('Flitdrop-Setup-0.7.1-store.exe')).status, 502)
})
