/* Téléchargements du site, sur toutes les pages : liens directs vers le bon
   fichier de la dernière version, et suivi des clics vers PostHog (chargé dans
   le <head>, sans cookie : persistence 'memory').
   Google Analytics 4 a été RETIRÉ le 23/09/2026 : sans bannière de
   consentement, le Consent Mode « refusé par défaut » envoyait chaque visite
   avec gcs=G100, que GA4 exclut de ses rapports (20 visiteurs affichés la
   semaine du lancement, puis 0). Une bannière casserait la promesse « aucun
   cookie ». Sources de vérité : PostHog (visites, clics), Cloudflare Web
   Analytics (visiteurs), Google Search Console (recherche). */
(function () {
  'use strict';

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
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', linkDownloads);
  else linkDownloads();

  // Clics réels sur un lien de téléchargement (indicateur d'installation).
  // Écouteur délégué en phase de capture : couvre aussi les boutons ajoutés après coup.
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest && e.target.closest('a[href], [data-dl]');
    if (!a) return;
    var href = (a.getAttribute && a.getAttribute('href')) || '';
    var isStore = /apps\.microsoft\.com\//.test(href);
    var isDownload = isStore || /\/releases(\/|$|\?)/.test(href) || (a.hasAttribute && a.hasAttribute('data-dl'));
    if (!isDownload) return;
    var os = (a.getAttribute && a.getAttribute('data-dl')) || (isStore ? 'windows' : osHint());
    if (os === 'auto') os = osHint();
    var place = a.closest && (a.closest('#download') ? 'download_section' : (a.closest('header,.nav') ? 'nav' : (a.closest('.hero') ? 'hero' : 'page')));
    var type = isStore ? 'store' : (/\/releases\/download\//.test(href) ? 'direct' : 'release_page');
    try { if (window.posthog) window.posthog.capture('download_click', { os: os, placement: place || 'page', download_type: type }); } catch (_) {}
  }, true);
})();
