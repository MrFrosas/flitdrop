/* Mesure d'audience et téléchargements du site, sur toutes les pages (un seul
   script partagé, chargé dans le <head>).

   Consentement selon la région du visiteur :
   - UE/EEE + Royaume-Uni + Suisse (et en cas de doute) : bannière Accepter /
     Refuser à poids égal, rien de non exempté avant un « oui » ;
   - ailleurs : mesure active par défaut, sans bannière ;
   - pour tous : lien « Cookies » ajouté au pied de page pour changer d'avis,
     et window.fdConsent = { get(), set(bool), open() }.
   Choix mémorisé dans localStorage « fd_consent » = { v: 1, analytics, t },
   redemandé au bout de 6 mois.

   Outils :
   - Cloudflare Web Analytics (sans cookie) : injecté par Cloudflare, pour tous ;
   - PostHog (projet UE, via le relais /ph du même domaine, voir functions/ph) :
     tant que le visiteur n'a pas choisi, il compte seulement les pages vues,
     les clics de téléchargement et la réponse au bandeau, sans rien stocker
     sur l'appareil (cookieless « on_reject », hachage côté serveur) ; avec
     consentement, persistance normale et replays de session (saisies
     masquées) ; après un refus, compté une fois, plus rien du tout (le bouton
     Refuser vaut opposition, même sans cookie) ;
   - Google Analytics 4 et Microsoft Clarity : chargés SEULEMENT si la mesure
     est permise (Consent Mode v2 : publicité toujours refusée).
   Historique : GA4 avait été retiré le 23/09/2026 (sans bannière, le Consent Mode
   « refusé par défaut » faisait exclure les visites des rapports) ; il revient
   le même jour avec cette bannière. */
(function () {
  'use strict';

  var GA_ID = 'G-6D1N284CCF';
  var CLARITY_ID = 'ymw92zz0sr';
  var PH_TOKEN = 'phc_urqVGgN2XuWcGdkBGagawWbaPRU88HxosDHQ9NXwkmWP';
  var KEY = 'fd_consent';
  var MAX_AGE = 182 * 864e5; // on redemande au bout de 6 mois

  // Pays où la mesure attend un « oui » explicite : UE 27, Islande, Liechtenstein,
  // Norvège, Royaume-Uni, Suisse, plus les codes ISO propres aux régions
  // ultrapériphériques, à Åland et aux dépendances britanniques.
  var OPTIN = ('AT BE BG HR CY CZ DK EE FI FR DE GR IE IT LV LT LU MT NL PL PT RO SK SI ES SE HU ' +
    'IS LI NO GB CH GF GP MQ RE YT MF AX GI JE GG IM').split(' ');
  // Fuseaux de ces pays hors « Europe/* » (Canaries, Açores, DOM, Chypre...).
  var OPTIN_TZ = /^(Europe\/|Atlantic\/(Canary|Madeira|Azores|Reykjavik)$|Indian\/(Reunion|Mayotte)$|America\/(Guadeloupe|Martinique|Cayenne|Marigot)$|Asia\/(Nicosia|Famagusta)$|Africa\/Ceuta$|Arctic\/Longyearbyen$)/;

  // Chargeur officiel PostHog (file d'attente) : window.posthog existe tout de
  // suite pour app.js ; la vraie bibliothèque arrive par /ph/static/array.js.
  !function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="init capture register register_once register_for_session unregister unregister_for_session getFeatureFlag getFeatureFlagPayload isFeatureEnabled reloadFeatureFlags updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSessionId getSurveys getActiveMatchingSurveys renderSurvey canRenderSurvey identify setPersonProperties group resetGroups setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags reset get_distinct_id getGroups get_session_id get_session_replay_url alias set_config startSessionRecording stopSessionRecording sessionRecordingStarted captureException loadToolbar get_property getSessionProperty createPersonProfile opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing clear_opt_in_out_capturing debug getPageViewId".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);

  /* ---------- consentement ---------- */

  function readChoice() {
    try {
      var c = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (c && c.v === 1 && typeof c.analytics === 'boolean' && typeof c.t === 'number') return c;
    } catch (_) {}
    return null;
  }
  function writeChoice(ok) {
    try { localStorage.setItem(KEY, JSON.stringify({ v: 1, analytics: !!ok, t: Date.now() })); } catch (_) {}
  }
  function isFresh(c) { return !!c && Date.now() - c.t < MAX_AGE; }

  // granted | denied | pending. Hors zone, un refus même ancien reste un refus :
  // la mesure ne reprend jamais en silence.
  function decide(c, optIn) {
    if (isFresh(c)) return c.analytics ? 'granted' : 'denied';
    if (optIn) return 'pending';
    return c && !c.analytics ? 'denied' : 'granted';
  }

  // Repli sans réseau : fuseau horaire, puis région des langues du navigateur.
  // Fuseau absent ou neutre (UTC, Etc/...) : dans le doute, on demande.
  function guessOptIn() {
    var tz = '';
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (_) {}
    if (OPTIN_TZ.test(tz)) return true;
    var langs = (navigator.languages && navigator.languages.length) ? navigator.languages : [navigator.language || ''];
    for (var i = 0; i < langs.length; i++) {
      var parts = String(langs[i] || '').split('-');
      for (var j = 1; j < parts.length; j++) {
        if (parts[j].length === 2 && OPTIN.indexOf(parts[j].toUpperCase()) !== -1) return true;
      }
    }
    return !tz || /^(UTC|GMT|Etc\/)/.test(tz);
  }

  // Pays donné par Cloudflare sur le même domaine (/cdn-cgi/trace, ligne loc=XX),
  // mémorisé pour la session ; au-delà de 1,5 s ou en cas d'échec, le repli.
  // Seul le verdict (1 ou 0) est gardé, jamais l'adresse IP que renvoie trace.
  function detectRegion(done) {
    try {
      var s = sessionStorage.getItem('fd_geo');
      if (s === '1' || s === '0') return done(s === '1');
    } catch (_) {}
    var over = false;
    function finish(v) {
      if (over) return;
      over = true;
      clearTimeout(timer);
      try { sessionStorage.setItem('fd_geo', v ? '1' : '0'); } catch (_) {}
      done(v);
    }
    var timer = setTimeout(function () { finish(guessOptIn()); }, 1500);
    if (!window.fetch) return finish(guessOptIn());
    fetch('/cdn-cgi/trace', { cache: 'no-store', credentials: 'omit' })
      .then(function (r) { return r.ok ? r.text() : ''; })
      .then(function (txt) {
        var m = /(?:^|\n)loc=([A-Z]{2})\s*(?:\n|$)/.exec(txt || '');
        // XX = inconnu, T1 = Tor : pas de pays fiable
        if (!m || m[1] === 'XX' || m[1] === 'T1') return finish(guessOptIn());
        finish(OPTIN.indexOf(m[1]) !== -1);
      })
      .catch(function () { finish(guessOptIn()); });
  }

  var state = null;       // granted | denied | pending, null tant que rien n'est décidé
  var optInRegion = null; // null si un choix récent a évité la détection
  var accepted = false;   // « Accepter » cliqué pendant cette visite (même si le stockage est bloqué)

  function apply(next) {
    var prev = state;
    state = next;
    var allowed = next === 'granted';
    // Refus = opposition : PostHog n'est jamais démarré, ou se tait s'il tourne déjà.
    if (!phStarted) { if (next !== 'denied') startPostHog(allowed); }
    else if (phReady) {
      if (allowed && prev !== 'granted') phOptIn(window.posthog);
      else if (!allowed && prev === 'granted') window.posthog.opt_out_capturing();
      if (next === 'denied') phSilence(window.posthog);
    }
    if (allowed) { loadGA(); loadClarity(); }
    else if (prev === 'granted') { stopGA(); stopClarity(); clearTrackerStorage(); }
    if (next === 'pending') showBanner(false);
  }

  function choose(ok) {
    accepted = !!ok;
    writeChoice(ok);
    hideBanner();
    // un refus est compté une seule fois, anonymement, juste avant que PostHog se taise
    if (!ok) phCapture('consent_choice', { choice: 'refuse' });
    apply(ok ? 'granted' : 'denied');
    if (ok) phCapture('consent_choice', { choice: 'accept' });
  }

  /* ---------- PostHog ---------- */

  var phStarted = false, phReady = false, phSilenced = false;
  // Sans accord (en attente) : seulement pages vues, clics de téléchargement et
  // réponse au bandeau ; après un refus : rien. Filtre appliqué à tout ce que
  // PostHog enverrait (clics automatiques, cartes de chaleur, replays, temps
  // passé, erreurs, événements de app.js).
  var PH_COOKIELESS = ['$pageview', 'download_click', 'store_click', 'mobile_copy_link', 'consent_choice'];
  function phFilter(ev) {
    if (!ev || state === 'granted') return ev;
    if (state === 'denied') return null;
    return PH_COOKIELESS.indexOf(ev.event) !== -1 ? ev : null;
  }
  function phOptIn(p) {
    p.opt_in_capturing({ captureEventName: false });
    if (phSilenced) { phSilenced = false; try { p.startSessionRecording(); } catch (_) {} }
  }
  function phSilence(p) {
    phSilenced = true;
    try { p.stopSessionRecording(); } catch (_) {}
  }
  function phCapture(name, props) {
    if (state === 'denied') return; // rien en file d'attente non plus
    try { if (window.posthog) window.posthog.capture(name, props); } catch (_) {}
  }
  function startPostHog(allowed) {
    phStarted = true;
    window.posthog.init(PH_TOKEN, {
      api_host: window.location.origin + '/ph',
      ui_host: 'https://eu.posthog.com',
      // en attente de choix : comptage anonyme, aucun stockage (voir phFilter)
      cookieless_mode: 'on_reject',
      opt_out_capturing_by_default: !allowed,
      person_profiles: 'identified_only',
      autocapture: true,
      capture_pageview: true,
      capture_pageleave: true,
      enable_heatmaps: true,
      session_recording: { maskAllInputs: true },
      before_send: phFilter,
      // Aligne l'accord mémorisé par PostHog sur le nôtre (source de vérité) :
      // la page vue initiale part ensuite une seule fois, dans le bon mode.
      loaded: function (p) {
        phReady = true;
        var st = p.get_explicit_consent_status();
        if (state === 'granted' && st !== 'granted') phOptIn(p);
        else if (state !== 'granted' && st === 'granted') p.opt_out_capturing();
        if (state === 'denied') phSilence(p);
      }
    });
  }

  /* ---------- Google Analytics 4 ---------- */

  var gaLoaded = false;
  function gtag() { window.dataLayer.push(arguments); }
  function loadGA() {
    window['ga-disable-' + GA_ID] = false;
    if (gaLoaded) { gtag('consent', 'update', { analytics_storage: 'granted' }); return; }
    gaLoaded = true;
    window.dataLayer = window.dataLayer || [];
    window.gtag = gtag;
    // filet : refusé par défaut dans la zone UE/EEE/RU/CH, quoi qu'on ait détecté
    gtag('consent', 'default', { ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied', analytics_storage: 'denied', region: OPTIN });
    gtag('consent', 'default', { ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied', analytics_storage: 'granted' });
    // un « oui » explicite lève le filet, même si le choix n'a pas pu être mémorisé
    var c = readChoice();
    if (accepted || (isFresh(c) && c.analytics)) gtag('consent', 'update', { analytics_storage: 'granted' });
    gtag('js', new Date());
    // cookies _ga limités à 13 mois (395 jours), sans prolongation à chaque visite
    gtag('config', GA_ID, { cookie_expires: 34128000, cookie_update: false });
    addScript('https://www.googletagmanager.com/gtag/js?id=' + GA_ID);
  }
  function stopGA() {
    if (!gaLoaded) return;
    gtag('consent', 'update', { analytics_storage: 'denied' });
    window['ga-disable-' + GA_ID] = true;
  }

  /* ---------- Microsoft Clarity ---------- */

  var clarityLoaded = false;
  function loadClarity() {
    if (!clarityLoaded) {
      clarityLoaded = true;
      window.clarity = window.clarity || function () { (window.clarity.q = window.clarity.q || []).push(arguments); };
      addScript('https://www.clarity.ms/tag/' + CLARITY_ID);
    }
    window.clarity('consentv2', { ad_Storage: 'denied', analytics_Storage: 'granted' });
  }
  function stopClarity() {
    if (!clarityLoaded) return;
    window.clarity('consentv2', { ad_Storage: 'denied', analytics_Storage: 'denied' });
    window.clarity('consent', false); // efface ses cookies et arrête le suivi
  }

  function addScript(src) {
    var s = document.createElement('script');
    s.async = true;
    s.src = src;
    (document.head || document.documentElement).appendChild(s);
  }

  // Après un refus : cookies GA, Clarity et PostHog, sur toutes les variantes de domaine.
  function clearTrackerStorage() {
    function run() {
      var host = location.hostname;
      var base = host.split('.').slice(-2).join('.');
      var domains = ['', '; domain=' + host, '; domain=.' + host, '; domain=.' + base];
      document.cookie.split(';').forEach(function (kv) {
        var name = kv.split('=')[0].trim();
        if (!/^(_ga|_ga_\w+|_gid|_gat\w*|_clck|_clsk|ph_\w+_posthog)$/.test(name)) return;
        domains.forEach(function (d) { document.cookie = name + '=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/' + d; });
      });
      try {
        for (var i = localStorage.length - 1; i >= 0; i--) {
          var k = localStorage.key(i);
          if (k && k.indexOf('ph_' + PH_TOKEN) === 0) localStorage.removeItem(k);
        }
        for (var j = sessionStorage.length - 1; j >= 0; j--) {
          var sk = sessionStorage.key(j);
          if (sk && sk.indexOf('ph_' + PH_TOKEN) === 0) sessionStorage.removeItem(sk);
        }
      } catch (_) {}
    }
    run();
    setTimeout(run, 1500); // au cas où un script en vol en réécrirait un
  }

  /* ---------- bannière ---------- */

  var FALLBACK = {
    'consent.title': 'Your privacy choice',
    'consent.text': 'We would like to use cookies to count visits and watch recordings of how the site is used, with typed text hidden (Google Analytics, Microsoft Clarity, PostHog). Without cookies, PostHog only counts visits anonymously; Refuse turns that off too.',
    'consent.more': 'Learn more',
    'consent.accept': 'Accept',
    'consent.refuse': 'Refuse',
    'consent.link': 'Cookies'
  };
  function lang() {
    var l = (window.FDI18N && window.FDI18N.lang) || document.documentElement.getAttribute('lang') || 'en';
    return String(l).slice(0, 2).toLowerCase();
  }
  function tr(key) {
    var d = window.FD_I18N_DATA || {}, l = lang();
    return (d[l] && d[l][key]) || (d.en && d.en[key]) || FALLBACK[key];
  }
  function whenReady(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }

  var box = null, opener = null;
  function build() {
    box = document.createElement('div');
    box.className = 'consent';
    box.id = 'fd-consent';
    box.hidden = true;
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-live', 'polite');
    box.setAttribute('aria-describedby', 'fd-consent-text');
    box.innerHTML =
      '<p class="consent-text" id="fd-consent-text"><span></span> <a href="/privacy"></a></p>' +
      '<div class="consent-actions">' +
      '<button type="button" class="consent-btn" data-choice="0"></button>' +
      '<button type="button" class="consent-btn" data-choice="1"></button>' +
      '</div>';
    box.addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('[data-choice]');
      if (b) choose(b.getAttribute('data-choice') === '1');
    });
    // Échap ferme seulement une bannière rouverte : le premier choix reste explicite.
    box.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && state !== 'pending') hideBanner();
    });
    document.body.insertBefore(box, document.body.firstChild);
    window.addEventListener('fd-lang', fill);
    window.addEventListener('resize', place);
    window.addEventListener('load', place); // la mise en page bouge encore au chargement
  }
  function fill() {
    if (!box) return;
    var l = lang();
    box.setAttribute('aria-label', tr('consent.title'));
    box.querySelector('.consent-text span').textContent = tr('consent.text');
    var a = box.querySelector('.consent-text a');
    a.textContent = tr('consent.more');
    // la page de confidentialité change de langue avec ?lang=
    a.setAttribute('href', l === 'en' ? '/privacy' : '/privacy?lang=' + l);
    box.querySelector('[data-choice="1"]').textContent = tr('consent.accept');
    box.querySelector('[data-choice="0"]').textContent = tr('consent.refuse');
  }
  // Sur téléphone, la bannière passe en haut si elle masquerait le bouton de téléchargement.
  function place() {
    if (!box || box.hidden) return;
    box.classList.remove('consent--top');
    if (window.innerWidth > 560) return;
    var ctas = document.querySelectorAll('#ctaDownload, .hero .btn-primary, .dl-buttons .btn-primary');
    var r = box.getBoundingClientRect();
    for (var i = 0; i < ctas.length; i++) {
      var c = ctas[i].getBoundingClientRect();
      if (c.height && c.bottom > r.top && c.top < r.bottom) { box.classList.add('consent--top'); return; }
    }
  }
  function showBanner(focus) {
    whenReady(function () {
      if (!box) build();
      fill();
      box.hidden = false;
      place();
      requestAnimationFrame(function () { if (box) box.classList.add('is-in'); });
      if (focus) box.querySelector('[data-choice]').focus();
    });
  }
  function hideBanner() {
    if (!box || box.hidden) return;
    var hadFocus = box.contains(document.activeElement);
    box.classList.remove('is-in');
    box.hidden = true;
    if (hadFocus && opener && opener.focus) opener.focus();
    opener = null;
  }

  // Lien « Cookies » du pied de page (ajouté ici : aucun texte ne change dans les
  // pages) et tout élément [data-consent-open] : rouvrent la bannière.
  function addFooterLink() {
    var ref = document.querySelector('footer a[href^="/privacy"]');
    if (!ref || document.querySelector('footer [data-consent-link]')) return;
    var a = document.createElement('a');
    a.href = '#cookies';
    a.setAttribute('role', 'button');
    a.setAttribute('data-consent-open', '');
    a.setAttribute('data-consent-link', '');
    a.setAttribute('data-i18n', 'consent.link');
    a.textContent = tr('consent.link');
    ref.parentNode.insertBefore(a, ref.nextSibling);
  }
  document.addEventListener('click', function (e) {
    var o = e.target && e.target.closest && e.target.closest('[data-consent-open]');
    if (!o) return;
    e.preventDefault();
    opener = o;
    showBanner(true);
  });

  window.fdConsent = {
    // state : granted | denied | pending, ou null tant que la région est en cours de détection
    get: function () { return { state: state, analytics: state === 'granted', optInRegion: optInRegion, choice: readChoice() }; },
    set: function (ok) { choose(!!ok); },
    open: function () { opener = document.activeElement; showBanner(true); }
  };

  // Démarrage : un choix récent suffit ; sinon on détermine la région.
  (function start() {
    var c = readChoice();
    if (isFresh(c)) return apply(decide(c, null));
    detectRegion(function (r) {
      optInRegion = r;
      if (state === null) apply(decide(readChoice(), r)); // sauf si un choix est arrivé entre-temps
    });
  })();
  whenReady(addFooterLink);

  /* ---------- téléchargements ---------- */

  // Meilleure estimation du système, pour choisir le fichier et attribuer un clic.
  function osHint() {
    var p = ((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || navigator.userAgent || '').toLowerCase();
    if (/iphone|ipad|ipod/.test(p)) return 'ios';
    if (/android/.test(p)) return 'android';
    if (/mac/.test(p)) return 'mac';
    if (/win/.test(p)) return 'windows';
    if (/linux|x11|cros/.test(p)) return 'linux';
    return 'unknown';
  }

  // Mac Apple Silicon ou Intel ? Chromium le dit via les client hints ; Safari non,
  // mais son rendu WebGL nomme la puce graphique (« Apple GPU » contre Intel/AMD).
  // Par défaut Apple Silicon : tous les Mac vendus depuis fin 2020.
  function macArch(done) {
    function viaGpu() {
      try {
        var gl = document.createElement('canvas').getContext('webgl');
        var dbg = gl && gl.getExtension('WEBGL_debug_renderer_info');
        var gpu = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : '';
        var lose = gl && gl.getExtension('WEBGL_lose_context');
        if (lose) lose.loseContext();
        return /intel|amd|radeon|nvidia/i.test(gpu) ? 'x64' : 'arm64';
      } catch (_) { return 'arm64'; }
    }
    var uad = navigator.userAgentData;
    if (uad && uad.getHighEntropyValues) {
      uad.getHighEntropyValues(['architecture']).then(function (v) {
        done(v && v.architecture === 'x86' ? 'x64' : v && v.architecture === 'arm' ? 'arm64' : viaGpu());
      }, function () { done(viaGpu()); });
    } else done(viaGpu());
  }

  // Liens directs vers le fichier de la dernière version (un clic, pas de page
  // GitHub à fouiller). Les href statiques restent la page des versions si l'API
  // est injoignable ou limitée : jamais de cul-de-sac.
  // data-dl : windows | mac | linux | auto (système du visiteur) ; data-dl-file
  // force un fichier précis (mac-x64, linux-appimage...).
  var RELEASE_API = 'https://api.github.com/repos/MrFrosas/flitdrop/releases/latest';
  var FILE_RE = {
    windows: /^Flitdrop-Setup-[\d.]+\.exe$/,
    'mac-arm64': /-arm64\.dmg$/,
    'mac-x64': /-x64\.dmg$/,
    'linux-deb': /\.deb$/,
    'linux-appimage': /\.AppImage$/
  };
  function releaseAssets(cb) {
    try {
      var c = JSON.parse(sessionStorage.getItem('fd_rel') || 'null');
      if (c && Date.now() - c.t < 3600e3 && c.a && c.a.length) return cb(c.a);
    } catch (_) {}
    if (!window.fetch) return;
    fetch(RELEASE_API, { headers: { Accept: 'application/vnd.github+json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j || !j.assets) return;
        var a = j.assets.map(function (x) { return { n: x.name, u: x.browser_download_url }; });
        try { sessionStorage.setItem('fd_rel', JSON.stringify({ t: Date.now(), a: a })); } catch (_) {}
        cb(a);
      })
      .catch(function () {});
  }
  function linkDownloads() {
    if (!document.querySelector('[data-dl]')) return;
    macArch(function (arch) {
      releaseAssets(function (assets) {
        function url(kind) {
          var re = FILE_RE[kind];
          for (var i = 0; i < assets.length; i++) if (re && re.test(assets[i].n)) return assets[i].u;
          return null;
        }
        document.querySelectorAll('[data-dl]').forEach(function (a) {
          var k = a.getAttribute('data-dl-file') || a.getAttribute('data-dl');
          if (k === 'auto') k = osHint();
          if (k === 'mac') k = 'mac-' + arch;
          if (k === 'linux') k = 'linux-deb';
          var u = url(k);
          if (u) { a.setAttribute('href', u); a.removeAttribute('target'); }
        });
      });
    });
  }
  // rappelé par app.js après avoir adapté les boutons de l'accueil au système
  window.fdLinkDownloads = linkDownloads;
  whenReady(linkDownloads);

  // Emplacement d'un lien, pour les événements et la campagne Microsoft Store.
  function placement(a) {
    if (!a.closest) return 'page';
    return a.closest('#download') ? 'download_section' : (a.closest('header,.nav') ? 'nav' : (a.closest('.hero') ? 'hero' : 'page'));
  }
  // Liens Microsoft Store : ?cid=site_<emplacement>, pour que l'Espace partenaires
  // attribue les installations venues du site (paramètres existants conservés).
  var STORE_RE = /^https:\/\/apps\.microsoft\.com\//;
  var CID = { download_section: 'site_download', nav: 'site_nav', hero: 'site_hero', page: 'site_page' };
  function tagStore(a) {
    var href = a.getAttribute('href') || '';
    if (!STORE_RE.test(href)) return;
    try {
      var u = new URL(href);
      if (u.searchParams.has('cid')) return;
      u.searchParams.set('cid', CID[placement(a)]);
      a.setAttribute('href', u.toString());
    } catch (_) {}
  }
  whenReady(function () { document.querySelectorAll('a[href^="https://apps.microsoft.com/"]').forEach(tagStore); });

  // Clics réels sur un lien de téléchargement (indicateur d'installation).
  // Écouteur délégué en phase de capture : couvre aussi les boutons ajoutés après coup.
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest && e.target.closest('a[href], [data-dl]');
    if (!a) return;
    var href = (a.getAttribute && a.getAttribute('href')) || '';
    var isStore = STORE_RE.test(href);
    var isDownload = isStore || /\/releases(\/|$|\?)/.test(href) || (a.hasAttribute && a.hasAttribute('data-dl'));
    if (!isDownload) return;
    var os = (a.getAttribute && a.getAttribute('data-dl')) || (isStore ? 'windows' : osHint());
    if (os === 'auto') os = osHint();
    var place = placement(a);
    var type = isStore ? 'store' : (/\/releases\/download\//.test(href) ? 'direct' : 'release_page');
    var props = { os: os, placement: place, download_type: type };
    phCapture('download_click', props);
    try { if (gaLoaded && state === 'granted') window.gtag('event', 'download_click', props); } catch (_) {}
    if (isStore) {
      tagStore(a); // lien ajouté après le chargement
      phCapture('store_click', { placement: place, cid: CID[place] });
    }
  }, true);
})();
