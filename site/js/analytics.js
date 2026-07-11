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
})();
