import { describe, it, expect, vi, afterEach } from 'vitest'
import os from 'node:os'
import { rankIPv4s, localIPv4s, type NetIface } from '../src/util.js'

// Fausses tables os.networkInterfaces(), par système. L'ordre des cartes
// compte : il reproduit les cas où l'ancien calcul mettait une carte
// virtuelle dans le QR code.
type Table = Record<string, NetIface[]>
const v4 = (address: string, mac = '11:22:33:44:55:66'): NetIface => ({ address, family: 'IPv4', internal: false, mac })
const v6 = (address: string): NetIface => ({ address, family: 'IPv6', internal: false, mac: '11:22:33:44:55:66' })
const lo: NetIface = { address: '127.0.0.1', family: 'IPv4', internal: true, mac: '00:00:00:00:00:00' }

// ancien calcul, recopié tel quel : la référence du repli
function legacy(table: Table): string[] {
  const out: { ip: string; score: number }[] = []
  for (const [ifname, addrs] of Object.entries(table)) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue
      let score = 0
      if (a.address.startsWith('192.168.')) score = 3
      else if (a.address.startsWith('10.')) score = 2
      else if (/^172\.(1[6-9]|2\d|3[01])\./.test(a.address)) score = 1
      if (/^(vmnet|vboxnet|docker|br-|utun|tun|tap|llw|awdl)/i.test(ifname)) score -= 5
      out.push({ ip: a.address, score })
    }
  }
  return out.sort((x, y) => y.score - x.score).map((x) => x.ip)
}

describe('adresse du QR code : Windows', () => {
  const win = (t: Table) => rankIPv4s(t, 'win32')

  it('VirtualBox, Hyper-V et WSL écartés au profit du wifi', () => {
    const t: Table = {
      'VirtualBox Host-Only Network': [v4('192.168.56.1', '0a:00:27:00:00:0c')],
      'vEthernet (Default Switch)': [v4('172.29.96.1', '00:15:5d:01:02:03')],
      'vEthernet (WSL (Hyper-V firewall))': [v4('172.20.0.1', '00:15:5d:0a:0b:0c')],
      'Wi-Fi': [v6('fe80::1'), v4('192.168.1.20')],
      'Loopback Pseudo-Interface 1': [lo],
    }
    expect(legacy(t)[0]).toBe('192.168.56.1')
    expect(win(t)[0]).toBe('192.168.1.20')
  })

  it('VMware écarté, même quand le vrai réseau est en 10.x', () => {
    const t: Table = {
      'VMware Network Adapter VMnet1': [v4('192.168.10.1', '00:50:56:c0:00:01')],
      'VMware Network Adapter VMnet8': [v4('192.168.40.1', '00:50:56:c0:00:08')],
      Ethernet: [v4('10.0.0.5')],
    }
    expect(legacy(t)[0]).toBe('192.168.10.1')
    expect(win(t)[0]).toBe('10.0.0.5')
  })

  it('carte VirtualBox au nom banal (« Ethernet 2 ») reconnue à son adresse MAC', () => {
    const t: Table = {
      'Ethernet 2': [v4('192.168.56.1', '0A:00:27:00:00:05')],
      'Wi-Fi': [v4('172.16.3.8')],
    }
    expect(win(t)[0]).toBe('172.16.3.8')
  })

  it('point d’accès mobile du PC en marche : c’est lui que le téléphone rejoint', () => {
    const t: Table = {
      'Wi-Fi': [v4('192.168.1.20')],
      'Local Area Connection* 10': [v4('192.168.137.1', '1e:22:33:44:55:66')],
    }
    expect(win(t)[0]).toBe('192.168.137.1')
    expect(win(t)).toContain('192.168.1.20')
  })

  it('point d’accès coupé (adresse de secours 169.254) : le wifi, et le 169.254 disparaît', () => {
    const t: Table = {
      'Connexion au réseau local* 2': [v4('169.254.12.34', '1e:22:33:44:55:66')],
      'Wi-Fi': [v4('192.168.0.14')],
    }
    expect(win(t)).toEqual(['192.168.0.14'])
  })

  it('Hamachi, Radmin, Tailscale et ZeroTier écartés', () => {
    const t: Table = {
      Hamachi: [v4('25.12.34.56', '7a:79:19:00:00:01')],
      'Radmin VPN': [v4('26.1.2.3', '02:50:aa:bb:cc:dd')],
      Tailscale: [v4('100.101.102.103', '00:00:00:00:00:00')],
      'ZeroTier One [8056c2e21c000001]': [v4('10.147.17.5', '52:12:34:56:78:90')],
      WLAN: [v4('172.16.5.4')],
    }
    expect(win(t)[0]).toBe('172.16.5.4')
  })

  it('carte TAP d’OpenVPN au nom banal écartée (adresse MAC 00:FF)', () => {
    const t: Table = {
      'Ethernet 3': [v4('10.8.0.6', '00:FF:6B:2A:11:22')],
      'Wi-Fi 2': [v4('10.1.1.20')],
    }
    expect(win(t)[0]).toBe('10.1.1.20')
  })

  it('commutateur externe Hyper-V : la vraie carte est sur vEthernet, gardée', () => {
    const t: Table = {
      'vEthernet (Default Switch)': [v4('172.29.96.1', '00:15:5d:01:02:03')],
      'vEthernet (Commutateur externe)': [v4('192.168.1.30', '00:15:5d:04:05:06')],
    }
    expect(win(t)[0]).toBe('192.168.1.30')
  })

  it('noms allemands et français : WLAN, LAN-Verbindung', () => {
    const t: Table = {
      'vEthernet (WSL)': [v4('172.21.0.1', '00:15:5d:aa:bb:cc')],
      'LAN-Verbindung* 3': [v4('169.254.1.1')],
      WLAN: [v4('192.168.178.20')],
    }
    expect(win(t)[0]).toBe('192.168.178.20')
  })

  it('deux vraies cartes : l’ancien classement départage (192.168 avant 10.x)', () => {
    const t: Table = {
      Ethernet: [v4('10.0.0.2')],
      'Wi-Fi': [v4('192.168.1.3')],
    }
    expect(win(t)).toEqual(['192.168.1.3', '10.0.0.2'])
  })
})

describe('adresse du QR code : macOS', () => {
  const mac = (t: Table) => rankIPv4s(t, 'darwin')

  it('Tailscale, VPN, UTM, VMware et Docker écartés au profit de en0', () => {
    const t: Table = {
      lo0: [lo],
      bridge100: [v4('192.168.64.1', '36:12:34:56:78:64')],
      vmnet8: [v4('172.16.231.1', '00:50:56:c0:00:08')],
      utun3: [v4('100.88.1.2', '00:00:00:00:00:00')],
      utun4: [v4('10.200.0.12', '00:00:00:00:00:00')],
      en0: [v6('fe80::1'), v4('10.0.1.23')],
      awdl0: [v6('fe80::2')],
    }
    expect(legacy(t)[0]).toBe('192.168.64.1')
    expect(mac(t)[0]).toBe('10.0.1.23')
  })

  it('partage de connexion du Mac en marche : bridge100 en 192.168.2.1 d’abord', () => {
    const t: Table = {
      en1: [v4('10.0.0.2')],
      bridge100: [v4('192.168.2.1', '3a:11:22:33:44:64')],
    }
    expect(mac(t)[0]).toBe('192.168.2.1')
  })

  it('Mac qui partage son wifi vers un appareil filaire : en0 reste dans le QR', () => {
    const t: Table = {
      en0: [v4('192.168.1.20')],
      bridge100: [v4('192.168.2.1', '3a:11:22:33:44:64')],
    }
    expect(mac(t)[0]).toBe('192.168.1.20')
  })

  it('pont Thunderbolt et adresse de secours ignorés, carte USB-Ethernet gardée', () => {
    const t: Table = {
      bridge0: [v4('169.254.44.1')],
      en0: [v4('169.254.10.2')],
      en7: [v4('192.168.1.51')],
    }
    expect(mac(t)).toEqual(['192.168.1.51'])
  })
})

describe('adresse du QR code : Linux', () => {
  const lin = (t: Table) => rankIPv4s(t, 'linux')

  it('Docker, libvirt et ponts de conteneurs écartés au profit du wifi', () => {
    const t: Table = {
      lo: [lo],
      virbr0: [v4('192.168.122.1', '52:54:00:12:34:56')],
      docker0: [v4('172.17.0.1', '02:42:ac:11:00:01')],
      'br-3f1a2b': [v4('172.18.0.1', '02:42:ac:12:00:01')],
      wlp2s0: [v4('192.168.1.44')],
    }
    expect(legacy(t)[0]).toBe('192.168.122.1')
    expect(lin(t)[0]).toBe('192.168.1.44')
  })

  it('point d’accès de NetworkManager (10.42.0.1) d’abord', () => {
    const t: Table = {
      eth0: [v4('192.168.1.2')],
      wlan0: [v4('10.42.0.1')],
    }
    expect(lin(t)[0]).toBe('10.42.0.1')
  })

  it('Tailscale, ZeroTier, WireGuard et Hamachi écartés', () => {
    const t: Table = {
      tailscale0: [v4('100.64.0.5', '00:00:00:00:00:00')],
      ztabcdef12: [v4('192.168.192.10', 'aa:bb:cc:dd:ee:ff')],
      wg0: [v4('10.6.0.2', '00:00:00:00:00:00')],
      ham0: [v4('25.9.8.7', '7a:79:19:00:00:02')],
      enp3s0: [v4('172.20.10.4')],
    }
    expect(lin(t)[0]).toBe('172.20.10.4')
  })

  it('k3s : le pont de conteneurs cni0 (10.42.0.1) n’est pas un point d’accès', () => {
    const t: Table = {
      wlp2s0: [v4('192.168.1.20')],
      cni0: [v4('10.42.0.1', '5a:11:22:33:44:55')],
      'flannel.1': [v4('10.42.0.0', '6e:11:22:33:44:55')],
    }
    expect(lin(t)[0]).toBe('192.168.1.20')
    // même adresse sur une carte filaire : pas un point d'accès wifi, l'ancien classement décide
    expect(lin({ eth0: [v4('192.168.1.20')], enp3s0: [v4('10.42.0.1')] })[0]).toBe('192.168.1.20')
  })

  it('pont br0 d’un hôte de machines virtuelles (vraie carte) gardé', () => {
    const t: Table = {
      virbr0: [v4('192.168.122.1', '52:54:00:12:34:56')],
      br0: [v4('192.168.1.60', 'a8:a1:59:00:11:22')],
    }
    expect(lin(t)[0]).toBe('192.168.1.60')
  })
})

describe('adresse du QR code : jamais pire qu’avant', () => {
  it('tout est écarté : exactement l’ancien classement', () => {
    const tables: Table[] = [
      { docker0: [v4('172.17.0.1', '02:42:ac:11:00:01')] },
      { en0: [v4('169.254.3.4')] },
      { 'VirtualBox Host-Only Network': [v4('192.168.56.1', '0a:00:27:00:00:0c')], Tailscale: [v4('100.100.1.1')] },
    ]
    for (const t of tables) {
      for (const p of ['win32', 'darwin', 'linux']) expect(rankIPv4s(t, p)).toEqual(legacy(t))
    }
  })

  it('rien du tout : liste vide comme avant', () => {
    expect(rankIPv4s({ lo: [lo] }, 'linux')).toEqual([])
    expect(rankIPv4s({}, 'win32')).toEqual([])
  })

  it('famille notée 4 (anciens Node) acceptée', () => {
    expect(rankIPv4s({ eth0: [{ address: '192.168.1.9', family: 4, internal: false }] }, 'linux')).toEqual(['192.168.1.9'])
  })

  it('tables tirées au hasard : jamais vide si l’ancien calcul trouvait, jamais d’adresse inventée', () => {
    const names = ['Wi-Fi', 'Ethernet', 'en0', 'wlan0', 'docker0', 'vmnet1', 'utun2', 'vEthernet (WSL)', 'Hamachi', 'bridge100', 'Local Area Connection* 3', 'br0', 'tailscale0']
    const ips = ['192.168.1.5', '10.0.0.7', '172.17.0.1', '169.254.9.9', '100.70.1.1', '25.1.1.1', '192.168.137.1', '192.168.2.1', '10.42.0.1', '8.8.4.4']
    const macs = ['11:22:33:44:55:66', '0a:00:27:00:00:01', '00:50:56:00:00:01', '00:00:00:00:00:00', '00:15:5d:00:00:01']
    let seed = 42
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed % n
    }
    for (let i = 0; i < 2000; i++) {
      const t: Table = {}
      const count = rnd(5)
      for (let j = 0; j < count; j++) {
        const name = names[rnd(names.length)]!
        ;(t[name] ??= []).push(v4(ips[rnd(ips.length)]!, macs[rnd(macs.length)]!))
      }
      for (const p of ['win32', 'darwin', 'linux']) {
        const out = rankIPv4s(t, p)
        const old = legacy(t)
        if (old.length > 0) expect(out.length).toBeGreaterThan(0)
        for (const ip of out) expect(old).toContain(ip)
      }
    }
  })

  it('localIPv4s lit bien les cartes du système', () => {
    const spy = vi.spyOn(os, 'networkInterfaces').mockReturnValue({
      docker0: [{ address: '172.17.0.1', family: 'IPv4', internal: false, mac: '02:42:ac:11:00:01', netmask: '255.255.0.0', cidr: '172.17.0.1/16' }],
      eth0: [{ address: '192.168.1.77', family: 'IPv4', internal: false, mac: '11:22:33:44:55:66', netmask: '255.255.255.0', cidr: '192.168.1.77/24' }],
    } as ReturnType<typeof os.networkInterfaces>)
    try {
      expect(localIPv4s()[0]).toBe('192.168.1.77')
    } finally {
      spy.mockRestore()
    }
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})
