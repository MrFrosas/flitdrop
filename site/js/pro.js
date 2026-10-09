/* Page Flitdrop Pro (/pro, /fr/pro, /de/pro) : prix et paiement Paddle (Paddle.js v2,
   fenêtre en surimpression).
   Aucun texte ici : tous les messages sont déjà dans la page, traduits par les
   outils i18n ; ce script ne fait qu'afficher le bon.
   - Chargé tout en haut du <head>, AVANT js/analytics.js : il lit ?claim=, ?early= et
     ?lang= puis les retire aussitôt de la barre d'adresse (history.replaceState),
     avant qu'un outil de mesure ne voie l'adresse. Les valeurs restent en mémoire, et
     dans le sessionStorage de l'onglet pour survivre au changement de langue.
     Le claim n'est que l'empreinte d'un secret que l'app garde pour elle : même lu
     ailleurs, il ne débloque rien.
   - Configuration et prix lus sur /api/license/config (même domaine) : le serveur
     donne le prix localisé pour le pays du visiteur. Absente, éteinte, invalide ou
     injoignable : l'offre reste affichée avec « Bientôt disponible », sans bouton.
   - Paddle.js n'est chargé qu'au clic sur « Débloquer » : aucune requête vers Paddle
     à la simple visite de la page.
   - Paiement terminé : la transaction est signalée à /api/license/checkout-done, et
     l'app la retrouve tout de suite (sans claim, rien n'est envoyé).
   - ?early=1 : prix de lancement si la configuration en donne un et que la fenêtre
     des premiers jours n'est pas passée. Jamais de prix barré.
   - Mesure : pro_view, pro_checkout_opened, pro_checkout_completed via
     js/analytics.js (PostHog seulement), jamais d'e-mail ni de montant autre que
     le prix affiché. */
(function () {
  'use strict';

  var PADDLE_JS = 'https://cdn.paddle.com/paddle/v2/paddle.js';
  var CONFIG_URL = '/api/license/config';
  var DONE_URL = '/api/license/checkout-done';
  var STASH = 'fd_pro';
  var STASH_MS = 6 * 3600e3;

  /* ---------- paramètres de l'adresse, lus puis retirés tout de suite ---------- */

  var claim = null;
  var wantsEarly = false;
  (function takeParams() {
    var q = null;
    try { q = new URLSearchParams(location.search); } catch (e) { return; }
    var raw = String(q.get('claim') || '').trim().toLowerCase();
    if (/^[0-9a-f]{32}$/.test(raw)) claim = raw;
    wantsEarly = q.get('early') === '1';
    var had = q.has('claim') || q.has('early') || q.has('lang');
    if (claim) {
      try { sessionStorage.setItem(STASH, JSON.stringify({ c: claim, e: wantsEarly, t: Date.now() })); } catch (e) {}
    } else if (!had) {
      // pas de paramètre : peut-être la même visite, après un changement de langue
      try {
        var s = JSON.parse(sessionStorage.getItem(STASH) || 'null');
        if (s && /^[0-9a-f]{32}$/.test(s.c) && Date.now() - s.t < STASH_MS) { claim = s.c; wantsEarly = s.e === true; }
      } catch (e) {}
    }
    // la page anglaise part déjà vers la page traduite : elle reverra l'adresse entière
    if (!had || window.__fdLangRedirect) return;
    q.delete('claim'); q.delete('early'); q.delete('lang');
    var rest = q.toString();
    try { history.replaceState(history.state, '', location.pathname + (rest ? '?' + rest : '') + location.hash); } catch (e) {}
  })();

  function $(id) { return document.getElementById(id); }
  function show(id, on) { var e = $(id); if (e) e.hidden = !on; }

  // langue de la page (le chemin fait foi : /fr/pro, /de/pro, sinon anglais)
  var m = /^\/(fr|de)\//.exec(location.pathname || '/');
  var locale = m ? m[1] : 'en';
  var DATE_LOCALE = { en: 'en-GB', fr: 'fr-FR', de: 'de-DE' };

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

  var okText = function (t) { return typeof t === 'string' && t.length > 0 && t.length <= 24; };

  function setPrice(text) {
    var el = $('proPrice');
    if (!el) return;
    if (okText(text)) el.textContent = text;
    priceShown = el.textContent.trim();
  }

  // « TTC » / « inkl. MwSt. » / « taxes included » à côté du prix : seulement pour un
  // prix en euros ou en livres (TVA comprise chez Paddle). En dollars et autres
  // devises, la taxe locale peut s'ajouter au paiement : la mention est cachée.
  function setTax(c) {
    var cur = hasPrice(c) ? c.price.currency : 'EUR';
    show('proTax', cur === 'EUR' || cur === 'GBP');
  }

  // Fin du prix de lancement : launchedAt + earlyDays (dernier jour compris).
  function earlyEnd(c) {
    var start = c.launchedAt ? Date.parse(c.launchedAt) : NaN;
    if (isNaN(start)) return null;
    var days = typeof c.earlyDays === 'number' && c.earlyDays > 0 ? c.earlyDays : 30;
    return start + days * 864e5;
  }

  // « Prix de lancement ..., jusqu'au {date}. Ensuite, Flitdrop Pro coûte {price}. »
  function fillEarlyLine(c) {
    var el = $('proEarly');
    if (!el) return false;
    var tpl = el.getAttribute('data-tpl') || el.textContent;
    el.setAttribute('data-tpl', tpl);
    var date = '';
    try {
      date = new Intl.DateTimeFormat(DATE_LOCALE[locale], { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(earlyEnd(c) - 1));
    } catch (e) { return false; }
    el.textContent = tpl.replace('{date}', date).replace('{price}', c.price.display);
    return true;
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

  function hasPrice(c) {
    return !!(c && c.price && okText(c.price.display) && okText(c.price.displayEarly));
  }

  function earlyAllowed(c) {
    if (!wantsEarly || typeof c.earlyDiscountId !== 'string' || !/^dsc_[A-Za-z0-9]{8,64}$/.test(c.earlyDiscountId)) return false;
    var end = earlyEnd(c);
    // sans date de lancement, pas de prix de lancement annoncé (on ne saurait pas dire jusqu'à quand)
    return end !== null && hasPrice(c) && Date.now() < end;
  }

  /* ---------- Paddle (seulement au clic) ---------- */

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

  // Paiement terminé : la transaction est signalée au serveur, qui la vérifie chez
  // Paddle et la note ; l'app la retrouve à son prochain appel. Trois envois au plus
  // (la transaction peut mettre quelques secondes à passer « payée »).
  function reportCheckout(txnId) {
    if (!claim || !window.fetch || typeof txnId !== 'string' || !/^txn_[a-z0-9]{1,60}$/.test(txnId)) return;
    var body = JSON.stringify({ transaction_id: txnId, claim: claim });
    [0, 5000, 20000].forEach(function (delay) {
      setTimeout(function () {
        try {
          fetch(DONE_URL, { method: 'POST', credentials: 'omit', keepalive: true, headers: { 'content-type': 'application/json' }, body: body })
            .catch(function () {});
        } catch (e) {}
      }, delay);
    });
  }

  function onPaddleEvent(ev) {
    if (!ev || typeof ev.name !== 'string') return;
    if (ev.name === 'checkout.completed' && !done) {
      done = true;
      reportCheckout(ev.data && ev.data.transaction_id);
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
      if (hasPrice(c)) setPrice(c.price.display);
      else setPrice(null);
      setTax(c);
      if (!usable(c)) {
        cfg = c && typeof c === 'object' ? c : null;
        showSoon();
        track('pro_view', { from_app: !!claim, early: false, available: false });
        return;
      }
      cfg = c;
      early = earlyAllowed(c) && fillEarlyLine(c);
      if (early) setPrice(c.price.displayEarly);
      showReady();
      track('pro_view', { from_app: !!claim, early: early, available: true });
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
