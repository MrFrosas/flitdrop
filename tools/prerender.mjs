/* Prerender localized static pages from the i18n dictionaries.
 *
 * The landing page is authored once in English with [data-i18n] hooks. At runtime
 * the browser localizes it, but crawlers (and AI assistants that do not run JS) only
 * see the English HTML. This script bakes each target language into its own static
 * file under /<lang>/ so every language is a real, crawlable, hreflang-linked URL.
 *
 * It also injects reciprocal hreflang tags into the English source pages, so the
 * mapping stays in one place. Run after editing site content or translations:
 *
 *   node tools/prerender.mjs
 *
 * Only pages whose visible content is fully driven by [data-i18n] can be prerendered
 * this way (currently the home page). Localized versions of the hand-written SEO
 * article pages come from translating their bodies, tracked separately.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { parse } from 'node-html-parser';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const SITE = resolve(__dirname, '..', 'site');
const ORIGIN = 'https://flitdrop.com';

const DICT = require(resolve(SITE, 'js', 'i18n-data.js'));

// Pages to localize: source (English) file -> per-language output + absolute URLs.
const PAGES = [
  {
    src: 'index.html',
    urls: { en: ORIGIN + '/', fr: ORIGIN + '/fr/', 'x-default': ORIGIN + '/' },
    out: { fr: 'fr/index.html' },
  },
];

const LANGS = ['fr'];
const OG_LOCALE = { en: 'en_US', fr: 'fr_FR' };

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function t(lang, key) {
  const d = DICT[lang] || {};
  return key in d ? d[key] : (DICT.en[key] != null ? DICT.en[key] : key);
}

// Build reciprocal hreflang <link> markup for a page (all langs + x-default).
function hreflangLinks(urls) {
  const order = ['en', ...LANGS, 'x-default'];
  return order
    .filter((k) => urls[k])
    .map((k) => `<link rel="alternate" hreflang="${k}" href="${urls[k]}">`)
    .join('\n  ');
}

// Remove any existing alternate-hreflang links, then insert fresh ones after canonical.
function setHreflang(root, urls) {
  root.querySelectorAll('link[rel="alternate"][hreflang]').forEach((el) => el.remove());
  const canonical = root.querySelector('link[rel="canonical"]');
  const block = hreflangLinks(urls);
  if (canonical) canonical.insertAdjacentHTML('afterend', '\n  ' + block);
  else root.querySelector('head').insertAdjacentHTML('beforeend', '\n  ' + block);
}

function setMeta(root, sel, attr, value) {
  const el = root.querySelector(sel);
  if (el) el.setAttribute(attr, value);
}

// Rebuild the FAQPage node of a JSON-LD @graph in the target language, and localize
// the SoftwareApplication description, so structured data matches visible content.
function localizeJsonLd(root, lang) {
  const scripts = root.querySelectorAll('script[type="application/ld+json"]');
  for (const s of scripts) {
    let data;
    try { data = JSON.parse(s.text); } catch { continue; }
    const graph = Array.isArray(data['@graph']) ? data['@graph'] : [data];
    for (const node of graph) {
      if (node['@type'] === 'FAQPage' && Array.isArray(node.mainEntity)) {
        const items = [];
        for (let i = 1; ('faq.q' + i) in DICT.en; i++) {
          items.push({
            '@type': 'Question',
            name: t(lang, 'faq.q' + i),
            acceptedAnswer: { '@type': 'Answer', text: t(lang, 'faq.a' + i) },
          });
        }
        if (items.length) node.mainEntity = items;
      }
      if (node['@type'] === 'SoftwareApplication') node.description = t(lang, 'meta.desc');
      if (node['@type'] === 'WebSite') node.inLanguage = [lang];
    }
    s.set_content('\n  ' + JSON.stringify(data, null, 2).replace(/\n/g, '\n  ') + '\n  ');
  }
}

function localizeText(root, lang) {
  root.querySelectorAll('[data-i18n]').forEach((el) => { el.set_content(esc(t(lang, el.getAttribute('data-i18n')))); });
  root.querySelectorAll('[data-i18n-html]').forEach((el) => { el.set_content(t(lang, el.getAttribute('data-i18n-html'))); });
  root.querySelectorAll('[data-i18n-aria]').forEach((el) => { el.setAttribute('aria-label', t(lang, el.getAttribute('data-i18n-aria'))); });
}

function ensureDoctype(html) {
  return /^\s*<!doctype/i.test(html) ? html : '<!doctype html>\n' + html;
}

let generated = 0;
for (const page of PAGES) {
  const srcHtml = readFileSync(resolve(SITE, page.src), 'utf8');

  // 1) inject hreflang into the English source (idempotent) and save it back
  {
    const root = parse(srcHtml, { comment: true });
    setHreflang(root, page.urls);
    writeFileSync(resolve(SITE, page.src), ensureDoctype(root.toString()));
  }

  // 2) generate each localized page
  for (const lang of LANGS) {
    const outRel = page.out[lang];
    if (!outRel) continue;
    const root = parse(srcHtml, { comment: true });

    root.querySelector('html')?.setAttribute('lang', lang);
    setMeta(root, 'link[rel="canonical"]', 'href', page.urls[lang]);
    setHreflang(root, page.urls);

    // localized <title> + description
    const titleEl = root.querySelector('title');
    if (titleEl) titleEl.set_content(esc(t(lang, 'meta.title')));
    setMeta(root, 'meta[name="description"]', 'content', t(lang, 'meta.desc'));

    // Open Graph + Twitter
    setMeta(root, 'meta[property="og:url"]', 'content', page.urls[lang]);
    setMeta(root, 'meta[property="og:title"]', 'content', t(lang, 'meta.title'));
    setMeta(root, 'meta[property="og:description"]', 'content', t(lang, 'meta.desc'));
    setMeta(root, 'meta[property="og:locale"]', 'content', OG_LOCALE[lang] || lang);
    setMeta(root, 'meta[property="og:locale:alternate"]', 'content', OG_LOCALE.en);
    setMeta(root, 'meta[name="twitter:title"]', 'content', t(lang, 'meta.title'));
    setMeta(root, 'meta[name="twitter:description"]', 'content', t(lang, 'meta.desc'));

    // keep users inside the language: home link -> localized home
    root.querySelectorAll('a[href="/"]').forEach((a) => a.setAttribute('href', '/' + lang + '/'));

    localizeText(root, lang);
    localizeJsonLd(root, lang);

    const outAbs = resolve(SITE, outRel);
    mkdirSync(dirname(outAbs), { recursive: true });
    writeFileSync(outAbs, ensureDoctype(root.toString()));
    generated++;
    console.log('generated', outRel, '<-', page.src, '[' + lang + ']');
  }
}
console.log('done:', generated, 'localized page(s)');
