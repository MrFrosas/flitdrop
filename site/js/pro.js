/* Page Flitdrop Pro (/pro, /fr/pro, /de/pro) : prix localisé et paiement Paddle
   (Paddle.js v2, fenêtre en surimpression).
   Aucun texte ici : tous les messages sont déjà dans la page, traduits par les
   outils i18n ; ce script ne fait qu'afficher le bon.
   - Configuration lue sur /api/license/config (même domaine). Absente, éteinte,
     invalide ou injoignable : l'offre reste affichée avec « Bientôt disponible »,
     sans bouton d'achat.
   - ?claim= (32 caractères hexadécimaux, venu de l'app) part dans customData :
     l'app retrouve l'achat toute seule. Sans claim : achat possible, puis
     « J'ai déjà acheté » dans l'app avec le même e-mail.
   - ?early=1 : remise de lancement si la configuration en donne une et que la
     fenêtre des premiers jours n'est pas passée.
   - Mesure : pro_view, pro_checkout_opened, pro_checkout_completed via
     js/analytics.js (PostHog seulement), jamais d'e-mail ni de montant autre que
     le prix affiché. */
(function () {
  'use strict';

  var PADDLE_JS = 'https://cdn.paddle.com/paddle/v2/paddle.js';
  var CONFIG_URL = '/api/license/config';

  function $(id) { return document.getElementById(id); }
  function show(id, on) { var e = $(id); if (e) e.hidden = !on; }

  var params = null;
  try { params = new URLSearchParams(location.search); } catch (e) {}
  function param(k) { return params ? params.get(k) : null; }

  var rawClaim = String(param('claim') || '').trim().toLowerCase();
  var claim = /^[0-9a-f]{32}$/.test(rawClaim) ? rawClaim : null;
  var wantsEarly = param('early') === '1';
  // langue de la page (le chemin fait foi : /fr/pro, /de/pro, sinon anglais)
  var m = /^\/(fr|de)\//.exec(location.pathname || '/');
  var locale = m ? m[1] : 'en';

  var cfg = null;
  var early = false;
  var done = false;
  var priceShown = '';
  var paddlePromise = null;

  /* ---------- mesure ---------- */

  function track(name, props) {
    // analytics.js est chargé en asynchrone : s'il n'est pas encore là, file d'attente
    if (typeof window.fdTrack === 'function') window.fdTrack(name, props);
    else (window.fdTrackQ = window.fdTrackQ || []).push([name, props]);
  }
  function context() { return { from_app: !!claim, early: early, price_shown: priceShown }; }

  /* ---------- prix ---------- */

  function setPrice(text, was) {
    var el = $('proPrice');
    if (!el || !text) return;
    el.textContent = text;
    priceShown = text;
    var w = $('proPriceWas');
    if (w) { w.textContent = was || ''; w.hidden = !was; }
  }

  // Prix de secours sans Paddle : la devise devinée par le fuseau horaire. L'euro
  // garde le texte de la page, déjà écrit au format de la langue.
  function guessCurrency() {
    var tz = '';
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) {}
    if (/^Europe\/(London|Belfast|Jersey|Guernsey|Isle_of_Man)$/.test(tz)) return 'GBP';
    if (/^(America\/|US\/|Pacific\/Honolulu$)/.test(tz)) return 'USD';
    return 'EUR';
  }
  function fallbackPrice() {
    var d = cfg && cfg.displayPrice;
    var cur = guessCurrency();
    if (cur !== 'EUR' && d && typeof d[cur] === 'string' && d[cur].length <= 24) setPrice(d[cur]);
    else { var el = $('proPrice'); if (el) priceShown = el.textContent.trim(); }
  }

  /* ---------- configuration ---------- */

  function loadConfig() {
    if (!window.fetch) return Promise.resolve(null);
    var ctl = window.AbortController ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, 8000);
    return fetch(CONFIG_URL, { cache: 'no-store', credentials: 'omit', headers: { Accept: 'application/json' }, signal: ctl ? ctl.signal : undefined })
      .then(function (r) {
        var type = (r.headers && r.headers.get('content-type')) || '';
        return r.ok && type.indexOf('json') !== -1 ? r.json() : null;
      })
      .catch(function () { return null; })
      .then(function (j) { clearTimeout(timer); return j; });
  }

  function usable(c) {
    return !!(c && c.enabled === true &&
      typeof c.clientToken === 'string' && /^(test|live)_[A-Za-z0-9_-]{8,128}$/.test(c.clientToken) &&
      typeof c.priceId === 'string' && /^pri_[A-Za-z0-9]{8,64}$/.test(c.priceId));
  }

  function earlyAllowed(c) {
    if (!wantsEarly || typeof c.earlyDiscountId !== 'string' || !/^dsc_[A-Za-z0-9]{8,64}$/.test(c.earlyDiscountId)) return false;
    var start = c.launchedAt ? Date.parse(c.launchedAt) : NaN;
    if (isNaN(start)) return true; // Paddle reste juge : la remise a sa propre date de fin
    var days = typeof c.earlyDays === 'number' && c.earlyDays > 0 ? c.earlyDays : 30;
    return Date.now() < start + days * 864e5;
  }

  /* ---------- Paddle ---------- */

  function loadPaddle() {
    if (paddlePromise) return paddlePromise;
    paddlePromise = new Promise(function (resolve, reject) {
      function init() {
        try {
          if (cfg.env === 'sandbox') window.Paddle.Environment.set('sandbox');
          window.Paddle.Initialize({ token: cfg.clientToken, eventCallback: onPaddleEvent });
          resolve(window.Paddle);
        } catch (e) { reject(e); }
      }
      if (window.Paddle) return init();
      // Paddle Retain (script ProfitWell) ne sert pas ici : Paddle.js ne le charge
      // pas quand window.profitwell se dit déjà chargé. Un tiers de moins.
      if (!window.profitwell) window.profitwell = { isLoaded: true };
      var s = document.createElement('script');
      s.src = PADDLE_JS;
      s.async = true;
      s.onload = function () { if (window.Paddle) init(); else reject(new Error('paddle')); };
      s.onerror = function () { reject(new Error('paddle')); };
      (document.head || document.documentElement).appendChild(s);
    });
    // un échec réseau peut se réessayer au prochain clic
    paddlePromise.catch(function () { paddlePromise = null; });
    return paddlePromise;
  }

  function preview(withDiscount) {
    var req = { items: [{ priceId: cfg.priceId, quantity: 1 }] };
    if (withDiscount) req.discountId = cfg.earlyDiscountId;
    return window.Paddle.PricePreview(req).then(function (r) {
      var items = r && r.data && r.data.details && r.data.details.lineItems;
      var total = items && items[0] && items[0].formattedTotals && items[0].formattedTotals.total;
      if (typeof total !== 'string' || !total || total.length > 24) throw new Error('preview');
      return total;
    });
  }

  function localizePrice() {
    var normal = preview(false);
    if (!early) return normal.then(function (t) { setPrice(t); });
    var reduced = preview(true).then(null, function () { return null; });
    return Promise.all([reduced, normal]).then(function (a) {
      if (a[0]) return setPrice(a[0], a[0] !== a[1] ? a[1] : null);
      // remise refusée par Paddle (expirée, épuisée) : prix normal, sans promesse
      early = false;
      show('proEarly', false);
      setPrice(a[1]);
    });
  }

  function onPaddleEvent(ev) {
    if (!ev || typeof ev.name !== 'string') return;
    if (ev.name === 'checkout.completed' && !done) {
      done = true;
      showDone();
      track('pro_checkout_completed', context());
    } else if (ev.name === 'checkout.closed' && done) {
      var d = $('proDone');
      if (d) d.focus();
    }
  }

  /* ---------- états de la page ---------- */

  function showSoon() {
    // pas encore en vente : rien à expliquer sur l'achat
    show('proFromApp', false);
    show('proFromWeb', false);
    show('proSoon', true);
    show('proReady', false);
  }

  function showReady() {
    show('proSoon', false);
    show('proEarly', early);
    show('proAfterWeb', !claim);
    show('proReady', true);
  }

  function showDone() {
    show('proReady', false);
    show('proError', false);
    show('proFromApp', false);
    show('proFromWeb', false);
    show('proDoneApp', !!claim);
    show('proDoneWeb', !claim);
    show('proDone', true);
  }

  function buy() {
    if (!cfg || done) return;
    var btn = $('proBuy');
    show('proError', false);
    if (btn) btn.disabled = true;
    loadPaddle().then(function (P) {
      var opts = {
        items: [{ priceId: cfg.priceId, quantity: 1 }],
        settings: { displayMode: 'overlay', locale: locale, theme: 'light' }
      };
      if (claim) opts.customData = { claim: claim };
      if (early) opts.discountId = cfg.earlyDiscountId;
      P.Checkout.open(opts);
      track('pro_checkout_opened', context());
    }).catch(function () {
      show('proError', true);
    }).then(function () {
      if (btn) btn.disabled = false;
    });
  }

  function start() {
    // venu de l'app : il a déjà Flitdrop, l'achat se rattache tout seul
    show('proFromApp', !!claim);
    show('proFromWeb', !claim);
    show('proGet', !claim);
    var btn = $('proBuy');
    if (btn) btn.addEventListener('click', buy);

    loadConfig().then(function (c) {
      if (!usable(c)) {
        cfg = c && typeof c === 'object' ? c : null;
        fallbackPrice();
        showSoon();
        track('pro_view', { from_app: !!claim, early: false, available: false });
        return;
      }
      cfg = c;
      early = earlyAllowed(c);
      showReady();
      track('pro_view', { from_app: !!claim, early: early, available: true });
      loadPaddle().then(localizePrice).catch(fallbackPrice);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
