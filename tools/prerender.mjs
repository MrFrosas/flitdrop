/* Prerender localized static pages.
 *
 * Two kinds of source pages:
 *  - the HOME page (index.html): fully [data-i18n] driven, so it is localized
 *    straight from the shared dictionary (site/js/i18n-data.js).
 *  - the SEO ARTICLE pages: hand-written English bodies, localized from a
 *    per-page string map in tools/i18n/<lang>/<slug>.json (produced by the
 *    translation workflow) applied via tools/i18n-pages.mjs, plus their
 *    [data-i18n] nav/footer localized from the dictionary.
 *
 * For every page it also injects reciprocal hreflang (en / <langs> / x-default)
 * into the English source, sets canonical + OG per language, rewrites internal
 * links to keep users inside their language, and writes site/<lang>/<slug>.html.
 *
 * Run after editing content or translations:  node tools/prerender.mjs
 * Commit the generated /<lang>/ files (Cloudflare Pages serves site/ raw).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { parse } from 'node-html-parser';
import { applyToRoot } from './i18n-pages.mjs';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SITE = resolve(ROOT, 'site');
const TR = resolve(ROOT, 'tools', 'i18n');
const ORIGIN = 'https://flitdrop.com';
const DICT = require(resolve(SITE, 'js', 'i18n-data.js'));

const LANGS = ['fr'];
const OG_LOCALE = { en: 'en_US', fr: 'fr_FR', de: 'de_DE', es: 'es_ES' };

// slug '' = home. Article pages carry a translation map; home does not.
const PAGES = [
  { slug: '', src: 'index.html', mapped: false },
  { slug: 'airdrop-windows', src: 'airdrop-windows.html', mapped: true },
  { slug: 'airdrop-linux', src: 'airdrop-linux.html', mapped: true },
  { slug: 'airdrop-iphone-android', src: 'airdrop-iphone-android.html', mapped: true },
  { slug: 'send-files-iphone-to-pc', src: 'send-files-iphone-to-pc.html', mapped: true },
  { slug: 'alternative-airdrop', src: 'alternative-airdrop.html', mapped: true },
  { slug: 'snapdrop-alternative', src: 'snapdrop-alternative.html', mapped: true },
  { slug: 'localsend-alternative', src: 'localsend-alternative.html', mapped: true },
  { slug: 'best-airdrop-alternatives', src: 'best-airdrop-alternatives.html', mapped: true },
  { slug: 'transfer-photos-iphone-to-pc-without-losing-quality', src: 'transfer-photos-iphone-to-pc-without-losing-quality.html', mapped: true },
  { slug: 'send-files-android-to-mac', src: 'send-files-android-to-mac.html', mapped: true },
  { slug: 'copy-paste-phone-to-pc', src: 'copy-paste-phone-to-pc.html', mapped: true },
  { slug: 'xender-alternative', src: 'xender-alternative.html', mapped: true },
  { slug: 'send-anywhere-alternative', src: 'send-anywhere-alternative.html', mapped: true },
  { slug: 'send-files-without-app', src: 'send-files-without-app.html', mapped: true },
  { slug: 'pairdrop-alternative', src: 'pairdrop-alternative.html', mapped: true },
];
const LOCALIZED_SLUGS = new Set(PAGES.map((p) => p.slug)); // for internal link rewriting

const enUrl = (slug) => ORIGIN + '/' + slug;               // home slug '' -> https://flitdrop.com/
const langUrl = (lang, slug) => ORIGIN + '/' + lang + '/' + (slug ? slug : '');
const outPath = (lang, slug) => resolve(SITE, lang, slug ? slug + '.html' : 'index.html');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function t(lang, key) {
  const d = DICT[lang] || {};
  return key in d ? d[key] : (DICT.en[key] != null ? DICT.en[key] : key);
}

function hreflangBlock(slug) {
  const rows = [`<link rel="alternate" hreflang="en" href="${enUrl(slug)}">`];
  for (const l of LANGS) rows.push(`<link rel="alternate" hreflang="${l}" href="${langUrl(l, slug)}">`);
  rows.push(`<link rel="alternate" hreflang="x-default" href="${enUrl(slug)}">`);
  return rows.join('\n  ');
}
function setHreflang(root, slug) {
  root.querySelectorAll('link[rel="alternate"][hreflang]').forEach((el) => el.remove());
  const canonical = root.querySelector('link[rel="canonical"]');
  const block = hreflangBlock(slug);
  if (canonical) canonical.insertAdjacentHTML('afterend', '\n  ' + block);
  else root.querySelector('head')?.insertAdjacentHTML('beforeend', '\n  ' + block);
}
function setMeta(root, sel, attr, value) { const el = root.querySelector(sel); if (el) el.setAttribute(attr, value); }

function localizeDataI18n(root, lang) {
  root.querySelectorAll('[data-i18n]').forEach((el) => el.set_content(esc(t(lang, el.getAttribute('data-i18n')))));
  root.querySelectorAll('[data-i18n-html]').forEach((el) => el.set_content(t(lang, el.getAttribute('data-i18n-html'))));
  root.querySelectorAll('[data-i18n-aria]').forEach((el) => el.setAttribute('aria-label', t(lang, el.getAttribute('data-i18n-aria'))));
}

// Home JSON-LD: rebuild FAQ + description from the dictionary in the target language.
function localizeJsonLdFromDict(root, lang) {
  root.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
    let data; try { data = JSON.parse(s.text); } catch { return; }
    const graph = Array.isArray(data['@graph']) ? data['@graph'] : [data];
    for (const node of graph) {
      if (node['@type'] === 'FAQPage' && Array.isArray(node.mainEntity)) {
        const items = [];
        for (let i = 1; ('faq.q' + i) in DICT.en; i++) items.push({ '@type': 'Question', name: t(lang, 'faq.q' + i), acceptedAnswer: { '@type': 'Answer', text: t(lang, 'faq.a' + i) } });
        if (items.length) node.mainEntity = items;
      }
      if (node['@type'] === 'SoftwareApplication') node.description = t(lang, 'meta.desc');
      if (node['@type'] === 'WebSite') node.inLanguage = [lang];
    }
    s.set_content('\n  ' + JSON.stringify(data, null, 2).replace(/\n/g, '\n  ') + '\n  ');
  });
}

// Rewrite root-relative links to localized pages so users stay in-language.
function rewriteInternalLinks(root, lang) {
  root.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href');
    if (href === '/') { a.setAttribute('href', '/' + lang + '/'); return; }
    const m = /^\/([a-z0-9-]+)$/.exec(href);
    if (m && LOCALIZED_SLUGS.has(m[1])) a.setAttribute('href', '/' + lang + '/' + m[1]);
  });
}

// collapse runs of blank lines (hreflang re-injection can leave whitespace behind) + keep the doctype
function finalize(html) {
  html = html.replace(/(?:[ \t]*\n){3,}/g, '\n\n');
  return /^\s*<!doctype/i.test(html) ? html : '<!doctype html>\n' + html;
}

let generated = 0;
for (const page of PAGES) {
  const srcHtml = readFileSync(resolve(SITE, page.src), 'utf8');

  // inject hreflang into the English source (idempotent)
  {
    const root = parse(srcHtml, { comment: true });
    setHreflang(root, page.slug);
    writeFileSync(resolve(SITE, page.src), finalize(root.toString()));
  }

  for (const lang of LANGS) {
    const root = parse(srcHtml, { comment: true });
    root.querySelector('html')?.setAttribute('lang', lang);

    // head: canonical + hreflang + OG url/locale
    setMeta(root, 'link[rel="canonical"]', 'href', langUrl(lang, page.slug));
    setHreflang(root, page.slug);
    setMeta(root, 'meta[property="og:url"]', 'content', langUrl(lang, page.slug));
    setMeta(root, 'meta[property="og:locale"]', 'content', OG_LOCALE[lang] || lang);
    setMeta(root, 'meta[property="og:locale:alternate"]', 'content', OG_LOCALE.en);

    if (page.mapped) {
      const mapFile = resolve(TR, lang, page.slug + '.json');
      if (!existsSync(mapFile)) { console.warn('SKIP', lang, page.slug, '(no translation map at', mapFile + ')'); continue; }
      const translations = JSON.parse(readFileSync(mapFile, 'utf8'));
      applyToRoot(root, translations);   // title, meta, JSON-LD (and body fallback) from the map
      // Body copy is already bilingual via hand-written data-en/data-<lang> attributes
      // and swapped client-side. Bake that same translation into the text so crawlers
      // (no-JS) see exactly what the runtime shows. Falls back to the map when a page
      // has no data-<lang> for this language (e.g. future languages).
      root.querySelectorAll('[data-en]').forEach((e) => {
        const v = e.getAttribute('data-' + lang);
        if (v != null) e.set_content(esc(v));
      });
      localizeDataI18n(root, lang);       // nav/footer etc. from the dictionary
      rewriteInternalLinks(root, lang);
    } else {
      // home: dictionary-driven
      const titleEl = root.querySelector('title'); if (titleEl) titleEl.set_content(esc(t(lang, 'meta.title')));
      setMeta(root, 'meta[name="description"]', 'content', t(lang, 'meta.desc'));
      setMeta(root, 'meta[property="og:title"]', 'content', t(lang, 'meta.title'));
      setMeta(root, 'meta[property="og:description"]', 'content', t(lang, 'meta.desc'));
      setMeta(root, 'meta[name="twitter:title"]', 'content', t(lang, 'meta.title'));
      setMeta(root, 'meta[name="twitter:description"]', 'content', t(lang, 'meta.desc'));
      localizeDataI18n(root, lang);
      localizeJsonLdFromDict(root, lang);
      rewriteInternalLinks(root, lang);
    }

    const out = outPath(lang, page.slug);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, finalize(root.toString()));
    generated++;
    console.log('generated', out.replace(SITE + '/', ''), '[' + lang + ']');
  }
}
console.log('done:', generated, 'localized page(s)');
