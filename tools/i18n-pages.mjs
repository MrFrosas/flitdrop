/* Shared string extraction / reinsertion for localizing the hand-written SEO
 * article pages (whose bodies are NOT [data-i18n] driven).
 *
 * The golden rule: agents translate STRINGS, code reinserts them. The DOM walk
 * is deterministic, so extraction and application visit the exact same units in
 * the same order, keyed by a sequential id. Markup, scripts, classes, URLs and
 * [data-i18n] runtime hooks are never touched.
 *
 * Translatable units:
 *  - the <title> text
 *  - selected <meta>/og/twitter `content` attributes
 *  - visible text nodes NOT inside a [data-i18n]/[data-i18n-html] element or a
 *    script/style/noscript (those are localized at runtime from the dictionary)
 *  - a few translatable attributes (img alt, aria-label without data-i18n-aria)
 *  - string fields inside JSON-LD (headline, description, name, text, articleBody)
 */
import { parse, NodeType } from 'node-html-parser';

const META_CONTENT_SELECTORS = [
  'meta[name="description"]',
  'meta[property="og:title"]',
  'meta[property="og:description"]',
  'meta[property="og:image:alt"]',
  'meta[name="twitter:title"]',
  'meta[name="twitter:description"]',
];
const JSONLD_STRING_KEYS = new Set(['headline', 'description', 'name', 'text', 'articleBody', 'caption']);

const hasLetter = (s) => /\p{L}/u.test(s);
const escText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function splitWs(s) {
  const lead = s.match(/^\s*/)[0];
  const trail = s.match(/\s*$/)[0];
  return { lead, core: s.slice(lead.length, s.length - trail.length), trail };
}
function insideSkipped(node) {
  for (let p = node.parentNode; p; p = p.parentNode) {
    if (!p.tagName) continue;
    const tag = p.tagName.toLowerCase();
    if (tag === 'script' || tag === 'style' || tag === 'noscript') return true;
    if (p.hasAttribute && (p.hasAttribute('data-i18n') || p.hasAttribute('data-i18n-html'))) return true;
    if (p.getAttribute && p.getAttribute('translate') === 'no') return true;
  }
  return false;
}

/* One deterministic pass. Calls onUnit({id, kind, en}) for every translatable
 * unit and returns { appliers, finalizers }:
 *   appliers[i](translatedText) applies the translation for unit id i
 *   finalizers[k]() run after all appliers (e.g. re-stringify JSON-LD) */
export function collectUnits(root, onUnit) {
  let id = 0;
  const appliers = [];
  const finalizers = [];
  const emit = (kind, en, apply) => {
    const core = en == null ? '' : String(en);
    if (!core.trim() || !hasLetter(core)) return;
    onUnit({ id, kind, en: core });
    appliers[id] = apply;
    id++;
  };

  // 1) <title>
  const title = root.querySelector('title');
  if (title) {
    const { lead, core, trail } = splitWs(title.text);
    emit('title', core, (v) => title.set_content(lead + escText(v) + trail));
  }

  // 2) meta content attributes
  for (const sel of META_CONTENT_SELECTORS) {
    const el = root.querySelector(sel);
    if (el) emit('meta', el.getAttribute('content'), (tv) => el.setAttribute('content', tv));
  }

  // 3) visible text nodes + 4) translatable attributes, in document order
  const body = root.querySelector('body') || root;
  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === NodeType.TEXT_NODE) {
        if (insideSkipped(child)) continue;
        const { lead, core, trail } = splitWs(child.rawText);
        if (core && hasLetter(core)) emit('text', core, (v) => { child.rawText = lead + escText(v) + trail; });
      } else if (child.nodeType === NodeType.ELEMENT_NODE) {
        const tag = child.tagName.toLowerCase();
        if (tag === 'script' || tag === 'style' || tag === 'noscript') continue;
        if (child.getAttribute('alt') && !child.hasAttribute('data-i18n-alt')) {
          const v = child.getAttribute('alt');
          if (hasLetter(v)) emit('attr:alt', v, (tv) => child.setAttribute('alt', tv));
        }
        if (child.getAttribute('aria-label') && !child.hasAttribute('data-i18n-aria')) {
          const v = child.getAttribute('aria-label');
          if (hasLetter(v)) emit('attr:aria', v, (tv) => child.setAttribute('aria-label', tv));
        }
        walk(child);
      }
    }
  };
  walk(body);

  // 5) JSON-LD string fields (emit each, then a finalizer re-stringifies the block)
  root.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
    let data;
    try { data = JSON.parse(s.text); } catch { return; }
    const visit = (obj) => {
      if (Array.isArray(obj)) return obj.forEach(visit);
      if (obj && typeof obj === 'object') {
        for (const k of Object.keys(obj)) {
          if (typeof obj[k] === 'string' && JSONLD_STRING_KEYS.has(k) && hasLetter(obj[k])) {
            const ref = obj, key = k;
            emit('jsonld:' + k, obj[k], (tv) => { ref[key] = tv; });
          } else visit(obj[k]);
        }
      }
    };
    visit(data);
    finalizers.push(() => s.set_content('\n  ' + JSON.stringify(data, null, 2).replace(/\n/g, '\n  ') + '\n  '));
  });

  return { appliers, finalizers };
}

export function extractUnits(html) {
  const root = parse(html, { comment: true });
  const units = [];
  collectUnits(root, (u) => units.push(u));
  return units;
}

// translations: { [id]: translatedString }. Returns the parsed root (mutated).
export function applyToRoot(root, translations) {
  const { appliers, finalizers } = collectUnits(root, () => {});
  appliers.forEach((fn, i) => { const t = translations[i]; if (t != null && fn) fn(t); });
  finalizers.forEach((f) => f());
  return root;
}
