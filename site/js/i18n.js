/* Flitdrop landing i18n. Translations live in i18n-data.js (the single source of
   truth), which must load before this file. This module wires the language toggle,
   applies the strings, and is aware of the prerendered per-language URLs (e.g. /fr/):
   the toggle navigates to the real localized page when one exists, and otherwise
   swaps the text in place. No em dash characters anywhere. */
(function () {
  'use strict';

  var DICT = (typeof window !== 'undefined' && window.FD_I18N_DATA) || { en: {}, fr: {} };
  var EN = DICT.en || {};
  // display + cycle order; add new languages here (must have a /<lang>/ prerender + dict)
  var LANGS = ['en', 'fr', 'de'];
  var NAMES = { en: 'EN', fr: 'FR', de: 'DE', es: 'ES' };
  var SUPPORTED = {}; LANGS.forEach(function (l) { SUPPORTED[l] = 1; });
  var LS = 'flitdrop_lang';

  // which prerendered language page you are literally on, if any
  function langFromPath() {
    var m = (location.pathname || '/').match(/^\/(fr|de|es)(\/|$)/);
    return (m && SUPPORTED[m[1]]) ? m[1] : null;
  }

  function detect() {
    // 1) the prerendered localized page you are on wins
    var fromPath = langFromPath();
    if (fromPath) return fromPath;
    // 2) explicit ?lang= (shareable links, client-swap pages)
    try { var q = new URLSearchParams(location.search).get('lang'); if (SUPPORTED[q]) return q; } catch (e) {}
    // 3) saved choice
    var saved = null;
    try { saved = localStorage.getItem(LS); } catch (e) {}
    if (SUPPORTED[saved]) return saved;
    // 4) browser language
    var nav = (navigator.language || 'en').toLowerCase().slice(0, 2);
    return SUPPORTED[nav] ? nav : 'en';
  }

  var lang = detect();

  function t(key) {
    var d = DICT[lang] || EN;
    return (key in d) ? d[key] : (EN[key] != null ? EN[key] : key);
  }

  function apply(root) {
    root = root || document;
    root.querySelectorAll('[data-i18n]').forEach(function (el) {
      el.textContent = t(el.getAttribute('data-i18n'));
    });
    root.querySelectorAll('[data-i18n-html]').forEach(function (el) {
      el.innerHTML = t(el.getAttribute('data-i18n-html'));
    });
    root.querySelectorAll('[data-i18n-aria]').forEach(function (el) {
      el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria')));
    });
    // reflect language on the document + toggle buttons
    document.documentElement.setAttribute('lang', lang);
    // only pages that opt in localize their <title>/description; sub-pages keep their own
    if (document.documentElement.hasAttribute('data-i18n-meta')) {
      document.title = t('meta.title');
      var md = document.querySelector('meta[name="description"]'); if (md) md.setAttribute('content', t('meta.desc'));
    }
    var nextLang = LANGS[(LANGS.indexOf(lang) + 1) % LANGS.length];
    document.querySelectorAll('[data-lang-toggle], #langToggle').forEach(function (b) {
      b.textContent = NAMES[nextLang] || nextLang.toUpperCase();
      b.setAttribute('aria-label', 'Change language, next: ' + (NAMES[nextLang] || nextLang));
    });
  }

  // slugs that have a prerendered counterpart under /<lang>/ ('' = home)
  var LOCALIZED = ['', 'airdrop-windows', 'airdrop-linux', 'airdrop-iphone-android', 'send-files-iphone-to-pc', 'alternative-airdrop', 'snapdrop-alternative', 'localsend-alternative', 'best-airdrop-alternatives', 'transfer-photos-iphone-to-pc-without-losing-quality', 'send-files-android-to-mac', 'copy-paste-phone-to-pc', 'xender-alternative', 'send-anywhere-alternative', 'send-files-without-app', 'pairdrop-alternative', 'quick-share-to-iphone-not-working', 'send-files-linux-to-iphone', 'flitdrop-vs-airdrop', 'flitdrop-vs-localsend', 'flitdrop-vs-snapdrop', 'flitdrop-vs-nearby-share'];

  // URL of the prerendered counterpart for `next` language, or null if none exists
  function staticAltUrl(next) {
    var p = location.pathname || '/';
    var m = p.match(/^\/(fr|de|es)(\/|$)/);
    var rest = m ? p.slice(('/' + m[1]).length) : p;
    rest = rest.replace(/\/index\.html?$/, '/').replace(/\.html$/, '');
    var bare = (rest === '/' || rest === '') ? '' : rest.replace(/^\//, '');
    if (LOCALIZED.indexOf(bare) === -1) return null; // page has no localized variants
    return next === 'en' ? '/' + bare : '/' + next + '/' + bare;
  }

  function set(next) {
    if (!SUPPORTED[next]) return;
    try { localStorage.setItem(LS, next); } catch (e) {}
    var alt = staticAltUrl(next);
    if (alt) { location.href = alt; return; } // navigate to the real localized page
    // otherwise swap in place (pages that do not have a prerendered counterpart yet)
    lang = next;
    try { var u = new URL(location.href); u.searchParams.set('lang', lang); history.replaceState(null, '', u); } catch (e) {}
    apply(document);
    window.dispatchEvent(new CustomEvent('fd-lang', { detail: { lang: lang } }));
    window.dispatchEvent(new CustomEvent('langchange', { detail: { lang: lang } }));
  }

  function toggle() { var i = LANGS.indexOf(lang); set(LANGS[(i + 1) % LANGS.length]); }

  // public API (keeps window.FDI18N.lang readable and stable across pages)
  window.FDI18N = {
    t: t,
    apply: apply,
    toggle: toggle,
    set: set,
    get lang() { return lang; },
  };

  function wire() {
    document.querySelectorAll('[data-lang-toggle], #langToggle').forEach(function (b) {
      if (b.__fdWired) return; b.__fdWired = true;
      b.addEventListener('click', function (e) { e.preventDefault(); toggle(); });
    });
    apply(document);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();
})();
