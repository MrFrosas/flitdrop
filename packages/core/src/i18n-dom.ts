// Applique les traductions au HTML statique via des attributs data-i18n*.
// Séparé de i18n.ts (pur) pour que le bundle serveur/Electron n'embarque pas de
// référence au DOM. Utilisé par les deux clients web.
import { t, type Lang } from './i18n.js'

export function applyI18n(lang: Lang, root: ParentNode = document): void {
  document.documentElement.setAttribute('lang', lang)
  root.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
    el.textContent = t(lang, el.dataset.i18n as string)
  })
  // valeurs du dictionnaire contenant du balisage sûr (<b>, <code>) : jamais de
  // saisie utilisateur, donc innerHTML est sans risque ici.
  root.querySelectorAll<HTMLElement>('[data-i18n-html]').forEach((el) => {
    el.innerHTML = t(lang, el.dataset.i18nHtml as string)
  })
  root.querySelectorAll<HTMLElement>('[data-i18n-ph]').forEach((el) => {
    ;(el as HTMLInputElement | HTMLTextAreaElement).placeholder = t(lang, el.dataset.i18nPh as string)
  })
  root.querySelectorAll<HTMLElement>('[data-i18n-aria]').forEach((el) => {
    el.setAttribute('aria-label', t(lang, el.dataset.i18nAria as string))
  })
  root.querySelectorAll<HTMLElement>('[data-i18n-title]').forEach((el) => {
    el.setAttribute('title', t(lang, el.dataset.i18nTitle as string))
  })
}
