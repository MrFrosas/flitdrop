import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { startServer, portCandidates, iconPcName, phoneAppTitle, phonePageHtml, phoneManifest, type RunningServer } from '../src/server.js'
import { loadConfig } from '../src/config.js'

// Adresse stable (port mémorisé) et nom du PC sur l'icône du téléphone.

const readCfg = (home: string) => JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')) as { port: number }

function occupy(): Promise<net.Server> {
  return new Promise((resolve) => {
    const s = net.createServer()
    s.listen(0, '0.0.0.0', () => resolve(s))
  })
}

describe('port mémorisé', () => {
  it('ordre des essais : le port mémorisé, des ports fixes voisins, puis un port libre', () => {
    expect(portCandidates(47777)).toEqual([47777, 47778, 47779, 47780, 47781, 47782, 47783, 47784, 47785, 47786, 47787, 0])
    const c = portCandidates(51000)
    expect(c[0]).toBe(51000)
    expect(c[1]).toBe(47777)
    expect(c.at(-1)).toBe(0)
    expect(portCandidates(0)).toEqual([0])
  })

  it('port occupé : un autre port, écrit dans config.json, repris au lancement suivant', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-port-'))
    const blocker = await occupy()
    const busy = (blocker.address() as net.AddressInfo).port
    loadConfig(home)
    const cfg = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'))
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ ...cfg, port: busy }))
    let srv: RunningServer | undefined
    try {
      srv = await startServer({ home, quiet: true, disableClipboard: true })
      expect(srv.port).not.toBe(busy)
      expect(readCfg(home).port).toBe(srv.port)
      expect(srv.cfg.port).toBe(srv.port)
      const first = srv.port
      await srv.close()
      srv = await startServer({ home, quiet: true, disableClipboard: true })
      // même adresse qu'au lancement précédent : l'icône du téléphone marche encore
      expect(srv.port).toBe(first)
      expect(readCfg(home).port).toBe(first)
    } finally {
      await srv?.close()
      blocker.close()
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('port imposé (tests, ligne de commande) : rien n’est mémorisé', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-port-'))
    const srv = await startServer({ home, port: 0, quiet: true, disableClipboard: true })
    try {
      expect(readCfg(home).port).toBe(47777)
      // un enregistrement des réglages ne l'écrit pas non plus
      await fetch(`http://127.0.0.1:${srv.port}/api/admin/settings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-admin-token': srv.adminToken },
        body: JSON.stringify({ deviceName: 'Test' }),
      })
      expect(readCfg(home).port).toBe(47777)
    } finally {
      await srv.close()
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('un port illisible dans config.json revient au port par défaut', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-port-'))
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ port: 'abc' }))
    expect(loadConfig(home).port).toBe(47777)
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ port: 70000 }))
    expect(loadConfig(home).port).toBe(47777)
    fs.rmSync(home, { recursive: true, force: true })
  })
})

describe('nom de l’icône du téléphone', () => {
  it('nom court et propre', () => {
    expect(phoneAppTitle('TOUR')).toBe('Flitdrop · TOUR')
    expect(iconPcName('  Mac\u0000Book ‮ de  Tom ')).toBe('MacBook de Tom')
    expect(iconPcName('')).toBe('PC')
    expect(iconPcName('<>')).toBe('PC')
    const long = iconPcName('Ordinateur du salon de la maison de campagne')
    expect([...long].length).toBeLessThanOrEqual(20)
    expect(long.endsWith('…')).toBe(true)
  })

  it('page : titre de l’icône iPhone et titre de la page, sans injection', () => {
    const html = '<meta name="apple-mobile-web-app-title" content="Flitdrop">\n<title>Flitdrop</title>'
    const out = phonePageHtml(html, 'A"B & $1')
    expect(out).toContain('<meta name="apple-mobile-web-app-title" content="Flitdrop · A&quot;B &amp; $1">')
    expect(out).toContain('<title>Flitdrop · A&quot;B &amp; $1</title>')
  })

  it('manifeste : nom et nom court pour Android', () => {
    const m = JSON.parse(phoneManifest(JSON.stringify({ name: 'Flitdrop', short_name: 'Flitdrop', start_url: '/s/' }), 'TOUR'))
    expect(m).toMatchObject({ name: 'Flitdrop · TOUR', short_name: 'Flitdrop · TOUR', start_url: '/s/' })
  })

  describe('servis par le PC', () => {
    let srv: RunningServer
    let home = ''
    beforeAll(async () => {
      home = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-icon-'))
      srv = await startServer({ home, port: 0, quiet: true, disableClipboard: true })
      srv.cfg.deviceName = 'TOUR <Bureau>'
    })
    afterAll(async () => {
      await srv.close()
      fs.rmSync(home, { recursive: true, force: true })
    })

    it('la page du téléphone porte le nom du PC', async () => {
      for (const p of ['/s/', '/s/index.html']) {
        const r = await fetch(`http://127.0.0.1:${srv.port}${p}`)
        expect(r.status).toBe(200)
        expect(r.headers.get('cache-control')).toBe('no-store')
        const html = await r.text()
        expect(html).toContain('content="Flitdrop · TOUR Bureau"')
        expect(html).toContain('<title>Flitdrop · TOUR Bureau</title>')
        expect(html).toContain('<script src="app.js"></script>')
      }
    })

    it('« /s » sans barre finale redirige toujours vers « /s/ »', async () => {
      const r = await fetch(`http://127.0.0.1:${srv.port}/s`, { redirect: 'manual' })
      expect(r.status).toBeGreaterThanOrEqual(300)
      expect(r.status).toBeLessThan(400)
      expect(r.headers.get('location')).toBe('/s/')
    })

    it('le manifeste suit un changement de nom', async () => {
      srv.cfg.deviceName = 'MacBook'
      const r = await fetch(`http://127.0.0.1:${srv.port}/s/manifest.webmanifest`)
      expect(r.status).toBe(200)
      expect(r.headers.get('content-type')).toContain('application/manifest+json')
      const m = (await r.json()) as { name: string; short_name: string; icons: unknown[] }
      expect(m.name).toBe('Flitdrop · MacBook')
      expect(m.short_name).toBe('Flitdrop · MacBook')
      expect(m.icons.length).toBeGreaterThan(0)
    })
  })
})
