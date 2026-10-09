// Faux Paddle Billing (API v1) et faux Resend pour les tests des licences.
// Remplace globalThis.fetch : chaque appel est noté dans world.calls (méthode, URL,
// en-têtes), les clients, transactions et ajustements vivent dans « world ».
// Pagination comme Paddle : tri par id décroissant, curseur « after », meta.pagination.

let seq = 0
// Identifiants Paddle : préfixe + 26 caractères minuscules, croissants dans le temps.
export const pid = (prefix) => `${prefix}_${String(++seq).padStart(26, '0')}`

export function createWorld() {
  return {
    customers: [],
    transactions: [],
    adjustments: [],
    emails: [],
    calls: [],
    prices: { pri_pro: { EUR: 599, USD: 599, GBP: 549, JPY: 900 } }, // aperçus de prix
    previews: [], // aperçus de prix demandés
    fail: null, // { status, code, headers, times, network } : prochains appels Paddle en échec
    patchIgnored: false, // true : PATCH répond 200 sans rien enregistrer
  }
}

export function addCustomer(world, email, customData = null) {
  const c = { id: pid('ctm'), email, custom_data: customData, status: 'active' }
  world.customers.push(c)
  return c
}

export function addTransaction(world, { customer, claim, priceId = 'pri_pro', status = 'completed', createdAt, total = '599' } = {}) {
  const lineId = pid('txnitm')
  const t = {
    id: pid('txn'),
    status,
    customer_id: customer ? customer.id : null,
    custom_data: claim ? { claim } : null,
    created_at: createdAt || new Date().toISOString(),
    items: [{ price: { id: priceId }, quantity: 1 }],
    details: {
      totals: { total, grand_total: total },
      line_items: [{ id: lineId, price_id: priceId, quantity: 1 }],
    },
  }
  world.transactions.push(t)
  return t
}

export function addAdjustment(world, txn, { action = 'refund', status = 'approved', type = 'full', total, itemType } = {}) {
  const a = {
    id: pid('adj'),
    action,
    type,
    status,
    transaction_id: txn.id,
    customer_id: txn.customer_id,
    items: itemType ? [{ item_id: txn.details.line_items[0].id, type: itemType, amount: total || txn.details.totals.total }] : [],
    totals: { total: total || txn.details.totals.total },
  }
  world.adjustments.push(a)
  return a
}

const reply = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...headers } })

const list = (p, key) => (p.get(key) ? p.get(key).split(',') : null)

function paginate(url, items, maxPerPage, defaultPerPage) {
  const p = url.searchParams
  const perPage = Math.min(Number(p.get('per_page') || defaultPerPage), maxPerPage)
  let sorted = [...items].sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
  const after = p.get('after')
  if (after) sorted = sorted.filter((x) => x.id < after)
  const page = sorted.slice(0, perPage)
  const hasMore = sorted.length > perPage
  const nextParams = new URLSearchParams(p)
  if (page.length) nextParams.set('after', page[page.length - 1].id)
  return reply({
    data: structuredClone(page),
    meta: {
      request_id: 'req_test',
      pagination: { per_page: perPage, next: `${url.origin}${url.pathname}?${nextParams}`, has_more: hasMore, estimated_total: sorted.length },
    },
  })
}

function paddle(world, url, method, init) {
  const p = url.searchParams
  const path = url.pathname

  if (method === 'GET' && path === '/transactions') {
    const status = list(p, 'status')
    const customer = list(p, 'customer_id')
    const since = p.get('created_at[GTE]')
    const items = world.transactions.filter(
      (t) =>
        (!status || status.includes(t.status)) &&
        (!customer || customer.includes(t.customer_id)) &&
        (!since || Date.parse(t.created_at) >= Date.parse(since)),
    )
    return paginate(url, items, 30, 30)
  }
  if (method === 'POST' && path === '/pricing-preview') {
    // aperçu de prix : devise selon le pays, remise de lancement de 50 % (arrondi bas)
    const body = JSON.parse(init.body)
    const country = body && body.address && body.address.country_code
    const currency = { FR: 'EUR', DE: 'EUR', AT: 'EUR', GB: 'GBP', US: 'USD', JP: 'JPY' }[country] || 'USD'
    const item = body && Array.isArray(body.items) ? body.items[0] : null
    const base = item && world.prices[item.price_id] ? world.prices[item.price_id][currency] : null
    if (base == null) return reply({ error: { type: 'request_error', code: 'invalid_field' } }, 400)
    const total = body.discount_id ? Math.round(base / 2) : base
    const formatted = currency === 'JPY' ? `¥${total}` : `${currency} ${(total / 100).toFixed(2)}`
    world.previews.push({ country, discount: body.discount_id || null })
    return reply({
      data: {
        currency_code: currency,
        address: { country_code: country },
        details: { line_items: [{ price: { id: item.price_id }, quantity: 1, totals: { total: String(total) }, formatted_totals: { total: formatted } }] },
      },
      meta: { request_id: 'req_test' },
    })
  }
  const t = path.match(/^\/transactions\/(txn_[a-z0-9]+)$/)
  if (method === 'GET' && t) {
    const txn = world.transactions.find((x) => x.id === t[1])
    if (!txn) return reply({ error: { type: 'request_error', code: 'not_found', detail: 'not found' } }, 404)
    return reply({ data: structuredClone(txn), meta: { request_id: 'req_test' } })
  }
  if (method === 'GET' && path === '/customers') {
    // filtre email : égalité exacte, casse comprise (hypothèse la plus stricte) ;
    // search : sous-chaîne sans casse sur l'id et l'e-mail
    const emails = list(p, 'email')
    const search = (p.get('search') || '').toLowerCase()
    const items = world.customers.filter(
      (c) =>
        c.status === 'active' &&
        (!emails || emails.includes(c.email)) &&
        (!search || c.email.toLowerCase().includes(search) || c.id.includes(search)),
    )
    return paginate(url, items, 200, 50)
  }
  const m = path.match(/^\/customers\/(ctm_[a-z0-9]+)$/)
  if (m) {
    const c = world.customers.find((x) => x.id === m[1])
    if (!c) return reply({ error: { type: 'request_error', code: 'not_found', detail: 'not found' } }, 404)
    if (method === 'PATCH') {
      const body = JSON.parse(init.body)
      // comme Paddle (hypothèse prudente) : custom_data est remplacé en entier
      if ('custom_data' in body && !world.patchIgnored) c.custom_data = structuredClone(body.custom_data)
    }
    return reply({ data: structuredClone(c), meta: { request_id: 'req_test' } })
  }
  if (method === 'GET' && path === '/adjustments') {
    const txns = list(p, 'transaction_id')
    const actions = list(p, 'action')
    const items = world.adjustments.filter((a) => (!txns || txns.includes(a.transaction_id)) && (!actions || actions.includes(a.action)))
    return paginate(url, items, 50, 10)
  }
  return reply({ error: { type: 'request_error', code: 'not_found' } }, 404)
}

export function installFetch(world) {
  const real = globalThis.fetch
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url)
    const method = (init.method || 'GET').toUpperCase()
    const headers = { ...(init.headers || {}) }
    world.calls.push({ method, url: url.href, host: url.hostname, headers })

    if (url.hostname === 'api.resend.com') {
      world.emails.push({ headers, body: JSON.parse(init.body) })
      return reply({ id: 'email_test' })
    }
    if (url.hostname !== 'sandbox-api.paddle.com' && url.hostname !== 'api.paddle.com') {
      throw new Error('appel inattendu vers ' + url.hostname)
    }
    const f = world.fail
    if (f && (f.times === undefined || f.times > 0)) {
      if (f.times !== undefined) f.times--
      if (f.network) throw new TypeError('fetch failed')
      return reply({ error: { type: 'api_error', code: f.code || 'internal_error' } }, f.status, f.headers || {})
    }
    return paddle(world, url, method, init)
  }
  return () => {
    globalThis.fetch = real
  }
}
