/* Pages de texte (conditions, remboursement, confidentialité, mentions) :
   sommaire construit à partir des titres visibles, section en cours surlignée,
   barre du haut qui se pose au défilement. */
(function () {
  'use strict';
  var nav = document.getElementById('nav');
  function navState() { if (nav) nav.classList.toggle('scrolled', (window.scrollY || 0) > 12); }
  window.addEventListener('scroll', navState, { passive: true });
  navState();
  var main = document.querySelector('main.doc');
  if (!main) return;
  var aside = document.createElement('nav');
  aside.className = 'doc-toc';
  main.insertBefore(aside, main.firstChild);
  var io = null;

  function slug(s) {
    return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 's';
  }
  function visible(el) { for (var p = el; p && p !== main; p = p.parentElement) if (p.hidden) return false; return true; }

  function build() {
    var heads = [].slice.call(main.querySelectorAll('h2')).filter(visible);
    aside.innerHTML = '';
    if (io) io.disconnect();
    if (heads.length < 3) { aside.hidden = true; return; }
    aside.hidden = false;
    var title = document.createElement('p');
    title.className = 'doc-toc-title';
    title.textContent = window.FDI18N ? window.FDI18N.t('doc.toc') : 'On this page';
    var list = document.createElement('ol');
    var used = {};
    heads.forEach(function (h) {
      if (!h.id) { var id = slug(h.textContent); while (used[id] || document.getElementById(id)) id += '-2'; h.id = id; }
      used[h.id] = 1;
      var li = document.createElement('li');
      var a = document.createElement('a');
      a.href = '#' + h.id;
      a.textContent = h.textContent.replace(/^\s*\d+\.\s*/, '');
      li.appendChild(a);
      list.appendChild(li);
    });
    aside.appendChild(title);
    aside.appendChild(list);
    if (!('IntersectionObserver' in window)) return;
    var links = aside.querySelectorAll('a');
    io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        links.forEach(function (a) { a.classList.toggle('on', a.getAttribute('href') === '#' + en.target.id); });
      });
    }, { rootMargin: '-20% 0px -70% 0px' });
    heads.forEach(function (h) { io.observe(h); });
  }

  build();
  // les pages à blocs par langue choisissent le leur au chargement : on refait après elles
  document.addEventListener('DOMContentLoaded', function () { setTimeout(build, 0); });
  window.addEventListener('load', build);
  // la langue change le bloc affiché (confidentialité, mentions) : on refait le sommaire
  ['fd-lang', 'langchange'].forEach(function (ev) { window.addEventListener(ev, function () { setTimeout(build, 0); }); });
})();
