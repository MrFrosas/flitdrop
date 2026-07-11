/* Google Analytics 4 (gtag.js). Loaded on every page from one place so the
   measurement id lives in a single file. PostHog stays as the product analytics;
   GA4 is here for Search Console linkage and audience reporting.
   Note: GA4 sets first party cookies (_ga). For an EU audience a cookie consent
   choice is normally required. Swap the config below for Consent Mode v2 if a
   banner is added. */
(function () {
  'use strict';
  var ID = 'G-6D1N284CCF';

  window.dataLayer = window.dataLayer || [];
  function gtag() { dataLayer.push(arguments); }
  window.gtag = gtag;

  var s = document.createElement('script');
  s.async = true;
  s.src = 'https://www.googletagmanager.com/gtag/js?id=' + ID;
  (document.head || document.documentElement).appendChild(s);

  gtag('js', new Date());
  gtag('config', ID, { anonymize_ip: true });

  // Best OS guess for attributing a download.
  function osHint() {
    var p = ((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || navigator.userAgent || '').toLowerCase();
    if (/mac/.test(p)) return 'mac';
    if (/win/.test(p)) return 'windows';
    if (/linux/.test(p) && !/android/.test(p)) return 'linux';
    if (/android/.test(p)) return 'android';
    if (/iphone|ipad|ipod/.test(p)) return 'ios';
    return 'unknown';
  }

  // Track real download-link clicks on every page (install proxy). A delegated,
  // capture-phase listener also covers buttons added later (e.g. the mobile handoff).
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest && e.target.closest('a[href], [data-dl]');
    if (!a) return;
    var href = (a.getAttribute && a.getAttribute('href')) || '';
    var isDownload = /\/releases(\/|$|\?)/.test(href) || (a.hasAttribute && a.hasAttribute('data-dl'));
    if (!isDownload) return;
    var os = (a.getAttribute && a.getAttribute('data-dl')) || osHint();
    var host = a.closest && (a.closest('#download') ? 'download_section' : (a.closest('header,.nav') ? 'nav' : (a.closest('.hero') ? 'hero' : 'page')));
    try { gtag('event', 'download_click', { os: os, placement: host || 'page', download_type: 'direct', link_url: href }); } catch (_) {}
    try { if (window.posthog) window.posthog.capture('download_click', { os: os, placement: host || 'page' }); } catch (_) {}
  }, true);
})();
