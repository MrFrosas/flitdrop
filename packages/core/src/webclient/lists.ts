// Listes de la page du téléphone (fichiers reçus, historique du presse-papiers)
// relues toutes les 5 à 6 s. Deux règles : ne pas retélécharger ce qu'on a déjà
// (étiquette de version, le PC répond « rien de neuf ») et ne jamais recréer une
// ligne qui existe déjà (plus de clignotement, et la barre de progression d'un
// téléchargement en cours reste à sa place). Sans DOM : testable tel quel.

/** Parent minimal : un élément du DOM, ou un faux nœud dans les tests. */
export interface ListParent<N> {
  readonly children: ArrayLike<unknown>
  insertBefore(node: N, ref: N | null): unknown
  removeChild(node: N): unknown
}

/** Met les enfants de `parent` exactement dans l'ordre de `nodes`, en ne
 *  touchant qu'aux lignes ajoutées, retirées ou déplacées. */
export function reconcile<N>(parent: ListParent<N>, nodes: readonly N[]): void {
  const keep = new Set<unknown>(nodes)
  for (const child of Array.from(parent.children)) if (!keep.has(child)) parent.removeChild(child as N)
  nodes.forEach((node, i) => {
    const at = (parent.children[i] as N | undefined) ?? null
    if (at !== node) parent.insertBefore(node, at)
  })
}

/** Lignes déjà construites, par identifiant d'élément. Une ligne est gardée
 *  tant que sa signature (la langue, par exemple) ne change pas, et toujours
 *  si elle est tenue (téléchargement en cours). */
export class KeyedNodes<N> {
  private map = new Map<string, { node: N; sig: string }>()

  get(key: string, sig: string, build: () => N, held = false): N {
    const cur = this.map.get(key)
    if (cur && (cur.sig === sig || held)) return cur.node
    const node = build()
    this.map.set(key, { node, sig })
    return node
  }

  node(key: string): N | undefined {
    return this.map.get(key)?.node
  }

  /** Oublie les lignes dont l'élément n'est plus listé (sauf celles tenues). */
  prune(listed: ReadonlySet<string>, held: (key: string) => boolean = () => false): void {
    for (const key of [...this.map.keys()]) if (!listed.has(key) && !held(key)) this.map.delete(key)
  }

  get size(): number {
    return this.map.size
  }

  /** Lignes à afficher pour `items`, dans l'ordre, suivies des lignes tenues
   *  dont l'élément a disparu entre-temps (fichier retiré sur le PC pendant
   *  qu'on le télécharge : la ligne reste jusqu'à la fin). */
  sync<T extends { id: string }>(items: readonly T[], sig: string, build: (item: T) => N, held: ReadonlySet<string> = new Set()): N[] {
    const listed = new Set(items.map((i) => i.id))
    const nodes = items.map((i) => this.get(i.id, sig, () => build(i), held.has(i.id)))
    for (const key of held) {
      const node = this.node(key)
      if (node !== undefined && !listed.has(key)) nodes.push(node)
    }
    this.prune(listed, (key) => held.has(key))
    return nodes
  }
}

/** Réponse du PC à une relecture de liste. Un PC plus ancien n'envoie ni
 *  `v` ni `unchanged` : la liste complète est alors prise telle quelle. */
export interface VersionedReply {
  unchanged?: unknown
  v?: unknown
}

/** Liste relue auprès du PC, avec l'étiquette de version de ce qu'on a. */
export class VersionedList<T> {
  tag = ''
  data: T | null = null

  /** Ce qu'on joint à la requête : l'étiquette, seulement si on a déjà la
   *  liste qui va avec. */
  request(): Record<string, unknown> {
    return this.data !== null && this.tag ? { since: this.tag } : {}
  }

  /** Données à afficher après une réponse : celles qu'on garde si le PC
   *  répond « rien de neuf », sinon les nouvelles. null : rien à afficher
   *  (réponse « rien de neuf » sans liste en main, on redemandera tout). */
  accept(res: VersionedReply, fresh: () => T): T | null {
    if (res.unchanged === true) {
      if (this.data !== null) return this.data
      this.tag = ''
      return null
    }
    this.data = fresh()
    this.tag = typeof res.v === 'string' ? res.v.slice(0, 80) : ''
    return this.data
  }
}
