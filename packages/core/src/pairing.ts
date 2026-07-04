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
  // identité du PC qui a créé cet appairage. Un appareil dont l'instanceId ne
  // correspond pas à ce PC est refusé (appairage lié à une autre machine).
  instanceId?: string
  // clé de session en ATTENTE de confirmation (rotation « make-before-break ») :
  // générée au 1er hello, renvoyée au téléphone, mais l'ancienne clé reste
  // valide jusqu'à ce qu'une requête arrive chiffrée sous la nouvelle (preuve
  // que le téléphone l'a bien reçue). Évite tout blocage si la réponse hello
  // se perd sur un wifi capricieux.
  pendingKeyB64?: string
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
    // 0600 : le fichier contient les clés des appareils ; on le garde lisible
    // par le seul propriétaire (sans effet sur Windows, utile sur macOS/Linux).
    fs.writeFileSync(this.file, JSON.stringify([...this.devices.values()], null, 2), { mode: 0o600 })
  }

  create(instanceId?: string): Device {
    const d: Device = {
      id: randomToken(9),
      name: 'Nouvel appareil',
      keyB64: b64u.enc(newKey()),
      shortcutToken: randomToken(18),
      status: 'pending',
      createdAt: new Date().toISOString(),
      instanceId,
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

  /** Démarre une rotation de clé (au tout premier hello) : génère une clé de
   *  session en attente SANS écraser la clé du QR. Idempotent : un hello répété
   *  (réponse perdue) renvoie la MÊME clé en attente, pas une nouvelle. */
  beginRotation(id: string): void {
    const d = this.devices.get(id)
    if (!d || d.pendingKeyB64) return
    d.pendingKeyB64 = b64u.enc(newKey())
    this.save()
  }

  /** Clé de session en attente (base64url) à renvoyer au téléphone, ou undefined. */
  pendingKey(id: string): string | undefined {
    return this.devices.get(id)?.pendingKeyB64
  }

  /** Clés à essayer pour déchiffrer une requête : la clé courante, puis la clé
   *  en attente (fenêtre de rotation). `pending:true` signale qu'ouvrir avec
   *  celle-ci doit déclencher la promotion. */
  candidateKeys(id: string): { key: Uint8Array; pending: boolean }[] {
    const d = this.devices.get(id)
    if (!d) return []
    const out = [{ key: b64u.dec(d.keyB64), pending: false }]
    if (d.pendingKeyB64) out.push({ key: b64u.dec(d.pendingKeyB64), pending: true })
    return out
  }

  /** Promotion : le téléphone a prouvé qu'il détient la clé de session ; elle
   *  devient la clé unique et l'ancienne (celle du QR) est abandonnée. */
  promoteKey(id: string): void {
    const d = this.devices.get(id)
    if (!d || !d.pendingKeyB64) return
    d.keyB64 = d.pendingKeyB64
    delete d.pendingKeyB64
    this.save()
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

  /** Oublie les appareils inactifs depuis très longtemps (hygiène : évite qu'un
   *  PC accumule d'anciens appairages, par ex. sur une machine partagée). */
  pruneIdle(maxIdleMs: number): number {
    let removed = 0
    const now = Date.now()
    for (const d of [...this.devices.values()]) {
      const last = d.lastSeenAt ? Date.parse(d.lastSeenAt) : Date.parse(d.createdAt)
      if (d.status === 'active' && now - last > maxIdleMs) {
        this.devices.delete(d.id)
        removed++
      }
    }
    if (removed > 0) this.save()
    return removed
  }

  /** Oublie TOUS les appareils (« Réinitialiser ce PC »). */
  clear(): number {
    const n = this.devices.size
    this.devices.clear()
    this.save()
    return n
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
