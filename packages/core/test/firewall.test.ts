import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  FIREWALL_RULE_NAME,
  UAC_CANCELLED,
  checkWindowsFirewall,
  encodePowerShell,
  evaluateFirewall,
  expandWinEnv,
  firewallDetectScript,
  firewallRepairLauncher,
  firewallRepairScript,
  networkOf,
  parseFirewallReport,
  powershellPath,
  psArgs,
  psQuote,
  profileNames,
  repairProfiles,
  repairResultOf,
  repairWindowsFirewall,
  runPowerShell,
  winPathKey,
  type FirewallStatus,
  type PsRunner,
  type RunResult,
} from '../src/firewall.js'
import { localIPv4s } from '../src/util.js'

// Pare-feu de Windows : lecture de la vérification (réponses JSON du script,
// Windows anglais et français, particularités de Windows PowerShell 5.1),
// conclusion, commande de réparation (guillemets, chemins avec espaces et
// accents), et exécution réelle sous Windows (CI).

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'firewall')
const fixture = (name: string) => fs.readFileSync(path.join(FIX, name), 'utf8')

const EXE_EN = 'C:\\Users\\thomas\\AppData\\Local\\Programs\\flitdrop\\Flitdrop.exe'
const EXE_FR = 'C:\\Users\\Zoé L’Hôte\\AppData\\Local\\Programs\\flitdrop\\Flitdrop.exe'
const EXE_ZOE = 'C:\\Users\\Zoé\\AppData\\Local\\Programs\\flitdrop\\Flitdrop.exe'
const ENV = { LOCALAPPDATA: 'C:\\Users\\Zoé\\AppData\\Local', SystemRoot: 'C:\\Windows' }

const verdict = (name: string, exe: string, env: NodeJS.ProcessEnv = ENV): FirewallStatus => {
  const rep = parseFirewallReport(fixture(name))
  expect(rep, name).not.toBeNull()
  return evaluateFirewall(rep!, exe, env)
}

// décode une commande -EncodedCommand
const decode = (b64: string) => Buffer.from(b64, 'base64').toString('utf16le')

describe('pare-feu : lecture des réponses du script', () => {
  it('Windows anglais, wifi public, « Annuler » à l’invite : bloqué, à autoriser dans le pare-feu', () => {
    expect(verdict('en-public-annule.json', EXE_EN)).toEqual({ network: 'public', blocked: true, allowed: false, problem: 'rule', profiles: 4, noRule: false, blocker: null })
  })

  it('Windows français, dossier avec accents et apostrophe, « Privé » seul coché, wifi public : passer en réseau privé suffit', () => {
    expect(verdict('fr-public-prive-seul.json', EXE_FR)).toEqual({ network: 'public', blocked: true, allowed: false, problem: 'public', profiles: 4, noRule: false, blocker: null })
  })

  it('Windows français, réseau privé, règle écrite avec %LOCALAPPDATA% : rien à signaler', () => {
    expect(verdict('fr-prive-autorise.json', EXE_ZOE)).toEqual({ network: 'private', blocked: false, allowed: true, problem: null, profiles: 2, noRule: false, blocker: null })
  })

  it('réseau privé, invite jamais répondue (aucune règle) : bloqué par défaut', () => {
    // aucune règle : Flitdrop n'est pas dans « Applications autorisées », la
    // carte dit de l'y ajouter (« Autoriser une autre application »)
    expect(verdict('en-prive-sans-regle.json', EXE_EN)).toEqual({ network: 'private', blocked: false, allowed: false, problem: 'rule', profiles: 2, noRule: true, blocker: null })
  })

  it('Windows PowerShell 5.1 : tableau d’un seul élément, tableaux emballés, nombres et noms mélangés', () => {
    const rep = parseFirewallReport(fixture('ps51-emballe.json'))!
    expect(rep.profiles).toHaveLength(1)
    expect(rep.fw.size).toBe(3)
    expect(rep.rules).toHaveLength(1)
    expect(rep.rulesKnown).toBe(true)
    expect(evaluateFirewall(rep, EXE_EN, ENV)).toEqual({ network: 'public', blocked: true, allowed: false, problem: 'rule', profiles: 4, noRule: false, blocker: null })
  })

  it('plusieurs cartes réseau : le réseau est celui qui porte l’adresse du QR code', () => {
    expect(verdict('fr-plusieurs-reseaux.json', EXE_EN)).toEqual({ network: 'public', blocked: false, allowed: false, problem: 'public', profiles: 4, noRule: false, blocker: null })
  })

  it('pare-feu coupé sur ce réseau : rien à signaler', () => {
    expect(verdict('en-pare-feu-coupe.json', EXE_EN)).toEqual({ network: 'public', blocked: false, allowed: false, problem: null, profiles: 4, noRule: true, blocker: null })
  })

  it('règles hors sujet ignorées : autre dossier, désactivée, sortante, UDP seul', () => {
    expect(verdict('en-regles-hors-sujet.json', EXE_EN)).toEqual({ network: 'public', blocked: false, allowed: true, problem: null, profiles: 4, noRule: false, blocker: null })
  })

  it('« Bloquer toutes les connexions entrantes » : bloqué malgré l’autorisation, et « Réparer » n’y peut rien', () => {
    expect(verdict('fr-tout-bloque.json', EXE_EN)).toEqual({ network: 'private', blocked: false, allowed: true, problem: 'rule', profiles: 2, noRule: false, blocker: 'blockAll' })
  })

  it('pare-feu géré par une stratégie de groupe (entreprise, école) : « Réparer » n’y peut rien', () => {
    const rep = parseFirewallReport(fixture('en-prive-sans-regle.json'))!
    expect(rep.lpm).toBeNull()
    for (const lpm of [1, 2]) {
      rep.lpm = lpm
      expect(evaluateFirewall(rep, EXE_EN, ENV)).toMatchObject({ problem: 'rule', blocker: 'managed' })
    }
    rep.lpm = 0
    expect(evaluateFirewall(rep, EXE_EN, ENV).blocker).toBeNull()
    // lu dans la réponse du script
    const raw = JSON.parse(fixture('en-prive-sans-regle.json')) as Record<string, unknown>
    expect(parseFirewallReport(JSON.stringify({ ...raw, lpm: 1 }))!.lpm).toBe(1)
    // rien à signaler : pas de blocage à expliquer non plus
    expect(verdict('fr-prive-autorise.json', EXE_ZOE).blocker).toBeNull()
  })

  it('réseau de domaine (travail) : vérifié et réparé pour le profil Domaine', () => {
    const rep = parseFirewallReport(fixture('en-prive-sans-regle.json'))!
    rep.profiles[0]!.category = 'domain'
    const st = evaluateFirewall(rep, EXE_EN, ENV)
    expect(st).toMatchObject({ network: 'domain', problem: 'rule', profiles: 1, blocker: null })
    expect(profileNames(repairProfiles(st))).toEqual(['Domain', 'Private'])
    expect(firewallRepairScript(EXE_EN, st.profiles)).toContain('-Profile Domain, Private -RemoteAddress LocalSubnet')
  })

  it('règles illisibles, bruit autour du JSON : seul le réseau public est signalé', () => {
    expect(verdict('fr-regles-illisibles.json', EXE_EN)).toEqual({ network: 'public', blocked: false, allowed: false, problem: 'public', profiles: 4, noRule: false, blocker: null })
    const rep = parseFirewallReport(fixture('fr-regles-illisibles.json'))!
    rep.profiles[0]!.category = 'private'
    expect(evaluateFirewall(rep, EXE_EN, ENV).problem).toBeNull()
  })

  it('réseau inconnu : profils actifs du pare-feu, sinon le plus strict', () => {
    const rep = parseFirewallReport(fixture('en-prive-sans-regle.json'))!
    rep.profiles = []
    rep.ifIndex = null
    rep.current = 2
    expect(evaluateFirewall(rep, EXE_EN, ENV).network).toBe('private')
    rep.current = 6
    const st = evaluateFirewall(rep, EXE_EN, ENV)
    expect(st.network).toBe('unknown')
    expect(st.problem).toBe('rule')
    // les deux profils actifs sont vérifiés, et la règle les couvrira
    expect(st.profiles).toBe(6)
    expect(profileNames(repairProfiles(st))).toEqual(['Private', 'Public'])
    rep.current = null
    expect(evaluateFirewall(rep, EXE_EN, ENV)).toEqual({ network: 'unknown', blocked: false, allowed: false, problem: 'rule', profiles: 4, noRule: true, blocker: null })
  })

  it('réponses illisibles : null, jamais d’erreur', () => {
    for (const bad of ['', 'Get-NetConnectionProfile : accès refusé', '{pas du json}', '[]', 'null', '{"v":1']) {
      expect(parseFirewallReport(bad), bad).toBeNull()
    }
    expect(parseFirewallReport(undefined as unknown as string)).toBeNull()
  })

  it('type de réseau, en nom ou en nombre (jamais traduit par Windows)', () => {
    expect(networkOf('Public')).toBe('public')
    expect(networkOf('Private')).toBe('private')
    expect(networkOf('DomainAuthenticated')).toBe('domain')
    expect(networkOf(0)).toBe('public')
    expect(networkOf('1')).toBe('private')
    expect(networkOf(2)).toBe('domain')
    expect(networkOf('Réseau public')).toBe('unknown')
    expect(networkOf(null)).toBe('unknown')
  })

  it('chemins comparés comme Windows : variables, casse, barres, guillemets, \\\\?\\', () => {
    expect(expandWinEnv('%localappdata%\\x', ENV)).toBe('C:\\Users\\Zoé\\AppData\\Local\\x')
    expect(expandWinEnv('%INCONNUE%\\x', ENV)).toBe('%INCONNUE%\\x')
    const want = winPathKey(EXE_ZOE, ENV)
    for (const p of [
      '%LOCALAPPDATA%\\Programs\\flitdrop\\Flitdrop.exe',
      '"C:\\Users\\Zoé\\AppData\\Local\\Programs\\flitdrop\\Flitdrop.exe"',
      'c:/users/ZOÉ/appdata/local/programs/flitdrop/flitdrop.exe',
      '\\\\?\\C:\\Users\\Zoé\\AppData\\Local\\Programs\\flitdrop\\Flitdrop.exe',
    ]) {
      expect(winPathKey(p, ENV), p).toBe(want)
    }
    expect(winPathKey('C:\\Program Files\\Flitdrop\\Flitdrop.exe', ENV)).not.toBe(want)
  })
})

describe('pare-feu : guillemets et commandes PowerShell', () => {
  it('apostrophes doublées, y compris les apostrophes typographiques que PowerShell reconnaît', () => {
    expect(psQuote('abc')).toBe("'abc'")
    expect(psQuote("O'Brien")).toBe("'O''Brien'")
    expect(psQuote('L’Hôte')).toBe("'L’’Hôte'")
    expect(psQuote('a‘b‚c‛d')).toBe("'a‘‘b‚‚c‛‛d'")
    // rien d'autre n'est interprété entre apostrophes : $, `, " restent tels quels
    expect(psQuote('C:\\a $b `c "d"')).toBe("'C:\\a $b `c \"d\"'")
  })

  it('commande encodée : UTF-16LE en base64, sans perte', () => {
    const script = `$exe = ${psQuote(EXE_FR)}`
    expect(decode(encodePowerShell(script))).toBe(script)
    const args = psArgs(script)
    expect(args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-EncodedCommand'])
    expect(args[3]).toMatch(/^[A-Za-z0-9+/=]+$/)
    expect(decode(args[3]!)).toBe(script)
  })

  it('powershell.exe par son chemin complet', () => {
    expect(powershellPath({ SystemRoot: 'D:\\Win' })).toBe('D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(powershellPath({})).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  })

  it('vérification : seulement le nom de l’exécutable et une adresse IPv4 valide dans le script', () => {
    const s = firewallDetectScript(EXE_FR, '192.168.1.20')
    expect(s).toContain("$leaf = '\\Flitdrop.exe'")
    expect(s).toContain("$ip = '192.168.1.20'")
    expect(s).not.toContain('Zoé')
    // le script ne change rien
    for (const verb of ['New-NetFirewallRule', 'Remove-NetFirewallRule', 'Set-Net', 'RunAs']) expect(s).not.toContain(verb)
    expect(firewallDetectScript(EXE_EN, "1.2.3.4'; Remove-Item C:\\")).toContain("$ip = ''")
    expect(firewallDetectScript(EXE_EN)).toContain("$ip = ''")
  })

  it('profils de la règle : le réseau utilisé plus les réseaux privés, le public seulement sur un réseau public', () => {
    expect(profileNames(repairProfiles({ profiles: 2 }))).toEqual(['Private'])
    expect(profileNames(repairProfiles({ profiles: 4 }))).toEqual(['Private', 'Public'])
    expect(profileNames(repairProfiles({ profiles: 1 }))).toEqual(['Domain', 'Private'])
    // inconnu ou absurde : jamais plus que les réseaux privés
    expect(profileNames(repairProfiles(null))).toEqual(['Private'])
    expect(profileNames(repairProfiles({ profiles: 0 }))).toEqual(['Private'])
    expect(profileNames(repairProfiles({ profiles: 8 }))).toEqual(['Private'])
    // réseau privé : la règle n'ouvre rien sur les réseaux publics
    expect(firewallRepairScript(EXE_EN, 2)).toContain('-Profile Private -RemoteAddress LocalSubnet')
    expect(firewallRepairScript(EXE_EN, 2)).not.toContain('Public')
  })

  it('réparation : bloque retirés pour cet exécutable seulement, une règle d’autorisation limitée au réseau local', () => {
    const s = firewallRepairScript(EXE_FR, 4)
    expect(s).toContain("$exe = 'C:\\Users\\Zoé L’’Hôte\\AppData\\Local\\Programs\\flitdrop\\Flitdrop.exe'")
    expect(s).toContain(`$name = '${FIREWALL_RULE_NAME}'`)
    expect(FIREWALL_RULE_NAME).toBe('Flitdrop (réseau local)')
    expect(s).toContain("Where-Object { $_.Direction -eq 'Inbound' -and $_.Action -eq 'Block' }")
    expect(s).toContain('-ieq $want')
    expect(s).toContain(
      "New-NetFirewallRule -DisplayName $name -Group 'Flitdrop' -Direction Inbound -Action Allow -Program $exe -Protocol TCP -Profile Private, Public -RemoteAddress LocalSubnet"
    )
    // réparer deux fois ne crée pas de doublon
    expect(s.indexOf('Get-NetFirewallRule -DisplayName $name')).toBeLessThan(s.indexOf('New-NetFirewallRule'))
    // le type de réseau n'est jamais changé
    expect(s).not.toMatch(/NetConnectionProfile|NetworkCategory/)
    // chemin avec espaces : une seule chaîne entre apostrophes, jamais découpée
    const spaced = firewallRepairScript('C:\\Program Files\\Flit drop\\Flitdrop.exe')
    expect(spaced).toContain("$exe = 'C:\\Program Files\\Flit drop\\Flitdrop.exe'")
  })

  it('lanceur : une seule demande d’élévation, le script élevé passé encodé, refus rendu en 1223', () => {
    const psExe = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
    const l = firewallRepairLauncher(EXE_FR, psExe, 4)
    // élévation par Process.Start (verbe runas) : sous Windows PowerShell 5.1,
    // Start-Process remplace le refus (1223) par une erreur sans cause, et le
    // refus passait pour un échec
    expect(l).not.toContain('Start-Process')
    expect(l.match(/\[System\.Diagnostics\.Process\]::Start\(\$psi\)/g)).toHaveLength(1)
    expect(l.match(/runas/gi)).toHaveLength(1)
    expect(l).toContain("$psi.Verb = 'runas'")
    expect(l).toContain('$psi.UseShellExecute = $true')
    expect(l).toContain(`New-Object System.Diagnostics.ProcessStartInfo '${psExe}'`)
    expect(l).toContain('[System.Diagnostics.ProcessWindowStyle]::Hidden')
    // le refus est cherché dans les causes, par son code, jamais par le
    // message (traduit par Windows)
    expect(l).toContain(`if ($e.NativeErrorCode -eq ${UAC_CANCELLED}) { exit ${UAC_CANCELLED} }`)
    expect(l).toContain('$e = $e.InnerException')
    expect(l).not.toMatch(/Message|canceled|annul/i)
    // le lanceur lui-même ne touche pas au pare-feu
    expect(l).not.toMatch(/NetFirewallRule/)
    const inner = l.match(/\$psi\.Arguments = '-NoProfile -NonInteractive -EncodedCommand ([A-Za-z0-9+/=]+)'/)
    expect(inner).not.toBeNull()
    expect(decode(inner![1]!)).toBe(firewallRepairScript(EXE_FR, 4))
    expect(firewallRepairLauncher(EXE_EN, 'D:\\Mon Windows\\powershell.exe')).toContain("ProcessStartInfo 'D:\\Mon Windows\\powershell.exe'")
  })

  it('résultat de la réparation d’après le code de sortie', () => {
    const r = (code: number | null, timedOut = false): RunResult => ({ code, stdout: '', timedOut })
    expect(repairResultOf(r(0))).toBe('ok')
    expect(repairResultOf(r(UAC_CANCELLED))).toBe('cancelled')
    expect(repairResultOf(r(2))).toBe('failed')
    expect(repairResultOf(r(3))).toBe('failed')
    expect(repairResultOf(r(null))).toBe('failed')
    expect(repairResultOf(r(0, true))).toBe('failed')
  })
})

describe('pare-feu : exécution (PowerShell simulé)', () => {
  it('vérification : une seule exécution, 8 s au plus, conclusion rendue', async () => {
    const calls: Array<{ args: string[]; timeout: number }> = []
    const run: PsRunner = async (args, timeout) => {
      calls.push({ args, timeout })
      return { code: 0, stdout: fixture('fr-public-prive-seul.json'), timedOut: false }
    }
    const st = await checkWindowsFirewall({ exe: EXE_FR, ip: '192.168.1.20', env: ENV, run })
    expect(st).toEqual({ network: 'public', blocked: true, allowed: false, problem: 'public', profiles: 4, noRule: false, blocker: null })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.timeout).toBe(8000)
    expect(decode(calls[0]!.args[3]!)).toBe(firewallDetectScript(EXE_FR, '192.168.1.20'))
  })

  it('vérification : délai dépassé, réponse illisible ou erreur : null, jamais d’exception', async () => {
    const timedOut: PsRunner = async () => ({ code: null, stdout: fixture('en-public-annule.json'), timedOut: true })
    expect(await checkWindowsFirewall({ exe: EXE_EN, run: timedOut })).toBeNull()
    const garbage: PsRunner = async () => ({ code: 1, stdout: 'Le terme « Get-NetConnectionProfile » n’est pas reconnu', timedOut: false })
    expect(await checkWindowsFirewall({ exe: EXE_EN, run: garbage })).toBeNull()
    const throws: PsRunner = async () => {
      throw new Error('spawn ENOENT')
    }
    expect(await checkWindowsFirewall({ exe: EXE_EN, run: throws })).toBeNull()
  })

  it('réparation : lanceur encodé, accord refusé, échec, délai', async () => {
    let seen: string[] = []
    const withCode =
      (code: number | null, timedOut = false): PsRunner =>
      async (args) => {
        seen = args
        return { code, stdout: '', timedOut }
      }
    expect(await repairWindowsFirewall({ exe: EXE_FR, env: ENV, run: withCode(0) })).toBe('ok')
    expect(decode(seen[3]!)).toBe(firewallRepairLauncher(EXE_FR, powershellPath(ENV)))
    // la règle suit le réseau de la vérification : public, ou privé seul
    const pub = { network: 'public', blocked: true, allowed: false, problem: 'public', profiles: 4, noRule: false, blocker: null } as FirewallStatus
    await repairWindowsFirewall({ exe: EXE_FR, env: ENV, run: withCode(0), status: pub })
    expect(decode(seen[3]!)).toBe(firewallRepairLauncher(EXE_FR, powershellPath(ENV), 4))
    const priv: FirewallStatus = { ...pub, network: 'private', profiles: 2 }
    await repairWindowsFirewall({ exe: EXE_FR, env: ENV, run: withCode(0), status: priv })
    expect(decode(seen[3]!)).toBe(firewallRepairLauncher(EXE_FR, powershellPath(ENV), 2))
    expect(await repairWindowsFirewall({ exe: EXE_FR, env: ENV, run: withCode(UAC_CANCELLED) })).toBe('cancelled')
    expect(await repairWindowsFirewall({ exe: EXE_FR, env: ENV, run: withCode(2) })).toBe('failed')
    expect(await repairWindowsFirewall({ exe: EXE_FR, env: ENV, run: withCode(null, true) })).toBe('failed')
    const throws: PsRunner = async () => {
      throw new Error('boom')
    }
    expect(await repairWindowsFirewall({ exe: EXE_FR, run: throws })).toBe('failed')
  })
})

// Sous Windows seulement (CI windows-latest) : le vrai script tourne dans le
// vrai Windows PowerShell 5.1. Rien n'est changé sur la machine : la
// vérification ne fait que lire, et les scripts de réparation sont seulement
// analysés par PowerShell (jamais exécutés, jamais élevés).
describe.runIf(process.platform === 'win32')('pare-feu : Windows réel', () => {
  it('le script de vérification tourne et rend une réponse lisible', async () => {
    const res = await runPowerShell(psArgs(firewallDetectScript(process.execPath, localIPv4s()[0])), 60_000)
    // visible dans le journal du CI : la réponse brute, pour les fixtures
    console.log('réponse du script de vérification :', res.stdout.trim().slice(0, 2000))
    expect(res.timedOut).toBe(false)
    const rep = parseFirewallReport(res.stdout)
    expect(rep).not.toBeNull()
    expect(Array.isArray(rep!.profiles)).toBe(true)
    // la moitié COM (HNetCfg.FwPolicy2) doit vraiment marcher sous
    // PowerShell 5.1 : sinon la production retombe en silence sur « règles
    // inconnues » et le cas « règle » n'est plus jamais vu. Le service du
    // pare-feu tourne sur le runner, même profils coupés.
    const raw = JSON.parse(res.stdout.slice(res.stdout.indexOf('{'), res.stdout.lastIndexOf('}') + 1)) as { errors?: unknown }
    const errors = (Array.isArray(raw.errors) ? raw.errors : raw.errors ? [raw.errors] : []).map(String)
    for (const part of ['rules', 'lpm', 'profiles']) expect(errors, part).not.toContain(part)
    expect(rep!.rulesKnown).toBe(true)
    expect(rep!.fw.size).toBe(3)
    expect([0, 1, 2, 3]).toContain(rep!.lpm)
  }, 90_000)

  it('checkWindowsFirewall rend un résultat bien formé ou null, sans lever d’erreur', async () => {
    const st = await checkWindowsFirewall({ exe: process.execPath, ip: localIPv4s()[0], timeoutMs: 60_000 })
    console.log('vérification du pare-feu :', JSON.stringify(st))
    if (st !== null) {
      expect(['private', 'public', 'domain', 'unknown']).toContain(st.network)
      expect(typeof st.blocked).toBe('boolean')
      expect(typeof st.allowed).toBe('boolean')
      expect([null, 'public', 'rule']).toContain(st.problem)
    }
  }, 90_000)

  it('les scripts de réparation sont du PowerShell valide (analysés, jamais lancés)', async () => {
    const exe = 'C:\\Users\\Zoé L’Hôte\\App Data\\Flitdrop.exe'
    for (const script of [firewallRepairScript(exe), firewallRepairScript(exe, 5), firewallRepairLauncher(exe), firewallRepairLauncher(exe, powershellPath(), 1)]) {
      const checker = [
        `$src = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String(${psQuote(encodePowerShell(script))}))`,
        '$errs = $null',
        '$null = [System.Management.Automation.Language.Parser]::ParseInput($src, [ref]$null, [ref]$errs)',
        "'errors=' + @($errs).Count",
      ].join('\n')
      const res = await runPowerShell(psArgs(checker), 60_000)
      expect(res.stdout).toContain('errors=0')
    }
  }, 90_000)
})
