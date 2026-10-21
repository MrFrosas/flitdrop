/* Flitdrop, page d'accueil. Léger : apparitions au défilement, barre du haut,
   boutons de téléchargement adaptés au système, comparatif, FAQ et contact.
   Pas de bibliothèque, défilement natif du navigateur. */
(function () {
  'use strict';

  var reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  function t(k) { return window.FDI18N ? window.FDI18N.t(k) : k; }

  /* captures de l'app dans la langue de la page (prérendu : déjà faites) */
  function localizeShots() {
    var lang = (window.FDI18N && window.FDI18N.lang) || 'en';
    if (['en', 'fr', 'de'].indexOf(lang) === -1) return;
    document.querySelectorAll('img[src^="/assets/app/"]').forEach(function (img) {
      var src = img.getAttribute('src').replace(/^\/assets\/app\/[a-z]{2}\//, '/assets/app/' + lang + '/');
      if (src !== img.getAttribute('src')) img.setAttribute('src', src);
    });
  }

  /* apparitions : un IntersectionObserver, rien à chaque image */
  function setupReveals() {
    if (reduce || !('IntersectionObserver' in window)) return;
    var els = document.querySelectorAll('.reveal');
    var vh = window.innerHeight;
    document.documentElement.classList.add('anim');
    var io = new IntersectionObserver(function (entries) {
      var batch = 0;
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        en.target.style.setProperty('--rd', (batch++ * 70) + 'ms');
        en.target.classList.add('in');
        io.unobserve(en.target);
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.12 });
    els.forEach(function (el) {
      // déjà visible au chargement (ancre, retour arrière) : affiché tout de suite
      if (el.getBoundingClientRect().top < vh * 0.9) el.classList.add('in');
      else io.observe(el);
    });
  }


  /* animation du haut : départ sur la ligne IMG_4158 du téléphone, arrivée sur la même
     ligne dans « En direct » du Mac. Positions relevées dans les captures (en points
     de l'écran capturé), ramenées ici à la taille affichée. */
  var GEO = {
    phone: { vw: 393, vh: 798, row: { en: [18, 425.5, 357, 106], fr: [18, 441.5, 357, 106], de: [18, 425.5, 357, 106] } },
    mac: { vw: 1100, vh: 700, card: [819, 53, 263, 102] }
  };
  function offsetIn(el, root) {
    var x = 0, y = 0;
    for (var e = el; e && e !== root; e = e.offsetParent) { x += e.offsetLeft; y += e.offsetTop; }
    return { x: x, y: y, w: el.offsetWidth, h: el.offsetHeight };
  }
  function setupFlight() {
    var stage = document.querySelector('.stage');
    var root = stage && stage.querySelector('.stage-tilt');
    var pimg = root && root.querySelector('.iphone .shot');
    var mimg = root && root.querySelector('.mac .shot');
    var fl = root && root.querySelector('.flight');
    var dep = root && root.querySelector('.ring-depart');
    var land = root && root.querySelector('.ring-land');
    if (!pimg || !mimg || !fl || !dep || !land) return;
    var lang = (window.FDI18N && window.FDI18N.lang) || 'en';
    function place() {
      var P = offsetIn(pimg, root), M = offsetIn(mimg, root);
      if (!P.w || !M.w) return;
      var r = GEO.phone.row[lang] || GEO.phone.row.en, c = GEO.mac.card;
      var px = P.w / GEO.phone.vw, py = px, mx = M.w / GEO.mac.vw, my = M.h / GEO.mac.vh;
      var row = { x: P.x + r[0] * px, y: P.y + r[1] * py, w: r[2] * px, h: r[3] * py };
      var card = { x: M.x + c[0] * mx, y: M.y + c[1] * my, w: c[2] * mx, h: c[3] * my };
      var size = Math.max(30, Math.min(64, root.offsetWidth * 0.05));
      var x0 = row.x + row.w * 0.1 - size / 2, y0 = row.y + row.h * 0.32 - size / 2;
      var x1 = card.x + card.w * 0.5 - size / 2, y1 = card.y + card.h * 0.5 - size / 2;
      var st = fl.style;
      st.setProperty('--fs', size + 'px');
      st.setProperty('--x0', x0 + 'px'); st.setProperty('--y0', y0 + 'px');
      st.setProperty('--x1', x1 + 'px'); st.setProperty('--y1', y1 + 'px');
      st.setProperty('--xm', (x0 + x1) / 2 + 'px'); st.setProperty('--ym', Math.min(y0, y1) - root.offsetWidth * 0.06 + 'px');
      [[dep, row], [land, card]].forEach(function (pair) {
        var s2 = pair[0].style, b = pair[1];
        s2.left = b.x + 'px'; s2.top = b.y + 'px'; s2.width = b.w + 'px'; s2.height = b.h + 'px';
        s2.borderRadius = Math.max(8, b.h * 0.16) + 'px';
      });
      stage.classList.add('is-ready');
    }
    function whenLoaded(img, cb) { if (img.complete && img.naturalWidth) cb(); else img.addEventListener('load', cb, { once: true }); }
    whenLoaded(pimg, function () { whenLoaded(mimg, place); });
    if ('ResizeObserver' in window) new ResizeObserver(place).observe(root);
    else window.addEventListener('resize', place);
  }

  function setupNav() {
    var nav = document.getElementById('nav');
    if (!nav) return;
    var on = false;
    function state() {
      var s = (window.scrollY || 0) > 12;
      if (s !== on) { on = s; nav.classList.toggle('scrolled', s); }
    }
    window.addEventListener('scroll', state, { passive: true });
    state();
  }

  /* ----- boutons de téléchargement selon le système ----- */
  function plat() { return ((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || navigator.userAgent || '').toLowerCase(); }
  function isPhone() { return /iphone|ipad|ipod|android/.test(plat()) || /iphone|ipad|android/i.test(navigator.userAgent || ''); }
  function osOf() {
    var p = plat();
    if (/mac/.test(p)) return 'mac';
    if (/win/.test(p)) return 'windows';
    if (/linux|x11|cros/.test(p)) return 'linux';
    return null;
  }
  var LABEL = { mac: 'download.mac', windows: 'download.windows', linux: 'download.linux' };
  function setupOS() {
    var hero = document.getElementById('ctaDownload');
    if (isPhone()) {
      // sur téléphone, rien à installer ici : le bouton mène aux explications et au lien à copier
      if (hero) { hero.setAttribute('href', '#download'); hero.removeAttribute('data-dl'); }
      var note = document.querySelector('.dl-note');
      if (note) { note.setAttribute('data-i18n', 'download.mobile'); note.textContent = t('download.mobile'); }
      var buttons = document.querySelector('.dl-buttons');
      if (buttons) {
        buttons.innerHTML = '';
        var copy = document.createElement('button');
        copy.type = 'button';
        copy.className = 'btn btn-primary btn-lg';
        copy.setAttribute('data-i18n', 'download.copylink');
        copy.textContent = t('download.copylink');
        copy.addEventListener('click', function () {
          function done() {
            copy.removeAttribute('data-i18n');
            copy.textContent = t('download.copied');
            setTimeout(function () { copy.setAttribute('data-i18n', 'download.copylink'); copy.textContent = t('download.copylink'); }, 2200);
          }
          try {
            if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(location.origin + '/').then(done, done);
            else done();
          } catch (_) { done(); }
          if (window.posthog) { try { window.posthog.capture('mobile_copy_link'); } catch (_) {} }
        });
        buttons.appendChild(copy);
      }
      var more = document.querySelector('.dl-more');
      if (more) more.hidden = true;
      return;
    }
    var os = osOf();
    if (os) {
      var other = os === 'windows' ? 'mac' : 'windows';
      var primary = document.querySelector('.dl-buttons .btn-primary');
      var secondary = document.querySelector('.dl-buttons .btn-ghost');
      [[primary, os], [secondary, other]].forEach(function (pair) {
        var btn = pair[0], o = pair[1];
        if (!btn) return;
        btn.setAttribute('data-dl', o);
        var span = btn.querySelector('span');
        if (span) { span.setAttribute('data-i18n', LABEL[o]); span.textContent = t(LABEL[o]); }
      });
      var hs = hero && hero.querySelector('span');
      if (hs) { hs.setAttribute('data-i18n', LABEL[os]); hs.textContent = t(LABEL[os]); }
      if (hero) hero.setAttribute('data-dl', os);
    }
    if (window.fdLinkDownloads) window.fdLinkDownloads();
  }

  /* ----- comparatif ----- */
  function setupCompare() {
    var wrap = document.querySelector('.cmp2');
    if (!wrap) return;
    var tabs = wrap.querySelectorAll('.cmp2-tab');
    tabs.forEach(function (btn) {
      btn.addEventListener('click', function () {
        wrap.setAttribute('data-rival', btn.getAttribute('data-rival'));
        tabs.forEach(function (b) { b.classList.toggle('is-on', b === btn); });
      });
    });
    wrap.querySelectorAll('.mk.yes, .mk.no').forEach(function (m) {
      if (m.querySelector('.vh')) return;
      var key = m.classList.contains('yes') ? 'compare.val.yes' : 'compare.val.no';
      var s = document.createElement('span');
      s.className = 'vh';
      s.setAttribute('data-i18n', key);
      s.textContent = t(key);
      m.appendChild(s);
    });
  }

  /* ----- FAQ : une question ouverte à la fois, details natifs gardés ----- */
  function setupFAQ() {
    document.querySelectorAll('.faq-list details').forEach(function (d) {
      d.setAttribute('open', '');
      d.classList.add('js-faq');
      var sum = d.querySelector('summary');
      if (!sum) return;
      sum.setAttribute('aria-expanded', 'false');
      sum.addEventListener('click', function (e) {
        e.preventDefault();
        var willOpen = !d.classList.contains('expanded');
        d.parentNode.querySelectorAll('details.expanded').forEach(function (o) {
          o.classList.remove('expanded');
          var s = o.querySelector('summary'); if (s) s.setAttribute('aria-expanded', 'false');
        });
        if (willOpen) { d.classList.add('expanded'); sum.setAttribute('aria-expanded', 'true'); }
      });
    });
  }

  /* ----- formulaire de contact (fonction Cloudflare /api/contact) ----- */
  function setupContact() {
    var f = document.getElementById('contactForm');
    if (!f) return;
    var status = document.getElementById('contactStatus');
    var btn = f.querySelector('button[type="submit"]');
    function tt(key, fallback) { var v = t(key); return v && v !== key ? v : fallback; }
    function say(msg, kind) {
      if (!status) return;
      status.textContent = msg;
      status.hidden = false;
      status.classList.remove('is-ok', 'is-err');
      if (kind) status.classList.add(kind === 'ok' ? 'is-ok' : 'is-err');
    }
    f.addEventListener('submit', function (e) {
      e.preventDefault();
      if (!f.checkValidity()) { f.reportValidity(); return; }
      var el = f.elements;
      var payload = {
        name: (el['name'].value || '').trim(),
        email: (el['email'].value || '').trim(),
        message: (el['message'].value || '').trim(),
        company: (el['company'] && el['company'].value) || ''
      };
      btn.disabled = true;
      say(tt('support.sending', 'Sending…'), null);
      fetch('/api/contact', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
        .then(function (r) { return r.json().catch(function () { return { ok: false }; }); })
        .then(function (data) {
          if (data && data.ok) {
            f.reset();
            say(tt('support.ok', 'Thanks, your message is on its way. We usually reply within a day.'), 'ok');
            if (window.posthog) { try { window.posthog.capture('contact_submitted'); } catch (_) {} }
          } else say(tt('support.err', 'Something went wrong. Please email contact@flitdrop.com directly.'), 'err');
        })
        .catch(function () { say(tt('support.err', 'Something went wrong. Please email contact@flitdrop.com directly.'), 'err'); })
        .finally(function () { btn.disabled = false; });
    });
  }

  function start() {
    localizeShots();
    setupFlight();
    setupReveals();
    setupNav();
    setupOS();
    setupCompare();
    setupFAQ();
    setupContact();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
