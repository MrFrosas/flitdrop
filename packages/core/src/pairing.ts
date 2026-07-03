import fs from 'node:fs'
import path from 'node:path'
import { newKey, randomToken } from './crypto.js'
import { b64u, timingSafeEqualStr } from './util.js'

export interface Device {
  id: string
  name: string
  keyB64: string
  shortcutToken: string
  platform?: string
  status: 'pending' | 'active'
  createdAt: string
  lastSeenAt?: string
}

export class DeviceStore {
  private file: string
  private devices = new Map<string, Device>()

  constructor(home: string) {
    this.file = path.join(home, 'devices.json')
    try {
      const list = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Device[]
      for (const d of list) if (d && d.id && d.keyB64) this.devices.set(d.id, d)
    } catch {
      // pas encore d'appareils
    }
  }

  private save(): void {
    fs.writeFileSync(this.file, JSON.stringify([...this.devices.values()], null, 2))
  }

  create(): Device {
    const d: Device = {
      id: randomToken(9),
      name: 'Nouvel appareil',
      keyB64: b64u.enc(newKey()),
      shortcutToken: randomToken(18),
      status: 'pending',
      createdAt: new Date().toISOString(),
    }
    this.devices.set(d.id, d)
    this.save()
    return d
  }

  get(id: string): Device | undefined {
    return this.devices.get(id)
  }

  key(id: string): Uint8Array | undefined {
    const d = this.devices.get(id)
    return d ? b64u.dec(d.keyB64) : undefined
  }

  byShortcutToken(token: string): Device | undefined {
    for (const d of this.devices.values()) {
      if (d.status === 'active' && timingSafeEqualStr(d.shortcutToken, token)) return d
    }
    return undefined
  }

  /** Retourne true si l'appareil vient d'être appairé (était en attente). */
  activate(id: string, info: { name?: string; platform?: string }): boolean {
    const d = this.devices.get(id)
    if (!d) return false
    const wasPending = d.status === 'pending'
    if (wasPending && info.name) d.name = info.name.slice(0, 40)
    if (info.platform) d.platform = info.platform.slice(0, 24)
    d.status = 'active'
    d.lastSeenAt = new Date().toISOString()
    this.save()
    return wasPending
  }

  touch(id: string): void {
    const d = this.devices.get(id)
    if (!d) return
    const last = d.lastSeenAt ? Date.parse(d.lastSeenAt) : 0
    d.lastSeenAt = new Date().toISOString()
    if (Date.now() - last > 60_000) this.save()
  }

  rename(id: string, name: string): boolean {
    const d = this.devices.get(id)
    if (!d) return false
    d.name = name.slice(0, 40) || d.name
    this.save()
    return true
  }

  revoke(id: string): boolean {
    const ok = this.devices.delete(id)
    if (ok) this.save()
    return ok
  }

  prunePending(maxAgeMs: number): void {
    let changed = false
    const now = Date.now()
    for (const d of [...this.devices.values()]) {
      if (d.status === 'pending' && now - Date.parse(d.createdAt) > maxAgeMs) {
        this.devices.delete(d.id)
        changed = true
      }
    }
    if (changed) this.save()
  }

  listPublic() {
    return [...this.devices.values()].map((d) => ({
      id: d.id,
      name: d.name,
      platform: d.platform,
      status: d.status,
      createdAt: d.createdAt,
      lastSeenAt: d.lastSeenAt,
      shortcutToken: d.shortcutToken,
    }))
  }
}
