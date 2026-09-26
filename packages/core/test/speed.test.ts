import { describe, it, expect, beforeEach } from 'vitest'
import { SpeedMeter, etaSeconds, fmtDuration, progressText } from '../src/webclient/speed.js'
import { speedVerdict, speedLimit, type SpeedFacts } from '../src/webclient/speedverdict.js'
import { parseMacWifi, parseNetsh, ifaceOfAddress, pcLink, _resetPcLinkCache } from '../src/wifi.js'

const MB = 1024 * 1024

describe('vitesse affichée pendant un transfert', () => {
  it('mesure les dernières secondes, pas la moyenne depuis le début', () => {
    let now = 0
    const m = new SpeedMeter(5000, () => now)
    m.add(0)
    expect(m.rate()).toBeNull() // pas encore assez vu
    // 10 s à 1 Mo/s, puis 10 s à 20 Mo/s
    let total = 0
    for (let s = 1; s <= 10; s++) {
      now = s * 1000
      m.add((total += MB))
    }
    for (let s = 11; s <= 20; s++) {
      now = s * 1000
      m.add((total += 20 * MB))
    }
    expect(m.rate()! / MB).toBeCloseTo(20, 5)
  })

  it('un transfert bloqué voit sa vitesse descendre au lieu de rester figée', () => {
    let now = 0
    const m = new SpeedMeter(5000, () => now)
    for (let s = 0; s <= 5; s++) {
      now = s * 1000
      m.add(s * 10 * MB)
    }
    const before = m.rate()!
    now = 15_000 // 10 s sans un octet (écran verrouillé)
    expect(m.rate()!).toBeLessThan(before / 2)
  })

  it('une reprise (total qui recule) repart d’une mesure neuve', () => {
    let now = 0
    const m = new SpeedMeter(5000, () => now)
    m.add(50 * MB)
    now = 1000
    m.add(10 * MB)
    expect(m.rate()).toBeNull()
  })

  it('temps restant et durées en mots courts', () => {
    expect(etaSeconds(100, null)).toBeNull()
    expect(etaSeconds(100, 0)).toBeNull()
    expect(etaSeconds(100, 50)).toBe(2)
    expect(fmtDuration('fr', 12.4)).toBe('12 s')
    expect(fmtDuration('fr', 200)).toBe('3 min 20 s')
    expect(fmtDuration('fr', 1500)).toBe('25 min')
    expect(fmtDuration('fr', 3 * 3600 + 5 * 60)).toBe('3 h 05')
    expect(fmtDuration('en', 3 * 3600 + 5 * 60)).toBe('3 h 05 min')
    expect(progressText('fr', 42 * MB, 100 * MB, null)).toBe('42 %')
    expect(progressText('fr', 50 * MB, 100 * MB, 10 * MB)).toBe('50 % · 10 Mo/s · encore 5 s')
    expect(progressText('en', 50 * MB, 100 * MB, 10 * MB)).toBe('50 % · 10 MB/s · 5 s left')
    expect(progressText('de', 50 * MB, 100 * MB, 10 * MB)).toBe('50 % · 10 MB/s · noch 5 s')
  })

  it('aucun tiret long ni demi-cadratin dans les textes', () => {
    for (const lang of ['fr', 'en', 'de'] as const) expect(progressText(lang, 1, 2, 3)).not.toMatch(/[\u2013\u2014]/)
  })
})

describe('verdict du test de vitesse', () => {
  const base: SpeedFacts = { down: 40 * MB, up: 35 * MB, crypto: 60 * MB, noWasm: false, ios: true, pc: null }

  it('tout va bien : la vitesse attendue et le temps pour 1 Go', () => {
    const lines = speedVerdict('fr', base)
    expect(speedLimit(base)).toBe('none')
    expect(lines.at(-1)).toEqual({ text: expect.stringMatching(/^Tout va bien : environ 35 Mo\/s\. Une vidéo de 1 Go passe en 29 s environ\.$/), strong: true })
  })

  it('téléphone qui chiffre lentement (mode Isolement) : c’est lui qui freine, avec la sortie', () => {
    const f = { ...base, crypto: 2 * MB, noWasm: true }
    expect(speedLimit(f)).toBe('phone')
    const text = speedVerdict('fr', f).map((l) => l.text)
    expect(text).toContain('C’est ce téléphone qui freine : il ne chiffre qu’à 2 Mo/s, le wifi irait plus vite.')
    expect(text.join(' ')).toMatch(/mode Isolement/)
  })

  it('wifi lent, PC en 2,4 GHz : passer en 5 GHz', () => {
    const f: SpeedFacts = { ...base, down: 2 * MB, up: 1.5 * MB, pc: { via: 'wifi', band: '2.4', linkMbps: 72, signalDbm: -60 } }
    expect(speedLimit(f)).toBe('wifi')
    const text = speedVerdict('fr', f).map((l) => l.text)
    expect(text).toContain('Le PC est en wifi 2,4 GHz, relié à 72 Mbit/s.')
    expect(text).toContain('Ton PC est en wifi 2,4 GHz, qui est lent : passe-le sur le réseau 5 GHz de ta box.')
    expect(speedVerdict('en', f).map((l) => l.text)).toContain('The PC is on 2.4 GHz Wi-Fi, linked at 72 Mbit/s.')
  })

  it('wifi lent, PC en 5 GHz mais signal faible, ou lien lent, ou rien de spécial : le bon conseil', () => {
    const slow = { ...base, down: 3 * MB, up: 3 * MB }
    const weak = speedVerdict('fr', { ...slow, pc: { via: 'wifi', band: '5', linkMbps: 400, signalDbm: -78 } }).map((l) => l.text)
    expect(weak.join(' ')).toMatch(/signal wifi du PC est faible/)
    const link = speedVerdict('fr', { ...slow, pc: { via: 'wifi', band: '5', linkMbps: 90, signalDbm: -50 } }).map((l) => l.text)
    expect(link.join(' ')).toMatch(/qu’à 90 Mbit\/s/)
    const cable = speedVerdict('fr', { ...slow, pc: { via: 'wifi', band: '5', linkMbps: 866, signalDbm: -50 } }).map((l) => l.text)
    expect(cable.join(' ')).toMatch(/Branche le PC à la box avec un câble/)
    const wired = speedVerdict('fr', { ...slow, pc: { via: 'cable' } }).map((l) => l.text)
    expect(wired).toContain('Le PC est branché en câble.')
    expect(wired.join(' ')).not.toMatch(/Branche le PC/)
    expect(wired.join(' ')).toMatch(/5 GHz de ta box/)
  })

  it('les trois langues ont chaque phrase', () => {
    const f: SpeedFacts = { ...base, down: 2 * MB, up: 2 * MB, crypto: 1 * MB, noWasm: true, pc: { via: 'wifi', band: '2.4', linkMbps: 50 } }
    for (const lang of ['fr', 'en', 'de'] as const)
      for (const l of speedVerdict(lang, f)) {
        expect(l.text).not.toMatch(/^st\./)
        expect(l.text).not.toMatch(/[\u2013\u2014]/)
      }
  })
})

describe('comment le PC est relié (lu à la demande)', () => {
  beforeEach(() => _resetPcLinkCache())

  it('macOS : bande, débit et signal depuis system_profiler', () => {
    const json = JSON.stringify({
      SPAirPortDataType: [
        {
          spairport_airport_interfaces: [
            {
              _name: 'en0',
              spairport_current_network_information: {
                _name: 'MaBox',
                spairport_network_channel: '36 (5GHz, 80MHz)',
                spairport_network_phymode: '802.11ax',
                spairport_network_rate: 720,
                spairport_signal_noise: '-58 dBm / -88 dBm',
              },
            },
            { _name: 'awdl0', spairport_current_network_information: { spairport_network_type: 'spairport_network_type_station' } },
          ],
        },
      ],
    })
    expect(parseMacWifi(json)).toEqual({ iface: 'en0', band: '5', linkMbps: 720, phy: '802.11ax', signalDbm: -58 })
    expect(parseMacWifi('{}')).toBeNull()
    expect(parseMacWifi('pas du json')).toBeNull()
  })

  it('Windows : netsh en anglais et en français', () => {
    const en = `
There is 1 interface on the system:

    Name                   : Wi-Fi
    Description            : Intel(R) Wi-Fi 6 AX201 160MHz
    State                  : connected
    SSID                   : MaBox
    Radio type             : 802.11n
    Band                   : 2.4 GHz
    Channel                : 6
    Receive rate (Mbps)    : 144.4
    Transmit rate (Mbps)   : 130
    Signal                 : 42%
`
    expect(parseNetsh(en)).toEqual({ iface: 'Wi-Fi', phy: '802.11n', band: '2.4', linkMbps: 144.4, signalPct: 42 })
    const fr = `
Il existe 1 interface sur le système :

    Nom                    : Wi-Fi
    État                   : connecté
    Type de radio          : 802.11ax
    Canal                  : 44
    Réception (Mbits/s)    : 1201
    Transmission (Mbits/s) : 960
    Signal                 : 90%
`
    expect(parseNetsh(fr)).toEqual({ iface: 'Wi-Fi', phy: '802.11ax', band: '5', linkMbps: 1201, signalPct: 90 })
    // Windows 24H2 sans autorisation de position : netsh refuse, rien de lu
    expect(parseNetsh('')).toBeNull()
  })

  it('téléphone arrivé par une autre interface que le wifi : le PC est en câble', async () => {
    const ifs = { en0: [{ address: '192.168.1.20' }], en7: [{ address: '192.168.1.30' }] } as never
    expect(ifaceOfAddress('::ffff:192.168.1.30', ifs)).toBe('en7')
    expect(ifaceOfAddress(undefined, ifs)).toBeUndefined()
    const read = async () => ({ iface: 'une-interface-wifi-absente', band: '5' as const, linkMbps: 500 })
    // adresse locale d'une interface qui n'est pas le wifi (loopback)
    expect(await pcLink('127.0.0.1', read)).toEqual({ via: 'cable' })
    _resetPcLinkCache()
    expect(await pcLink(undefined, async () => null)).toEqual({ via: 'unknown' })
    _resetPcLinkCache()
    expect(await pcLink(undefined, read)).toEqual({ via: 'wifi', band: '5', linkMbps: 500 })
  })

  it('lu une seule fois par minute, même si on redemande', async () => {
    let calls = 0
    const read = async () => {
      calls++
      return null
    }
    await pcLink(undefined, read)
    await pcLink(undefined, read)
    await Promise.all([pcLink(undefined, read), pcLink(undefined, read)])
    expect(calls).toBe(1)
  })
})
