import { describe, it, expect } from 'vitest'
import { KeyedNodes, VersionedList, reconcile, type ListParent } from '../src/webclient/lists.js'

// Faux parent de liste : enregistre chaque opération pour vérifier qu'une
// relecture sans changement ne touche à rien.
class FakeNode {
  constructor(readonly name: string) {}
  // état propre à la ligne (comme la largeur d'une barre de progression)
  bar = '0%'
}
class FakeList implements ListParent<FakeNode> {
  kids: FakeNode[] = []
  ops: string[] = []
  get children(): ArrayLike<FakeNode> {
    return this.kids
  }
  insertBefore(node: FakeNode, ref: FakeNode | null): void {
    this.ops.push(`insert ${node.name}`)
    const cur = this.kids.indexOf(node)
    if (cur >= 0) this.kids.splice(cur, 1)
    const at = ref ? this.kids.indexOf(ref) : -1
    if (at < 0) this.kids.push(node)
    else this.kids.splice(at, 0, node)
  }
  removeChild(node: FakeNode): void {
    this.ops.push(`remove ${node.name}`)
    this.kids.splice(this.kids.indexOf(node), 1)
  }
  names(): string[] {
    return this.kids.map((k) => k.name)
  }
}

interface Item {
  id: string
}

// même enchaînement que la page du téléphone (renderRecv), sans DOM
function render(list: FakeList, cache: KeyedNodes<FakeNode>, items: Item[], lang: string, downloading: Set<string>) {
  reconcile(list, cache.sync(items, lang, (i) => new FakeNode(i.id), downloading))
}

describe('liste du téléphone sans clignotement', () => {
  it('une relecture identique ne touche à aucune ligne', () => {
    const list = new FakeList()
    const cache = new KeyedNodes<FakeNode>()
    const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    render(list, cache, items, 'fr', new Set())
    expect(list.names()).toEqual(['a', 'b', 'c'])
    list.ops = []
    render(list, cache, items, 'fr', new Set())
    expect(list.ops).toEqual([])
  })

  it('la barre d’un téléchargement en cours survit à l’arrivée d’un nouvel élément', () => {
    const list = new FakeList()
    const cache = new KeyedNodes<FakeNode>()
    const downloading = new Set<string>()
    render(list, cache, [{ id: 'video' }], 'fr', downloading)
    const line = list.kids[0]!
    downloading.add('video')
    line.bar = '42%'
    // le PC met un autre fichier à disposition : il arrive en tête de liste
    render(list, cache, [{ id: 'photo' }, { id: 'video' }], 'fr', downloading)
    expect(list.names()).toEqual(['photo', 'video'])
    expect(list.kids[1]).toBe(line)
    expect(list.kids[1]!.bar).toBe('42%')
    // seule la nouvelle ligne a été ajoutée
    expect(list.ops.filter((o) => o.startsWith('remove'))).toEqual([])
  })

  it('une ligne en téléchargement reste même si l’élément disparaît du PC, puis part à la fin', () => {
    const list = new FakeList()
    const cache = new KeyedNodes<FakeNode>()
    const downloading = new Set<string>(['gros'])
    render(list, cache, [{ id: 'gros' }], 'fr', downloading)
    const line = list.kids[0]!
    render(list, cache, [], 'fr', downloading)
    expect(list.kids).toEqual([line])
    downloading.delete('gros')
    render(list, cache, [], 'fr', downloading)
    expect(list.kids).toEqual([])
    expect(cache.size).toBe(0)
  })

  it('changement de langue : lignes recréées, sauf celle en téléchargement', () => {
    const list = new FakeList()
    const cache = new KeyedNodes<FakeNode>()
    const downloading = new Set<string>(['b'])
    render(list, cache, [{ id: 'a' }, { id: 'b' }], 'fr', downloading)
    const [a, b] = list.kids
    render(list, cache, [{ id: 'a' }, { id: 'b' }], 'en', downloading)
    expect(list.kids[0]).not.toBe(a)
    expect(list.kids[1]).toBe(b)
  })

  it('retrait et réordonnancement', () => {
    const list = new FakeList()
    const cache = new KeyedNodes<FakeNode>()
    render(list, cache, [{ id: 'a' }, { id: 'b' }, { id: 'c' }], 'fr', new Set())
    const c = list.kids[2]
    render(list, cache, [{ id: 'c' }, { id: 'a' }], 'fr', new Set())
    expect(list.names()).toEqual(['c', 'a'])
    expect(list.kids[0]).toBe(c)
    expect(cache.size).toBe(2)
  })
})

describe('liste versionnée', () => {
  it('première lecture sans étiquette, puis « rien de neuf » garde la liste', () => {
    const l = new VersionedList<string[]>()
    expect(l.request()).toEqual({})
    expect(l.accept({ v: 'x.1.0' }, () => ['a'])).toEqual(['a'])
    expect(l.request()).toEqual({ since: 'x.1.0' })
    let rebuilt = false
    const same = l.accept({ unchanged: true, v: 'x.1.0' }, () => {
      rebuilt = true
      return []
    })
    expect(same).toEqual(['a'])
    expect(rebuilt).toBe(false)
    expect(l.accept({ v: 'x.2.0' }, () => ['b', 'a'])).toEqual(['b', 'a'])
    expect(l.request()).toEqual({ since: 'x.2.0' })
  })

  it('PC plus ancien (sans version) : liste complète à chaque fois', () => {
    const l = new VersionedList<string[]>()
    l.accept({}, () => ['a'])
    expect(l.request()).toEqual({})
  })

  it('« rien de neuf » sans liste en main : on redemande tout', () => {
    const l = new VersionedList<string[]>()
    l.tag = 'orphelin'
    expect(l.accept({ unchanged: true, v: 'orphelin' }, () => ['z'])).toBeNull()
    expect(l.request()).toEqual({})
  })
})
