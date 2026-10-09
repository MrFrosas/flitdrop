// Licences Flitdrop Pro : client de l'API Paddle Billing (v1) et règles d'achat.
//
// Règle d'or : on ne donne JAMAIS une licence sur une erreur. Toute réponse
// inattendue de Paddle (réseau, 4xx, 5xx, 429, forme bizarre, liste tronquée là où
// il fallait tout voir) lève une PaddleError, que les points d'entrée transforment
// en 503 « retente plus tard ». La clé d'API ne sort jamais : ni dans les journaux,
// ni dans les réponses, et elle n'est envoyée qu'à l'hôte Paddle configuré.
//
// Nombre d'appels borné : chaque requête de l'app a droit à MAX_CALLS appels Paddle
// au plus (pages comprises), quoi que contienne la requête. Au-delà : PaddleError.
//
// Paddle reste la source de vérité des achats (transaction.custom_data.claim : le
// claim de la page /pro), des clients, des remboursements et des rétrofacturations.
// Les appareils et les index vivent dans la base D1 (db.js).
import { state } from './state.js'
import { nowMs } from './http.js'

export const CLAIM_WINDOW_MS = 48 * 3600 * 1000
export const MAX_CALLS = 16

const BUDGET_MS = 9000 // temps total accordé à Paddle pour une requête de l'app
const CALL_MS = 4000 // temps maximal d'un appel
const PAGES = { claimScan: 10, customerTxns: 2, adjustments: 2, emailLookup: 1 }
const MAX_EMAIL_CUSTOMERS = 2 // clients d'une même adresse examinés au plus

export class PaddleError extends Error {
  constructor(status, code) {
    super(`paddle ${status} ${code || ''}`.trim())
    this.name = 'PaddleError'
    this.status = status
    this.code = code || ''
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function retryAfterSeconds(header) {
  const n = Number(header)
  if (Number.isFinite(n) && n > 0) return Math.min(n, 300)
  const date = Date.parse(header || '')
  if (Number.isFinite(date)) return Math.min(Math.max(1, Math.ceil((date - nowMs()) / 1000)), 300)
  return 60 // la doc Paddle : 60 s de blocage après un 429
}

// Chaîne de requête : les crochets des opérateurs (created_at[GTE]) restent tels quels,
// comme dans les exemples de la doc ; chaque valeur est encodée, les listes sont
// séparées par des virgules.
export function query(params) {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${(Array.isArray(v) ? v : [v]).map((x) => encodeURIComponent(String(x))).join(',')}`)
    .join('&')
}

// Date RFC 3339 sans millisecondes, en UTC.
export const rfc3339 = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')

export function createPaddle(cfg, { budgetMs = BUDGET_MS, maxCalls = MAX_CALLS } = {}) {
  const deadline = nowMs() + budgetMs
  const base = cfg.apiBase
  let calls = 0

  async function call(method, pathOrUrl, body) {
    if (nowMs() < state.paddlePausedUntil) throw new PaddleError(429, 'paused')
    const url = pathOrUrl.startsWith('https://') ? pathOrUrl : base + pathOrUrl
    // la clé ne part que vers l'hôte Paddle configuré (le lien « next » vient de Paddle)
    if (!url.startsWith(base + '/')) throw new PaddleError(0, 'foreign_url')

    for (let attempt = 0; attempt < 2; attempt++) {
      const remaining = deadline - nowMs()
      if (remaining < 300) throw new PaddleError(0, 'timeout')
      if (++calls > maxCalls) throw new PaddleError(0, 'too_many_calls')
      let res
      try {
        res = await fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${cfg.apiKey}`,
            'Paddle-Version': '1',
            Accept: 'application/json',
            ...(body ? { 'Content-Type': 'application/json' } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(Math.min(CALL_MS, remaining)),
        })
      } catch {
        if (attempt === 0 && deadline - nowMs() > 1500) {
          await sleep(150)
          continue
        }
        throw new PaddleError(0, 'network')
      }

      if (res.status === 429) {
        // Paddle bloque l'adresse 60 s : réessayer ne ferait que prolonger le blocage.
        state.paddlePausedUntil = nowMs() + retryAfterSeconds(res.headers.get('retry-after')) * 1000
        throw new PaddleError(429, 'too_many_requests')
      }
      if (res.status >= 500) {
        if (attempt === 0 && deadline - nowMs() > 1500) {
          await sleep(150)
          continue
        }
        throw new PaddleError(res.status, 'server_error')
      }
      let data = null
      try {
        data = await res.json()
      } catch {
        data = null
      }
      if (!res.ok) throw new PaddleError(res.status, data && data.error && typeof data.error.code === 'string' ? data.error.code.slice(0, 60) : '')
      if (!data || typeof data !== 'object') throw new PaddleError(res.status, 'bad_json')
      return data
    }
    throw new PaddleError(0, 'retries')
  }

  // Liste paginée : suit meta.pagination.next tant que has_more est vrai.
  // stop(item) permet de s'arrêter dès qu'on a trouvé. complete = tout a été vu.
  async function list(pathWithQuery, maxPages, stop) {
    const items = []
    let url = base + pathWithQuery
    for (let page = 1; ; page++) {
      const data = await call('GET', url)
      if (!Array.isArray(data.data)) throw new PaddleError(200, 'bad_shape')
      for (const item of data.data) {
        items.push(item)
        if (stop && (await stop(item))) return { items, complete: true, found: item }
      }
      const p = data.meta && data.meta.pagination
      if (!p || p.has_more !== true) return { items, complete: true, found: null }
      if (page >= maxPages || typeof p.next !== 'string') return { items, complete: false, found: null }
      url = p.next
    }
  }

  return {
    get: (path) => call('GET', path),
    post: (path, body) => call('POST', path, body),
    list,
    get calls() {
      return calls
    },
  }
}

// --- achats ----------------------------------------------------------------------

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
// Ids Paddle : préfixe + minuscules et chiffres. Vérifiés avant de servir de chemin
// d'URL ou de clé en base (un id inattendu ne doit rien contourner).
export const isCustomerId = (v) => typeof v === 'string' && v.length <= 64 && /^ctm_[a-z0-9]+$/.test(v)
export const isTxnId = (v) => typeof v === 'string' && v.length <= 64 && /^txn_[a-z0-9]+$/.test(v)

// La transaction contient-elle le prix Pro ? (items[].price.id d'après la doc,
// details.line_items[].price_id en secours)
export function hasProPrice(txn, priceId) {
  const items = Array.isArray(txn?.items) ? txn.items : []
  if (items.some((it) => isObj(it) && ((isObj(it.price) && it.price.id === priceId) || it.price_id === priceId))) return true
  const lines = Array.isArray(txn?.details?.line_items) ? txn.details.line_items : []
  return lines.some((l) => isObj(l) && l.price_id === priceId)
}

// Claim posé par la page /pro dans customData (32 hexadécimaux).
export function claimOf(txn) {
  const c = isObj(txn) && isObj(txn.custom_data) ? txn.custom_data.claim : null
  return typeof c === 'string' ? c.toLowerCase() : null
}

const toInt = (v) => {
  const n = typeof v === 'string' || typeof v === 'number' ? Number(v) : NaN
  return Number.isFinite(n) ? n : 0
}

// Achat annulé ? Rétrofacturation (chargeback) non annulée par Paddle, ou
// remboursement approuvé qui couvre l'article Pro ou le montant total.
// Un remboursement en attente d'approbation ne retire rien (il peut être refusé).
export function transactionRevoked(txn, adjustments, priceId) {
  const mine = adjustments.filter((a) => isObj(a) && a.transaction_id === txn.id)
  if (mine.some((a) => a.action === 'chargeback' && a.status !== 'reversed' && a.status !== 'rejected')) return true

  const refunds = mine.filter((a) => a.action === 'refund' && a.status === 'approved')
  if (refunds.length === 0) return false
  const lines = Array.isArray(txn?.details?.line_items) ? txn.details.line_items : []
  const proItemIds = new Set(lines.filter((l) => isObj(l) && l.price_id === priceId && l.id).map((l) => l.id))
  for (const a of refunds) {
    if (a.type === 'full') return true
    const items = Array.isArray(a.items) ? a.items : []
    // article inconnu : on retire quand même (en cas de doute, on ne donne pas)
    if (items.some((i) => isObj(i) && i.type === 'full' && (proItemIds.size === 0 || proItemIds.has(i.item_id)))) return true
  }
  const total = toInt(txn?.details?.totals?.grand_total ?? txn?.details?.totals?.total)
  const refunded = refunds.reduce((sum, a) => sum + toInt(a?.totals?.total), 0)
  return total > 0 && refunded >= total
}

// Ajustements (remboursements, rétrofacturations) de ces transactions. Tous sont lus
// puis filtrés ici : on ne dépend pas d'un filtre « action » côté Paddle.
export async function adjustmentsFor(paddle, txnIds) {
  const all = []
  for (let i = 0; i < txnIds.length; i += 20) {
    const ids = txnIds.slice(i, i + 20)
    const { items, complete } = await paddle.list(`/adjustments?${query({ transaction_id: ids, per_page: 50 })}`, PAGES.adjustments)
    // liste tronquée : impossible d'affirmer qu'il n'y a pas de remboursement
    if (!complete) throw new PaddleError(200, 'adjustments_truncated')
    all.push(...items)
  }
  return all
}

// Une transaction, lue par son id (un seul appel).
export async function getTransaction(paddle, txnId) {
  if (!isTxnId(txnId)) throw new PaddleError(0, 'bad_txn_id')
  const data = await paddle.get(`/transactions/${txnId}`)
  if (!isObj(data.data) || data.data.id !== txnId) throw new PaddleError(200, 'bad_shape')
  return data.data
}

// Achat Pro de ce claim : bon prix, bon claim, client connu. (Le statut se juge à part.)
export const isProForClaim = (t, cfg, claim) =>
  isObj(t) && isTxnId(t.id) && isCustomerId(t.customer_id) && hasProPrice(t, cfg.priceId) && claimOf(t) === claim

const isCompletedPro = (t, cfg) =>
  isObj(t) && t.status === 'completed' && isTxnId(t.id) && isCustomerId(t.customer_id) && hasProPrice(t, cfg.priceId)

// Transactions terminées des 48 dernières heures. Le résultat est partagé 5 s dans
// l'isolat : l'app interroge toutes les 5 s pendant le paiement, inutile de
// solliciter Paddle pour chaque appareil en attente. allowScan() est consulté avant
// tout nouveau balayage (plafond global partagé, voir claim.js).
async function recentCompleted(paddle, cfg, allowScan) {
  const key = cfg.apiBase + '|' + cfg.priceId
  const s = state.recentScan
  if (s && s.key === key && nowMs() - s.at < 5000) return s.promise
  if (!(await allowScan())) return null
  const since = rfc3339(nowMs() - CLAIM_WINDOW_MS)
  const promise = paddle.list(`/transactions?${query({ status: 'completed', 'created_at[GTE]': since, per_page: 30 })}`, PAGES.claimScan)
  state.recentScan = { key, at: nowMs(), promise }
  promise.catch(() => {
    if (state.recentScan && state.recentScan.promise === promise) state.recentScan = null
  })
  return promise
}

// Secours quand la base ne connaît pas ce claim (page /pro fermée avant la fin) :
// achat Pro terminé, de moins de 48 h, porteur de ce claim et non remboursé.
// { txn } trouvé ; { txn: null, final: false } sinon : liste tronquée, balayage
// refusé par le plafond ou pas encore payé, ce n'est jamais un échec définitif.
export async function findClaimTransaction(paddle, cfg, claim, allowScan) {
  const scan = await recentCompleted(paddle, cfg, allowScan)
  if (!scan) return { txn: null }
  const limit = nowMs() - CLAIM_WINDOW_MS
  const candidates = scan.items.filter((t) => {
    if (!isCompletedPro(t, cfg) || claimOf(t) !== claim) return false
    const created = Date.parse(t.created_at || '')
    return Number.isFinite(created) && created >= limit
  })
  if (candidates.length === 0) return { txn: null }
  const adjustments = await adjustmentsFor(
    paddle,
    candidates.slice(0, 20).map((t) => t.id),
  )
  return { txn: candidates.slice(0, 20).find((t) => !transactionRevoked(t, adjustments, cfg.priceId)) || null }
}

// État des achats Pro d'un client :
//   'valid'   au moins un achat terminé, ni remboursé ni rétrofacturé ;
//   'revoked' des achats terminés, tous remboursés ou rétrofacturés (preuve positive) ;
//   'none'    aucun achat Pro terminé trouvé : ce n'est PAS une preuve (prix changé,
//             réglage faux) ; l'appelant ne doit ni donner ni retirer.
export async function customerPurchaseState(paddle, cfg, customerId) {
  if (!isCustomerId(customerId)) throw new PaddleError(0, 'bad_customer_id')
  const { items, complete } = await paddle.list(
    `/transactions?${query({ customer_id: customerId, status: 'completed', per_page: 30 })}`,
    PAGES.customerTxns,
  )
  const txns = items.filter((t) => isCompletedPro(t, cfg) && t.customer_id === customerId).slice(0, 20)
  if (txns.length === 0) {
    if (!complete) throw new PaddleError(200, 'transactions_truncated')
    return 'none'
  }
  const adjustments = await adjustmentsFor(
    paddle,
    txns.map((t) => t.id),
  )
  if (txns.some((t) => !transactionRevoked(t, adjustments, cfg.priceId))) return 'valid'
  // liste tronquée : un achat valable pourrait être plus loin
  if (!complete) throw new PaddleError(200, 'transactions_truncated')
  return 'revoked'
}

// Client de cette adresse qui a un achat Pro valable, ou null. La doc ne dit pas si
// le filtre email de Paddle tient compte de la casse : on demande l'adresse telle
// que tapée et en minuscules, puis, sans résultat, la recherche plein texte de
// Paddle (id, nom, e-mail) ; dans tous les cas on ne garde ici que l'égalité exacte
// sans casse. Deux clients au plus sont examinés (appels bornés).
export async function purchaseForEmail(paddle, cfg, emailTyped, emailNorm) {
  const same = (c) => isObj(c) && isCustomerId(c.id) && typeof c.email === 'string' && c.email.trim().toLowerCase() === emailNorm
  const variants = [...new Set([emailNorm, typeof emailTyped === 'string' ? emailTyped.trim() : ''].filter(Boolean))]
  let customers = (await paddle.list(`/customers?${query({ email: variants, per_page: 50 })}`, PAGES.emailLookup)).items.filter(same)
  if (customers.length === 0 && emailNorm.length <= 100) {
    customers = (await paddle.list(`/customers?${query({ search: emailNorm, per_page: 50 })}`, PAGES.emailLookup)).items.filter(same)
  }
  for (const c of customers.slice(0, MAX_EMAIL_CUSTOMERS)) {
    if ((await customerPurchaseState(paddle, cfg, c.id)) === 'valid') return c
  }
  return null
}
