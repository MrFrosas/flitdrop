/* Page /refund (et /fr/refund, /de/refund) : fonction de rétractation exigée par la
   loi (directive 2023/2673 ; art. L221-21 du Code de la consommation ; § 356a BGB).
   - « Renoncer au contrat ici » ouvre le formulaire en place (jamais de fenêtre) ;
     l'adresse /refund#withdraw l'ouvre directement.
   - Trois champs : nom et prénom, adresse e-mail de l'achat, numéro de commande ou
     date d'achat. Aucun motif demandé.
   - Envoi à /api/withdraw (même domaine) : la réponse est toujours la même, et
     l'accusé de réception (date et heure) part par e-mail. En cas d'échec, la page
     renvoie vers Paddle et l'e-mail, toujours affichés sous le formulaire.
   Aucun texte ici : tous les messages sont dans la page, traduits par les outils i18n. */
(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }

  function start() {
    var form = $('withdraw');
    var opener = $('withdrawOpen');
    var status = $('withdrawStatus');
    var doneBox = $('withdrawDone');
    if (!form || !opener) return;
    var submit = form.querySelector('button[type="submit"]');
    var m = /^\/(fr|de)\//.exec(location.pathname || '/');
    var lang = m ? m[1] : 'en';

    function msg(key) {
      var e = form.querySelector('[data-msg="' + key + '"]');
      return e ? e.textContent.trim() : '';
    }
    function say(text, isError) {
      if (!status) return;
      status.textContent = text;
      status.hidden = !text;
      status.classList.toggle('is-err', !!isError);
    }
    function open(focus) {
      if (!doneBox || doneBox.hidden) form.hidden = false;
      opener.setAttribute('aria-expanded', 'true');
      if (focus) {
        var first = form.querySelector('input');
        if (first) first.focus();
      }
    }

    opener.addEventListener('click', function () { open(true); });
    function fromHash() {
      if (location.hash !== '#withdraw') return;
      open(false);
      try { form.scrollIntoView({ block: 'start' }); } catch (e) {}
    }
    window.addEventListener('hashchange', fromHash);
    fromHash();

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (!form.checkValidity()) { form.reportValidity(); return; }
      var el = form.elements;
      var payload = {
        name: (el.name.value || '').trim(),
        email: (el.email.value || '').trim(),
        order: (el.order.value || '').trim(),
        lang: lang
      };
      if (!window.fetch) { say(msg('error'), true); return; }
      submit.disabled = true;
      say(msg('sending'));
      fetch('/api/withdraw', {
        method: 'POST',
        credentials: 'omit',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      }).then(function (r) {
        if (r.ok) {
          // bien reçue : le formulaire laisse place à la confirmation, au calme
          form.reset();
          form.hidden = true;
          opener.hidden = true;
          say('');
          if (doneBox) { doneBox.hidden = false; doneBox.focus(); }
          return;
        }
        say(msg(r.status === 429 ? 'tooMany' : 'error'), true);
      }).catch(function () {
        say(msg('error'), true);
      }).then(function () {
        submit.disabled = false;
      });
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
