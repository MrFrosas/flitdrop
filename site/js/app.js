/* Flitdrop landing orchestration: Lenis smooth scroll + GSAP ScrollTrigger drive the
   pinned 3D film, plus section reveals, nav state, anchors, OS aware download and the
   reduced-motion / no-WebGL fallbacks. Vendored gsap + ScrollTrigger + lenis (globals). */
(function () {
  'use strict';

  var reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  var hasGsap = !!(window.gsap && window.ScrollTrigger);

  function whenScene() {
    return new Promise(function (res) {
      var n = 0;
      (function poll() {
        if (window.flitSceneReady) { window.flitSceneReady.then(res); return; }
        if (n++ > 250) { res(null); return; }
        setTimeout(poll, 30);
      })();
    });
  }

  function t(k) { return window.FDI18N ? window.FDI18N.t(k) : k; }

  function boot(flit) {
    var noFilm = reduce || !flit || !flit.hasWebGL || !hasGsap;
    if (noFilm) document.documentElement.classList.add('no-film');

    var lenis = null;
    if (hasGsap) {
      window.gsap.registerPlugin(window.ScrollTrigger);
      if (!reduce && window.Lenis) {
        lenis = new window.Lenis({ duration: 1.1, lerp: 0.09, smoothWheel: true, wheelMultiplier: 1.0 });
        lenis.on('scroll', window.ScrollTrigger.update);
        (function lraf(time) { lenis.raf(time); requestAnimationFrame(lraf); })(performance.now ? performance.now() : 0);
        window.gsap.ticker.lagSmoothing(0);
      }
      if (!reduce) document.documentElement.classList.add('anim');
    }

    if (!noFilm) setupFilm(flit);
    setupReveals();
    setupNav(lenis);
    setupAnchors(lenis);
    setupOS();
    setupCompareA11y();
    setupCompareTabs();
    setupFAQ();
    setupContact();
    setupTilt();
    setupCountUp();

    if (hasGsap) window.addEventListener('load', function () { window.ScrollTrigger.refresh(); });
  }

  /* ----- film pin + captions ----- */
  var CAPS = [
    [0.22, 'film.a1'], [0.44, 'film.a2'], [0.55, 'film.a3'], [0.63, 'film.a4'],
    [0.72, 'film.b1'], [0.80, 'film.bproc'], [0.93, 'film.b2'], [1.01, 'film.b4'],
  ];
  function capFor(p) { for (var i = 0; i < CAPS.length; i++) { if (p < CAPS[i][0]) return CAPS[i][1]; } return 'film.b4'; }

  function setupFilm(flit) {
    var isMobile = window.innerWidth <= 768;
    var capEl = document.getElementById('filmCaption');
    var barEl = document.getElementById('filmProgressBar');
    var curKey = '';

    function setCaption(key) {
      if (key === curKey || !capEl) return; curKey = key;
      capEl.classList.add('swap');
      setTimeout(function () {
        capEl.setAttribute('data-i18n', key);
        capEl.textContent = t(key);
        capEl.classList.remove('swap');
      }, 180);
    }

    var proxy = { p: 0 };
    window.gsap.to(proxy, {
      p: 1, ease: 'none',
      onUpdate: function () {
        flit.setProgress(proxy.p);
        setCaption(capFor(proxy.p));
        if (barEl) barEl.style.width = (proxy.p * 100).toFixed(1) + '%';
      },
      scrollTrigger: {
        trigger: '#film', start: 'top top', end: isMobile ? '+=240%' : '+=460%',
        pin: '#film-stage', anticipatePin: 0, scrub: 1, invalidateOnRefresh: true, pinSpacing: true,
      },
    });

    // keep caption correct after a language switch
    window.addEventListener('langchange', function () { if (capEl && curKey) { capEl.setAttribute('data-i18n', curKey); capEl.textContent = t(curKey); } });
  }

  /* ----- reveals ----- */
  function setupReveals() {
    if (reduce || !hasGsap) return; // reveals stay visible without the anim class
    var hero = document.querySelectorAll('.hero .reveal');
    hero.forEach(function (el, i) { setTimeout(function () { el.classList.add('in'); }, 130 + i * 110); });

    window.ScrollTrigger.batch('.section .reveal, .film .reveal, .band .reveal', {
      start: 'top 88%',
      onEnter: function (batch) { batch.forEach(function (el, i) { setTimeout(function () { el.classList.add('in'); }, i * 80); }); },
    });
  }

  /* ----- nav scrolled state ----- */
  function setupNav(lenis) {
    var nav = document.getElementById('nav');
    if (!nav) return;
    function state() { nav.classList.toggle('scrolled', (window.scrollY || window.pageYOffset || 0) > 24); }
    if (lenis) lenis.on('scroll', state);
    window.addEventListener('scroll', state, { passive: true });
    state();
  }

  /* ----- smooth anchor scroll ----- */
  function setupAnchors(lenis) {
    document.querySelectorAll('a[href^="#"]').forEach(function (a) {
      a.addEventListener('click', function (e) {
        var id = a.getAttribute('href');
        if (!id || id.length < 2) return;
        var el = document.querySelector(id);
        if (!el) return;
        e.preventDefault();
        if (lenis) lenis.scrollTo(el, { offset: -64 });
        else el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth' });
      });
    });
  }

  /* ----- OS aware download labels ----- */
  function osOf() {
    var p = ((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || navigator.userAgent || '').toLowerCase();
    if (/android/.test(p)) return null;
    if (/iphone|ipad|ipod/.test(p)) return 'mac';
    if (/mac/.test(p)) return 'mac';
    if (/win/.test(p)) return 'windows';
    if (/linux/.test(p)) return 'linux';
    return null;
  }
  function setupOS() {
    var os = osOf();
    if (!os) return;
    var map = { mac: 'download.mac', windows: 'download.windows', linux: 'download.linux' };
    var primary = document.querySelector('.dl-buttons .btn-primary span');
    var secondary = document.querySelector('.dl-buttons .btn-ghost span');
    if (primary) { primary.setAttribute('data-i18n', map[os]); primary.textContent = t(map[os]); }
    if (secondary) { var sk = os === 'mac' ? 'download.windows' : 'download.mac'; secondary.setAttribute('data-i18n', sk); secondary.textContent = t(sk); }
    var hero = document.querySelector('#ctaDownload span');
    if (hero) { hero.setAttribute('data-i18n', map[os]); hero.textContent = t(map[os]); }
  }

  /* ----- give the compare table marks a screen-reader value ----- */
  function setupCompareA11y() {
    document.querySelectorAll('.compare .mk').forEach(function (m) {
      if (m.querySelector('.vh')) return;
      var key = m.classList.contains('yes') ? 'compare.val.yes' : 'compare.val.no';
      var s = document.createElement('span');
      s.className = 'vh';
      s.setAttribute('data-i18n', key);
      s.textContent = t(key);
      m.appendChild(s);
    });
  }

  /* ----- comparison: pick which rival to show on mobile (2-column view, no h-scroll) ----- */
  function setupCompareTabs() {
    var wrap = document.querySelector('.cmp2');
    if (!wrap) return;
    var tabs = wrap.querySelectorAll('.cmp2-tab');
    tabs.forEach(function (btn) {
      btn.addEventListener('click', function () {
        wrap.setAttribute('data-rival', btn.getAttribute('data-rival'));
        tabs.forEach(function (b) { b.classList.toggle('is-on', b === btn); });
      });
    });
  }

  /* ----- FAQ: smooth accordion (keeps native details for a11y / no-JS) ----- */
  function setupFAQ() {
    document.querySelectorAll('.faq-list details').forEach(function (d) {
      d.setAttribute('open', ''); // keep content rendered; we animate open/close via a class
      var sum = d.querySelector('summary');
      if (!sum) return;
      sum.addEventListener('click', function (e) {
        e.preventDefault();
        var willOpen = !d.classList.contains('expanded');
        d.parentNode.querySelectorAll('details.expanded').forEach(function (o) { o.classList.remove('expanded'); });
        if (willOpen) d.classList.add('expanded');
      });
    });
  }

  /* ----- contact form: no backend needed, opens the mail client with the message ready ----- */
  function setupContact() {
    var f = document.getElementById('contactForm');
    if (!f) return;
    f.addEventListener('submit', function (e) {
      e.preventDefault();
      if (!f.checkValidity()) { f.reportValidity(); return; }
      var el = f.elements;
      var nm = (el['name'].value || '').trim();
      var em = (el['email'].value || '').trim();
      var msg = (el['message'].value || '').trim();
      var subject = encodeURIComponent('Flitdrop — ' + nm);
      var body = encodeURIComponent(msg + '\n\n— ' + nm + ' (' + em + ')');
      window.location.href = 'mailto:contact@flitdrop.com?subject=' + subject + '&body=' + body;
    });
  }

  /* ----- content cards: subtle pointer tilt (desktop only) ----- */
  function setupTilt() {
    if (reduce || matchMedia('(pointer: coarse)').matches) return;
    document.querySelectorAll('.content-card').forEach(function (card) {
      card.addEventListener('pointermove', function (e) {
        var r = card.getBoundingClientRect();
        var px = (e.clientX - r.left) / r.width - 0.5;
        var py = (e.clientY - r.top) / r.height - 0.5;
        card.style.transform = 'perspective(640px) rotateY(' + (px * 6).toFixed(2) + 'deg) rotateX(' + (-py * 6).toFixed(2) + 'deg) translateY(-4px)';
      });
      card.addEventListener('pointerleave', function () { card.style.transform = ''; });
    });
  }

  /* ----- count up numbers once they scroll in ----- */
  function setupCountUp() {
    var els = document.querySelectorAll('[data-count]');
    if (!els.length || !('IntersectionObserver' in window)) return;
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        var el = en.target, target = parseInt(el.getAttribute('data-count'), 10) || 0;
        io.unobserve(el);
        if (reduce) { el.textContent = target; return; }
        var start = null, dur = 850;
        function step(ts) {
          if (!start) start = ts;
          var k = Math.min(1, (ts - start) / dur);
          el.textContent = Math.round(target * (1 - Math.pow(1 - k, 3)));
          if (k < 1) requestAnimationFrame(step); else el.textContent = target;
        }
        requestAnimationFrame(step);
      });
    }, { threshold: 0.6 });
    els.forEach(function (e) { io.observe(e); });
  }

  /* ----- go ----- */
  function start() { whenScene().then(boot); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
