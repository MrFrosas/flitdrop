import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startServer, type RunningServer } from '../src/server.js'
import { opensDirectly, revealCommand } from '../src/util.js'

let srv: RunningServer
let base = ''
let home = ''
const opened: string[] = []
const revealed: string[] = []

const post = (body: unknown) =>
  fetch(base + '/api/admin/open-received', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-token': srv.adminToken },
    body: JSON.stringify(body),
  })

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-open-'))
  const dl = path.join(home, 'dl')
  fs.mkdirSync(dl, { recursive: true })
  const photo = path.join(dl, 'IMG_0001.HEIC')
  const prog = path.join(dl, 'setup.exe')
  const jpg = path.join(dl, 'IMG_0002.jpg')
  fs.writeFileSync(photo, 'x')
  fs.writeFileSync(prog, 'x')
  fs.writeFileSync(jpg, 'jpegdata')
  const entry = (id: string, p: string, extra = {}) => ({ id, ts: new Date().toISOString(), dir: 'in', kind: 'file', name: path.basename(p), size: 1, status: 'ok', path: p, ...extra })
  fs.writeFileSync(
    path.join(home, 'history.json'),
    JSON.stringify([
      entry('photo', photo),
      entry('prog', prog),
      entry('jpg', jpg),
      entry('gone', path.join(dl, 'parti.jpg')),
      entry('sent', photo, { dir: 'out' }),
      entry('failed', photo, { status: 'error' }),
    ])
  )
  process.env.FLITDROP_DOWNLOADS = dl
  srv = await startServer({
    port: 0,
    home,
    disableClipboard: true,
    openPath: (p: string) => void opened.push(p),
    revealPath: (p: string) => void revealed.push(p),
    // miniature du système : seulement pour la photo HEIC ici
    thumbnail: async (p: string) => (p.endsWith('.HEIC') ? Buffer.from('png!') : null),
  })
  base = `http://127.0.0.1:${srv.port}`
})

afterAll(async () => {
  await srv?.close()
  fs.rmSync(home, { recursive: true, force: true })
})

describe('fichier reçu ouvert d’un clic', () => {
  it('une photo s’ouvre directement ; « Afficher dans le dossier » la sélectionne', async () => {
    const r = await post({ id: 'photo' })
    expect(r.status).toBe(200)
    expect((await r.json()).opened).toBe(true)
    expect(opened.at(-1)).toMatch(/IMG_0001\.HEIC$/)
    await post({ id: 'photo', reveal: true })
    expect(revealed.at(-1)).toMatch(/IMG_0001\.HEIC$/)
  })

  it('un programme n’est jamais lancé : il est montré dans son dossier', async () => {
    const n = opened.length
    const r = await post({ id: 'prog' })
    expect((await r.json()).opened).toBe(false)
    expect(opened.length).toBe(n)
    expect(revealed.at(-1)).toMatch(/setup\.exe$/)
  })

  it('fichier disparu, envoi sortant, échec, id inconnu ou chemin : 404', async () => {
    for (const body of [{ id: 'gone' }, { id: 'sent' }, { id: 'failed' }, { id: 'nope' }, { id: path.join(home, 'config.json') }, {}]) {
      expect((await post(body)).status, JSON.stringify(body)).toBe(404)
    }
  })

  it('sans jeton du PC : refusé', async () => {
    const r = await fetch(base + '/api/admin/open-received', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"id":"photo"}' })
    expect(r.status).toBeGreaterThanOrEqual(401)
  })

  it('types ouverts directement, et commande pour afficher dans le dossier', () => {
    for (const f of ['a.jpg', 'B.HEIC', 'c.mov', 'd.pdf', 'e.docx']) expect(opensDirectly(f), f).toBe(true)
    for (const f of ['a.exe', 'b.bat', 'c.lnk', 'd.js', 'e.docm', 'f.zip', 'g', 'h.jpg.exe']) expect(opensDirectly(f), f).toBe(false)
    expect(revealCommand('/x/a.jpg', 'darwin')).toEqual(['/usr/bin/open', ['-R', '/x/a.jpg']])
    expect(revealCommand('C:\\x\\a.jpg', 'win32')).toEqual(['C:\\Windows\\explorer.exe', ['/select,C:\\x\\a.jpg']])
    expect(revealCommand('/x/a.jpg', 'linux')).toEqual(['xdg-open', ['/x']])
  })
})

describe('miniature d’un fichier reçu', () => {
  const thumb = (id: string, auth = true) =>
    fetch(base + '/api/admin/thumb/' + id, { headers: auth ? { 'x-admin-token': srv.adminToken } : {} })

  it('celle du système (HEIC), sinon l’image elle-même ; rien pour un programme ni sans jeton', async () => {
    const heic = await thumb('photo')
    expect(heic.status).toBe(200)
    expect(heic.headers.get('content-type')).toContain('image/png')
    expect(await heic.text()).toBe('png!')
    const jpg = await thumb('jpg')
    expect(jpg.status).toBe(200)
    expect(jpg.headers.get('content-type')).toContain('image/jpeg')
    expect(await jpg.text()).toBe('jpegdata')
    expect((await thumb('prog')).status).toBe(404)
    expect((await thumb('gone')).status).toBe(404)
    expect((await thumb('photo', false)).status).toBe(401)
  })
})
