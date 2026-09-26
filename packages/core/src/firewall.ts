import { execFile } from 'node:child_process'
import path from 'node:path'

// Pare-feu de Windows : le premier blocage silencieux. Au premier lancement,
// Windows demande s'il faut laisser Flitdrop recevoir des connexions ; un
// « Annuler », ou un wifi classé « Réseau public » alors que seul « Privé » a
// été coché, et plus aucun téléphone ne joint le PC, sans aucun message.
//
// Ici, sans Electron et sans DOM, pour être testé :
// - le script de vérification (une seule exécution de PowerShell, fenêtre
//   cachée, 8 s au plus, jamais d'erreur qui remonte) et la lecture de sa
//   réponse JSON ;
// - la réparation, lancée seulement quand la personne clique « Réparer » :
//   une seule demande des droits administrateur (UAC), qui retire les règles
//   de blocage de Flitdrop et ajoute une règle d'autorisation limitée au
//   réseau local, pour le type du réseau utilisé (plus les réseaux privés).
//   Le type de réseau (Privé ou Public) n'est jamais changé. Elle n'est pas
//   proposée quand une règle ne peut rien y faire (tout bloquer, pare-feu
//   géré par l'entreprise ou l'école).
// macOS : son pare-feu est coupé par défaut et rien de bloquant n'a été
// constaté. Linux : rien (pas de pare-feu actif par défaut sur les bureaux
// courants, et aucune façon commune de le régler).

export type FirewallNetwork = 'private' | 'public' | 'domain' | 'unknown'

/** Ce que la vérification a trouvé, pour le réseau utilisé par le QR code. */
export interface FirewallStatus {
  network: FirewallNetwork
  /** une règle bloque les connexions entrantes vers Flitdrop sur ce réseau */
  blocked: boolean
  /** une règle autorise les connexions entrantes vers Flitdrop sur ce réseau */
  allowed: boolean
  /** ce qui empêche un téléphone de joindre Flitdrop : « public » (passer le
   *  wifi en réseau privé suffirait), « rule » (il faut autoriser Flitdrop
   *  dans le pare-feu), ou null (rien trouvé). */
  problem: 'public' | 'rule' | null
  /** profils vérifiés (1 domaine, 2 privé, 4 public) : ceux du réseau utilisé */
  profiles: number
  /** aucune règle de Flitdrop : il n'est pas dans « Applications autorisées » */
  noRule: boolean
  /** ce qui rend « Réparer » inutile : « blockAll » (le pare-feu bloque toutes
   *  les connexions entrantes, règles comprises), « managed » (pare-feu géré
   *  par l'entreprise ou l'école : les règles de ce PC n'y changent rien) */
  blocker: 'blockAll' | 'managed' | null
}

export type RepairResult = 'ok' | 'cancelled' | 'failed'

/** Délai de la vérification : au-delà, on abandonne sans rien dire. */
export const FIREWALL_CHECK_TIMEOUT_MS = 8_000
/** Délai de la réparation : la fenêtre de Windows attend la personne. */
export const FIREWALL_REPAIR_TIMEOUT_MS = 3 * 60_000
/** Nom de la règle ajoutée par la réparation (vu dans le pare-feu). */
export const FIREWALL_RULE_NAME = 'Flitdrop (réseau local)'
/** Code de sortie de Windows quand la personne refuse la demande (UAC). */
export const UAC_CANCELLED = 1223

// ---------- PowerShell : guillemets et commande encodée ----------

/** Texte entre apostrophes pour PowerShell. PowerShell prend aussi ‘ ’ ‚ ‛
 *  pour des apostrophes : chacune est doublée, comme le fait PowerShell
 *  lui-même (CodeGeneration.EscapeSingleQuotedStringContent). */
export function psQuote(s: string): string {
  return `'${String(s).replace(/['\u2018\u2019\u201a\u201b]/g, (c) => c + c)}'`
}

/** Script passé à -EncodedCommand : base64 de l'UTF-16LE. Aucun caractère
 *  n'est perdu (dossier personnel avec accents, espaces, apostrophes). */
export function encodePowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

/** Arguments de powershell.exe pour un script : sans profil, sans question. */
export function psArgs(script: string): string[] {
  return ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShell(script)]
}

/** powershell.exe du système, par son chemin complet (jamais celui du PATH). */
export function powershellPath(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.SystemRoot || env.SYSTEMROOT || env.windir || env.WINDIR || 'C:\\Windows'
  return path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/

// ---------- vérification ----------

/**
 * Script de vérification. Ne change rien. Il renvoie une ligne JSON en ASCII
 * pur (tout autre caractère devient \uXXXX : la page de code de la console
 * ne compte plus) :
 * - ifIndex : l'interface qui porte l'adresse du QR code ;
 * - profiles : type de chaque réseau connecté (Get-NetConnectionProfile) ;
 * - current, fw : profils actifs et réglages du pare-feu par profil ;
 * - lpm : LocalPolicyModifyState (0 : les règles de ce PC comptent ;
 *   1 ou 2 : une stratégie de groupe les écrase) ;
 * - rules : règles dont le programme porte le nom de l'exécutable de
 *   Flitdrop (le chemin exact est comparé ensuite, en Node).
 * Les règles sont lues par l'objet COM du pare-feu (HNetCfg.FwPolicy2) :
 * une lecture de toutes les règles par Get-NetFirewallApplicationFilter
 * prend plusieurs secondes sur un PC chargé, et le délai est de 8 s.
 */
export function firewallDetectScript(exe: string, ip?: string): string {
  const leaf = '\\' + path.win32.basename(exe)
  const addr = ip && IPV4.test(ip) ? ip : ''
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    // Windows PowerShell 5.1 : sans cela, un tableau devient {value, Count}
    'try { Remove-TypeData System.Array -ErrorAction SilentlyContinue } catch {}',
    `$leaf = ${psQuote(leaf)}`,
    `$ip = ${psQuote(addr)}`,
    '$out = [ordered]@{ v = 1; ifIndex = $null; current = $null; lpm = $null; profiles = @(); fw = @(); rules = @(); errors = @() }',
    'try {',
    '  if ($ip) {',
    '    $a = @(Get-NetIPAddress -IPAddress $ip -ErrorAction SilentlyContinue) | Select-Object -First 1',
    '    if ($a) { $out.ifIndex = [int]$a.InterfaceIndex }',
    '  }',
    "} catch { $out.errors += 'ip' }",
    'try {',
    '  $out.profiles = @(Get-NetConnectionProfile | ForEach-Object {',
    '    [ordered]@{ i = [int]$_.InterfaceIndex; c = [string]$_.NetworkCategory; v4 = [string]$_.IPv4Connectivity }',
    '  })',
    "} catch { $out.errors += 'profiles' }",
    'try {',
    '  $fw = New-Object -ComObject HNetCfg.FwPolicy2',
    '  $out.current = [int]$fw.CurrentProfileTypes',
    '  $out.fw = @(foreach ($b in 1, 2, 4) {',
    '    [ordered]@{ p = $b; on = [bool]$fw.FirewallEnabled($b); inAllow = [int]$fw.DefaultInboundAction($b); blockAll = [bool]$fw.BlockAllInboundTraffic($b) }',
    '  })',
    '  try { $out.lpm = [int]$fw.LocalPolicyModifyState } catch { $out.errors += \'lpm\' }',
    '  $out.rules = @($fw.Rules | Where-Object { $_.ApplicationName -and ([string]$_.ApplicationName).EndsWith($leaf, [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object {',
    '    [ordered]@{ app = [string]$_.ApplicationName; a = [int]$_.Action; d = [int]$_.Direction; e = [bool]$_.Enabled; p = [int]$_.Profiles; proto = [int]$_.Protocol }',
    '  })',
    "} catch { $out.errors += 'rules' }",
    '$j = ConvertTo-Json -InputObject $out -Depth 5 -Compress',
    "[regex]::Replace($j, '[^\\x20-\\x7E]', { param($m) '\\u{0:x4}' -f [int][char]$m.Value })",
  ].join('\n')
}

/** Réponse brute du script, avant toute conclusion. */
export interface FirewallReport {
  ifIndex: number | null
  current: number | null
  profiles: Array<{ i: number | null; category: FirewallNetwork; connectivity: string }>
  /** réglages par profil (1 domaine, 2 privé, 4 public) ; absent : inconnu */
  fw: Map<number, { on: boolean; inboundAllow: boolean; blockAll: boolean }>
  rules: Array<{ app: string; allow: boolean; inbound: boolean; enabled: boolean; profiles: number; tcp: boolean }>
  rulesKnown: boolean
  /** LocalPolicyModifyState ; null : inconnu */
  lpm: number | null
}

// Windows PowerShell 5.1 : un tableau d'un seul élément sort parfois comme
// l'élément seul, ou emballé dans {value: [...], Count: n}
function list(v: unknown): unknown[] {
  if (Array.isArray(v)) return v
  if (v && typeof v === 'object') {
    const o = v as { value?: unknown }
    if (Array.isArray(o.value)) return o.value
    return [v]
  }
  return []
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return Number(v.trim())
  return null
}

function bool(v: unknown, fallback: boolean): boolean {
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v !== 0
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase()
    if (s === 'true' || s === '1') return true
    if (s === 'false' || s === '0') return false
  }
  return fallback
}

/** NetworkCategory, en nom (« Public ») ou en nombre (0 public, 1 privé,
 *  2 domaine), selon la version de PowerShell. Jamais traduit par Windows. */
export function networkOf(v: unknown): FirewallNetwork {
  const n = num(v)
  if (n === 0) return 'public'
  if (n === 1) return 'private'
  if (n === 2) return 'domain'
  const s = typeof v === 'string' ? v.trim().toLowerCase() : ''
  if (s === 'public') return 'public'
  if (s === 'private') return 'private'
  if (s === 'domainauthenticated' || s === 'domain') return 'domain'
  return 'unknown'
}

// profils d'une règle : masque (1 domaine, 2 privé, 4 public, 0x7FFFFFFF
// tous) ou texte (« Private, Public », « Any »)
function profilesOf(v: unknown): number {
  const n = num(v)
  if (n !== null) return n === 0 ? 0x7fffffff : n
  if (typeof v !== 'string') return 0x7fffffff
  let m = 0
  for (const part of v.split(/[,\s]+/)) {
    const p = part.toLowerCase()
    if (p === 'any' || p === 'all') return 0x7fffffff
    if (p === 'domain') m |= 1
    else if (p === 'private') m |= 2
    else if (p === 'public') m |= 4
  }
  return m || 0x7fffffff
}

// action : 1 autoriser, 0 bloquer (COM) ou « Allow » / « Block »
function isAllow(v: unknown): boolean | null {
  const n = num(v)
  if (n === 1 || n === 2) return true
  if (n === 0 || n === 4) return false
  const s = typeof v === 'string' ? v.trim().toLowerCase() : ''
  if (s === 'allow') return true
  if (s === 'block') return false
  return null
}

// sens : 1 entrant (COM) ou « Inbound »
function isInbound(v: unknown): boolean {
  const n = num(v)
  if (n !== null) return n === 1
  const s = typeof v === 'string' ? v.trim().toLowerCase() : ''
  return s === 'inbound' || s === 'in'
}

// protocole : 6 TCP, 256 tous (COM), ou « TCP » / « Any »
function coversTcp(v: unknown): boolean {
  if (v === undefined || v === null) return true
  const n = num(v)
  if (n !== null) return n === 6 || n === 256
  const s = typeof v === 'string' ? v.trim().toLowerCase() : ''
  return s === 'tcp' || s === 'any' || s === ''
}

/** Lit la réponse du script (bruit autour du JSON toléré). null : illisible. */
export function parseFirewallReport(stdout: string): FirewallReport | null {
  const s = typeof stdout === 'string' ? stdout : ''
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(s.slice(start, end + 1)) as Record<string, unknown>
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null
  const errors = list(raw.errors).map(String)
  const profiles = list(raw.profiles)
    .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object')
    .map((p) => ({
      i: num(p.i ?? p.InterfaceIndex),
      category: networkOf(p.c ?? p.NetworkCategory),
      connectivity: String(p.v4 ?? p.IPv4Connectivity ?? '').trim(),
    }))
  const fw = new Map<number, { on: boolean; inboundAllow: boolean; blockAll: boolean }>()
  for (const f of list(raw.fw)) {
    if (!f || typeof f !== 'object') continue
    const o = f as Record<string, unknown>
    const p = num(o.p)
    if (p !== 1 && p !== 2 && p !== 4) continue
    fw.set(p, { on: bool(o.on, true), inboundAllow: num(o.inAllow) === 1, blockAll: bool(o.blockAll, false) })
  }
  const rules: FirewallReport['rules'] = []
  for (const r of list(raw.rules)) {
    if (!r || typeof r !== 'object') continue
    const o = r as Record<string, unknown>
    const allow = isAllow(o.a)
    if (allow === null || typeof o.app !== 'string') continue
    rules.push({ app: o.app, allow, inbound: isInbound(o.d), enabled: bool(o.e, true), profiles: profilesOf(o.p), tcp: coversTcp(o.proto) })
  }
  return {
    ifIndex: num(raw.ifIndex),
    current: num(raw.current),
    profiles,
    fw,
    rules,
    rulesKnown: !errors.includes('rules') && fw.size > 0,
    lpm: num(raw.lpm),
  }
}

/** Remplace %VARIABLE% (sans tenir compte de la casse, comme Windows). */
export function expandWinEnv(p: string, env: NodeJS.ProcessEnv): string {
  return p.replace(/%([^%\\/]+)%/g, (m, name: string) => {
    const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase())
    const v = key ? env[key] : undefined
    return typeof v === 'string' ? v : m
  })
}

/** Chemin Windows comparable : variables remplacées, guillemets et \\?\
 *  retirés, barres unifiées, sans casse. */
export function winPathKey(p: string, env: NodeJS.ProcessEnv): string {
  return expandWinEnv(String(p).trim().replace(/^"(.*)"$/, '$1'), env)
    .replace(/\//g, '\\')
    .replace(/^\\\\\?\\/, '')
    .replace(/\\+/g, '\\')
    .toLowerCase()
}

const BIT: Record<Exclude<FirewallNetwork, 'unknown'>, number> = { domain: 1, private: 2, public: 4 }

/** Le réseau du QR code : l'interface qui porte son adresse, sinon celle qui
 *  a internet, puis le réseau local, sinon le seul profil actif connu. */
function pickNetwork(rep: FirewallReport): FirewallNetwork {
  const byIf = rep.ifIndex !== null ? rep.profiles.find((p) => p.i === rep.ifIndex) : undefined
  if (byIf) return byIf.category
  const rank = (c: string) => (/^internet$|^4$/i.test(c) ? 2 : /^localnetwork$|^3$/i.test(c) ? 1 : 0)
  const best = [...rep.profiles].sort((a, b) => rank(b.connectivity) - rank(a.connectivity))[0]
  if (best && best.category !== 'unknown') return best.category
  const cur = rep.current ?? 0
  if (cur === 1) return 'domain'
  if (cur === 2) return 'private'
  if (cur === 4) return 'public'
  return 'unknown'
}

/**
 * Conclusion de la vérification pour l'exécutable `exe`. Un profil est
 * joignable quand son pare-feu est coupé, ou quand aucune règle ne bloque
 * Flitdrop et qu'une règle l'autorise (ou que le pare-feu laisse tout entrer).
 * Une règle de blocage l'emporte toujours sur une autorisation.
 */
export function evaluateFirewall(rep: FirewallReport, exe: string, env: NodeJS.ProcessEnv = process.env): FirewallStatus {
  const network = pickNetwork(rep)
  const want = winPathKey(exe, env)
  const mine = rep.rules.filter((r) => r.inbound && r.enabled && r.tcp && winPathKey(r.app, env) === want)
  const blockFor = (bit: number) => mine.some((r) => !r.allow && (r.profiles & bit) !== 0)
  const allowFor = (bit: number) => mine.some((r) => r.allow && (r.profiles & bit) !== 0)
  const reachable = (bit: number): boolean => {
    const f = rep.fw.get(bit)
    if (f && !f.on) return true
    if (blockFor(bit) || f?.blockAll) return false
    return allowFor(bit) || !!f?.inboundAllow
  }
  // réseau inconnu : tous les profils actifs, sinon le plus strict (public)
  const bits = network !== 'unknown' ? [BIT[network]] : [1, 2, 4].filter((b) => ((rep.current ?? 0) & b) !== 0)
  const check = bits.length > 0 ? bits : [4]
  const blocked = check.some(blockFor)
  const allowed = check.every(allowFor)
  let problem: FirewallStatus['problem'] = null
  if (!rep.rulesKnown) {
    // règles illisibles : seul le réseau public reste une piste sûre
    problem = network === 'public' ? 'public' : null
  } else if (!check.every(reachable)) {
    problem = network === 'public' && reachable(BIT.private) ? 'public' : 'rule'
  }
  // une règle d'autorisation n'y changerait rien : stratégie de groupe qui
  // écrase les règles de ce PC, ou « bloquer toutes les connexions entrantes »
  let blocker: FirewallStatus['blocker'] = null
  if (problem && rep.rulesKnown) {
    // « tout bloquer » d'abord : Windows rend aussi 2 (connexions entrantes
    // bloquées) dans ce cas, sans que ce soit une stratégie de groupe
    if (check.some((b) => !reachable(b) && rep.fw.get(b)?.blockAll)) blocker = 'blockAll'
    else if (rep.lpm === 1 || rep.lpm === 2) blocker = 'managed'
  }
  const noRule = rep.rulesKnown && !rep.rules.some((r) => r.inbound && winPathKey(r.app, env) === want)
  const profiles = check.reduce((m, b) => m | b, 0)
  return { network, blocked, allowed, problem, profiles, noRule, blocker }
}

/** Profils de la règle posée par « Réparer » : ceux du réseau utilisé, plus
 *  les réseaux privés (la maison). Le public n'y est que si le réseau
 *  utilisé est public : la carte le dit alors avant le clic. */
export function repairProfiles(st: Pick<FirewallStatus, 'profiles'> | null | undefined): number {
  const p = typeof st?.profiles === 'number' && st.profiles > 0 ? st.profiles & 7 : 0
  return (p || 2) | 2
}

/** Noms des profils pour New-NetFirewallRule -Profile. */
export function profileNames(mask: number): string[] {
  const out: string[] = []
  if (mask & 1) out.push('Domain')
  if (mask & 2) out.push('Private')
  if (mask & 4) out.push('Public')
  return out
}

// ---------- exécution ----------

export interface RunResult {
  /** code de sortie ; null : pas de code (programme introuvable, tué) */
  code: number | null
  stdout: string
  timedOut: boolean
}
export type PsRunner = (args: string[], timeoutMs: number) => Promise<RunResult>

/** Lance powershell.exe, fenêtre cachée, et rend toujours un résultat. */
export const runPowerShell: PsRunner = (args, timeoutMs) =>
  new Promise<RunResult>((resolve) => {
    try {
      execFile(
        powershellPath(),
        args,
        { windowsHide: true, timeout: timeoutMs, maxBuffer: 1024 * 1024, encoding: 'utf8' },
        (err, stdout) => {
          const out = typeof stdout === 'string' ? stdout : ''
          if (!err) return resolve({ code: 0, stdout: out, timedOut: false })
          const e = err as NodeJS.ErrnoException & { killed?: boolean; code?: unknown }
          resolve({ code: typeof e.code === 'number' ? e.code : null, stdout: out, timedOut: e.killed === true })
        }
      )
    } catch {
      resolve({ code: null, stdout: '', timedOut: false })
    }
  })

/** Vérifie le pare-feu pour l'exécutable `exe` et l'adresse du QR code.
 *  null : vérification impossible (délai dépassé, PowerShell absent, réponse
 *  illisible). Ne lève jamais d'erreur. */
export async function checkWindowsFirewall(o: {
  exe: string
  ip?: string
  env?: NodeJS.ProcessEnv
  run?: PsRunner
  timeoutMs?: number
}): Promise<FirewallStatus | null> {
  try {
    const run = o.run ?? runPowerShell
    const res = await run(psArgs(firewallDetectScript(o.exe, o.ip)), o.timeoutMs ?? FIREWALL_CHECK_TIMEOUT_MS)
    if (res.timedOut) return null
    const rep = parseFirewallReport(res.stdout)
    return rep ? evaluateFirewall(rep, o.exe, o.env ?? process.env) : null
  } catch {
    return null
  }
}

// ---------- réparation ----------

/**
 * Script lancé AVEC les droits administrateur. Il retire seulement les règles
 * qui bloquent les connexions entrantes vers cet exécutable, puis ajoute une
 * règle d'autorisation : connexions entrantes TCP, profils `profiles` (voir
 * repairProfiles), appareils du réseau local seulement. La règle du même nom
 * est d'abord retirée : réparer deux fois ne crée pas de doublon. Rien
 * d'autre ne change (ni le type de réseau, ni les autres programmes).
 */
export function firewallRepairScript(exe: string, profiles: number = 2): string {
  const names = profileNames(repairProfiles({ profiles }))
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    `$exe = ${psQuote(exe)}`,
    `$name = ${psQuote(FIREWALL_RULE_NAME)}`,
    "$key = { param($p) ([Environment]::ExpandEnvironmentVariables([string]$p) -replace '/', '\\').Trim('\"') }",
    '$want = & $key $exe',
    'try {',
    '  Get-NetFirewallApplicationFilter -PolicyStore PersistentStore |',
    '    Where-Object { $_.Program -and ((& $key $_.Program) -ieq $want) } |',
    '    Get-NetFirewallRule |',
    "    Where-Object { $_.Direction -eq 'Inbound' -and $_.Action -eq 'Block' } |",
    '    Remove-NetFirewallRule',
    '  Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue | Remove-NetFirewallRule',
    `  New-NetFirewallRule -DisplayName $name -Group 'Flitdrop' -Direction Inbound -Action Allow -Program $exe -Protocol TCP -Profile ${names.join(', ')} -RemoteAddress LocalSubnet | Out-Null`,
    '  exit 0',
    '} catch {',
    '  exit 2',
    '}',
  ].join('\n')
}

/**
 * Script lancé SANS droits : il demande l'élévation (verbe « runas », la
 * fenêtre de Windows) pour le script ci-dessus, attend sa fin et rend son
 * code. Refus de la personne : 1223.
 * Par Process.Start et pas Start-Process : sous Windows PowerShell 5.1,
 * Start-Process remplace l'erreur 1223 par une autre, sans cause attachée,
 * et un refus passait pour un échec. Process.Start la laisse remonter (en
 * cause d'une MethodInvocationException), la boucle ci-dessous la trouve.
 * Le message de l'erreur, traduit par Windows, n'est jamais lu.
 */
export function firewallRepairLauncher(exe: string, psExe: string = powershellPath(), profiles: number = 2): string {
  const inner = encodePowerShell(firewallRepairScript(exe, profiles))
  return [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    `  $psi = New-Object System.Diagnostics.ProcessStartInfo ${psQuote(psExe)}`,
    `  $psi.Arguments = ${psQuote('-NoProfile -NonInteractive -EncodedCommand ' + inner)}`,
    "  $psi.Verb = 'runas'",
    '  $psi.UseShellExecute = $true',
    '  $psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden',
    '  $p = [System.Diagnostics.Process]::Start($psi)',
    '  if ($null -eq $p) { exit 3 }',
    '  $p.WaitForExit()',
    '  exit $p.ExitCode',
    '} catch {',
    '  $e = $_.Exception',
    `  while ($e) { if ($e.NativeErrorCode -eq ${UAC_CANCELLED}) { exit ${UAC_CANCELLED} }; $e = $e.InnerException }`,
    '  exit 3',
    '}',
  ].join('\n')
}

/** Code de sortie de la réparation → résultat montré et compté. */
export function repairResultOf(res: RunResult): RepairResult {
  if (res.timedOut) return 'failed'
  if (res.code === 0) return 'ok'
  if (res.code === UAC_CANCELLED) return 'cancelled'
  return 'failed'
}

/** Répare le pare-feu pour `exe` (une demande des droits administrateur),
 *  pour le réseau de la dernière vérification `status`. Ne lève jamais
 *  d'erreur. */
export async function repairWindowsFirewall(o: {
  exe: string
  status?: Pick<FirewallStatus, 'profiles'> | null
  env?: NodeJS.ProcessEnv
  run?: PsRunner
  timeoutMs?: number
}): Promise<RepairResult> {
  try {
    const run = o.run ?? runPowerShell
    const script = firewallRepairLauncher(o.exe, powershellPath(o.env ?? process.env), repairProfiles(o.status))
    return repairResultOf(await run(psArgs(script), o.timeoutMs ?? FIREWALL_REPAIR_TIMEOUT_MS))
  } catch {
    return 'failed'
  }
}
