import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ClipboardWatcher,
  flattenOnWhite,
  rawImageFormats,
  thumbDataURL,
  type WatchedClipboard,
  type WatchedImage,
} from '../src/clipwatch.js'

// Faux presse-papiers : compte les décodages (readImage) et les réencodages
// (toPNG), le vrai coût mesuré sur Mac quand une capture reste copiée.
function fakeClipboard(opts: { raw?: Record<string, Buffer>; pixels?: Buffer; formats?: string[] } = {}) {
  const count = { readImage: 0, toPNG: 0, readBuffer: 0, toBitmap: 0 }
  const state = { raw: opts.raw ?? {}, pixels: opts.pixels ?? Buffer.alloc(0), formats: opts.formats ?? ['image/png'] }
  const makeImage = (): WatchedImage => ({
    isEmpty: () => state.pixels.length === 0,
    getSize: () => ({ width: 400, height: 300 }),
    toPNG: () => {
      count.toPNG++
      return Buffer.concat([Buffer.from('png:'), state.pixels])
    },
    toBitmap: () => {
      count.toBitmap++
      return Buffer.from(state.pixels)
    },
    resize: () => makeImage(),
    toDataURL: () => 'data:image/png;base64,AAAA',
  })
  const clipboard: WatchedClipboard = {
    availableFormats: () => state.formats,
    readBuffer: (f) => {
      count.readBuffer++
      return state.raw[f] ?? Buffer.alloc(0)
    },
    readImage: () => {
      count.readImage++
      return makeImage()
    },
  }
  return { clipboard, count, state }
}

function watcher(clipboard: WatchedClipboard, extra: Partial<ConstructorParameters<typeof ClipboardWatcher>[0]> = {}) {
  const images: Array<{ png: Buffer; w: number; fp: string; thumb: string }> = []
  const checkText = vi.fn(async () => {})
  const w = new ClipboardWatcher({
    clipboard,
    platform: 'darwin',
    checkText,
    imagesEnabled: () => true,
    anyEnabled: () => true,
    onImage: (png, thumb, width, _h, fp) => images.push({ png, w: width, fp, thumb }),
    ...extra,
  })
  return { w, images, checkText }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('ClipboardWatcher : images', () => {
  it('une image qui reste copiée n’est encodée qu’une seule fois', async () => {
    const f = fakeClipboard({ raw: { 'public.png': Buffer.from('capture-1') }, pixels: Buffer.from('pix-1') })
    const { w, images } = watcher(f.clipboard)
    for (let i = 0; i < 40; i++) await w.tick()
    expect(images).toHaveLength(1)
    expect(f.count.toPNG).toBe(1)
    // ni décodage ni réencodage tant que les octets bruts ne changent pas
    expect(f.count.readImage).toBe(1)
  })

  it('une nouvelle image est bien enregistrée', async () => {
    const f = fakeClipboard({ raw: { 'public.png': Buffer.from('capture-1') }, pixels: Buffer.from('pix-1') })
    const { w, images } = watcher(f.clipboard)
    await w.tick()
    f.state.raw['public.png'] = Buffer.from('capture-2')
    f.state.pixels = Buffer.from('pix-2')
    await w.tick()
    await w.tick()
    expect(images).toHaveLength(2)
    expect(images[1]?.png.toString()).toBe('png:pix-2')
  })

  it('capture en TIFF seulement (macOS) : empreinte sur les octets TIFF', async () => {
    const f = fakeClipboard({ raw: { 'public.tiff': Buffer.from('tiff-1') }, pixels: Buffer.from('pix-1') })
    const { w, images } = watcher(f.clipboard)
    for (let i = 0; i < 5; i++) await w.tick()
    expect(images).toHaveLength(1)
    expect(f.count.toPNG).toBe(1)
  })

  it('sans octets bruts (bitmap Windows seul) : pixels bruts, jamais de réencodage répété', async () => {
    const f = fakeClipboard({ pixels: Buffer.from('dib-1') })
    const { w, images } = watcher(f.clipboard, { platform: 'win32' })
    for (let i = 0; i < 10; i++) await w.tick()
    expect(images).toHaveLength(1)
    expect(f.count.toPNG).toBe(1)
    f.state.pixels = Buffer.from('dib-2')
    await w.tick()
    expect(images).toHaveLength(2)
  })

  it('pas d’image dans le presse-papiers : rien n’est lu', async () => {
    const f = fakeClipboard({ formats: ['text/plain'], pixels: Buffer.from('x') })
    const { w, images } = watcher(f.clipboard)
    await w.tick()
    expect(images).toHaveLength(0)
    expect(f.count.readBuffer + f.count.readImage + f.count.toPNG).toBe(0)
  })

  it('historique coupé : ni texte d’historique ni image, et rien si tout est coupé', async () => {
    const f = fakeClipboard({ raw: { 'public.png': Buffer.from('c') }, pixels: Buffer.from('p') })
    const off = watcher(f.clipboard, { imagesEnabled: () => false })
    await off.w.tick()
    expect(off.images).toHaveLength(0)
    expect(off.checkText).toHaveBeenCalledTimes(1)
    const none = watcher(f.clipboard, { imagesEnabled: () => false, anyEnabled: () => false })
    await none.w.tick()
    expect(none.checkText).not.toHaveBeenCalled()
  })

  it('gros TIFF resté copié, personne au clavier : ni lecture ni hachage à chaque passage', async () => {
    let clock = 1_000_000
    let idle = 30 // copié puis laissé là
    const tiff = Buffer.alloc(8 * 1024 * 1024, 7) // une capture Retina en TIFF
    const f = fakeClipboard({ raw: { 'public.tiff': tiff }, pixels: Buffer.from('pix-1'), formats: ['image/tiff', 'image/png'] })
    const { w, images } = watcher(f.clipboard, { idleSeconds: () => idle, now: () => clock })
    await w.tick()
    expect(images).toHaveLength(1)
    const reads = f.count.readBuffer
    // personne au clavier : 5 passages, formats identiques, inactivité qui grandit
    for (let i = 0; i < 5; i++) {
      clock += 5000
      idle += 5
      await w.tick()
    }
    expect(f.count.readBuffer).toBe(reads)
    expect(f.count.readImage).toBe(1)
    expect(f.count.toBitmap).toBe(0)
    // filet de sécurité : 30 s plus tard, une relecture complète quand même
    clock += 5000
    idle += 5
    await w.tick()
    expect(f.count.readBuffer).toBeGreaterThan(reads)
    const after = f.count.readBuffer
    clock += 5000
    idle += 5
    await w.tick()
    expect(f.count.readBuffer).toBe(after)
    // une action au clavier (copier) : relecture au passage suivant
    clock += 1500
    idle = 0
    f.state.raw['public.tiff'] = Buffer.alloc(8 * 1024 * 1024, 9)
    f.state.pixels = Buffer.from('pix-2')
    await w.tick()
    expect(images).toHaveLength(2)
  })

  it('bitmap Windows seul resté copié : ni readImage ni toBitmap sans signal', async () => {
    let clock = 1_000_000
    let idle = 100
    const f = fakeClipboard({ pixels: Buffer.alloc(1024 * 1024, 3), formats: ['image/png'] })
    const { w, images } = watcher(f.clipboard, { platform: 'win32', idleSeconds: () => idle, now: () => clock })
    await w.tick()
    expect(images).toHaveLength(1)
    expect(f.count.readImage).toBe(1)
    expect(f.count.toBitmap).toBe(1)
    for (let i = 0; i < 5; i++) {
      clock += 5000
      idle += 5
      await w.tick()
    }
    expect(f.count.readImage).toBe(1)
    expect(f.count.toBitmap).toBe(1)
    expect(f.count.readBuffer).toBe(1)
    // la liste des formats change (nouvelle copie par un autre programme) : relecture
    clock += 1500
    idle += 1
    f.state.formats = ['text/plain', 'image/png']
    f.state.pixels = Buffer.alloc(1024 * 1024, 4)
    await w.tick()
    expect(f.count.readImage).toBe(2)
    expect(images).toHaveLength(2)
  })

  it('un nouveau texte vu déclenche aussi la relecture de l’image', async () => {
    let clock = 1_000_000
    let idle = 100
    const f = fakeClipboard({ raw: { 'public.png': Buffer.from('c-1') }, pixels: Buffer.from('p-1'), formats: ['text/plain', 'image/png'] })
    let fresh = false
    const { w, images } = watcher(f.clipboard, { idleSeconds: () => idle, now: () => clock, checkText: async () => fresh })
    await w.tick()
    const reads = f.count.readBuffer
    clock += 5000
    idle += 5
    await w.tick()
    expect(f.count.readBuffer).toBe(reads)
    fresh = true
    f.state.raw['public.png'] = Buffer.from('c-2')
    f.state.pixels = Buffer.from('p-2')
    clock += 5000
    idle += 5
    await w.tick()
    expect(images).toHaveLength(2)
  })

  it('inactivité inconnue : on relit à chaque passage, comme avant', async () => {
    let clock = 1_000_000
    const f = fakeClipboard({ raw: { 'public.tiff': Buffer.from('t') }, pixels: Buffer.from('p') })
    const { w } = watcher(f.clipboard, {
      now: () => clock,
      idleSeconds: () => {
        throw new Error('indisponible')
      },
    })
    for (let i = 0; i < 4; i++) {
      clock += 5000
      await w.tick()
    }
    expect(f.count.readBuffer).toBeGreaterThanOrEqual(4)
    expect(f.count.toPNG).toBe(1)
  })

  it('texte lu par un programme externe : pas de lecture quand seule une image est copiée', async () => {
    const f = fakeClipboard({ formats: ['image/png'], raw: { 'image/png': Buffer.from('i') }, pixels: Buffer.from('p') })
    const { w, checkText } = watcher(f.clipboard, { platform: 'linux', textNeedsTextFormat: true })
    await w.tick()
    expect(checkText).not.toHaveBeenCalled()
    f.state.formats = ['text/plain', 'image/png']
    await w.tick()
    expect(checkText).toHaveBeenCalledTimes(1)
    // formats inconnus (liste vide) : on lit quand même
    f.state.formats = []
    await w.tick()
    expect(checkText).toHaveBeenCalledTimes(2)
    // lecture dans le processus (cas par défaut) : toujours lue
    const inProc = watcher(f.clipboard, { platform: 'linux' })
    f.state.formats = ['image/png']
    await inProc.w.tick()
    expect(inProc.checkText).toHaveBeenCalledTimes(1)
  })

  it('noms bruts par système', () => {
    expect(rawImageFormats('darwin')).toEqual(['public.png', 'public.tiff'])
    expect(rawImageFormats('win32')).toEqual(['PNG'])
    expect(rawImageFormats('linux')).toEqual(['image/png'])
  })
})

describe('ClipboardWatcher : rythme', () => {
  it('1,5 s au clavier, 5 s après une minute d’inactivité', async () => {
    vi.useFakeTimers()
    let idle = 0
    const f = fakeClipboard({ formats: [] })
    const { w, checkText } = watcher(f.clipboard, { idleSeconds: () => idle })
    w.start()
    await vi.advanceTimersByTimeAsync(1500 * 4)
    expect(checkText).toHaveBeenCalledTimes(4)
    idle = 120
    checkText.mockClear()
    await vi.advanceTimersByTimeAsync(1500) // le passage en cours reprogramme à 5 s
    await vi.advanceTimersByTimeAsync(20_000)
    expect(checkText.mock.calls.length).toBeLessThanOrEqual(5)
    expect(checkText.mock.calls.length).toBeGreaterThanOrEqual(4)
    w.stop()
  })

  it('en pause au verrouillage, vérifie tout de suite au déverrouillage, s’arrête à la fermeture', async () => {
    vi.useFakeTimers()
    const f = fakeClipboard({ formats: [] })
    const { w, checkText } = watcher(f.clipboard)
    w.start()
    await vi.advanceTimersByTimeAsync(1500)
    expect(checkText).toHaveBeenCalledTimes(1)
    w.lock()
    checkText.mockClear()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(checkText).not.toHaveBeenCalled()
    // filet de sécurité : un coup d'oeil par minute même en pause
    await vi.advanceTimersByTimeAsync(30_000)
    expect(checkText).toHaveBeenCalledTimes(1)
    checkText.mockClear()
    w.unlock()
    await vi.advanceTimersByTimeAsync(0)
    expect(checkText).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1500)
    expect(checkText).toHaveBeenCalledTimes(2)
    w.stop()
    checkText.mockClear()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(checkText).not.toHaveBeenCalled()
  })

  it('verrouillé, mis en veille puis réveillé : reste en pause jusqu’au déverrouillage', async () => {
    vi.useFakeTimers()
    const f = fakeClipboard({ formats: [] })
    const { w, checkText } = watcher(f.clipboard)
    w.start()
    await vi.advanceTimersByTimeAsync(1500)
    w.lock()
    w.suspend()
    checkText.mockClear()
    // réveil de maintenance ou couvercle ouvert, écran toujours verrouillé
    w.wake()
    expect(w.isPaused).toBe(true)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(checkText).not.toHaveBeenCalled()
    w.unlock()
    expect(w.isPaused).toBe(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(checkText).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1500 * 2)
    expect(checkText).toHaveBeenCalledTimes(3)
    w.stop()
  })

  it('réveil perdu par le système : le déverrouillage rend le rythme normal', async () => {
    vi.useFakeTimers()
    const f = fakeClipboard({ formats: [] })
    const { w, checkText } = watcher(f.clipboard)
    w.start()
    await vi.advanceTimersByTimeAsync(1500)
    w.suspend()
    w.lock()
    // pas de wake() (veille moderne de Windows) : la personne déverrouille
    w.unlock()
    expect(w.isPaused).toBe(false)
    checkText.mockClear()
    await vi.advanceTimersByTimeAsync(0)
    expect(checkText).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1500 * 2)
    expect(checkText).toHaveBeenCalledTimes(3)
    // même sans verrouillage signalé
    w.suspend()
    w.unlock()
    expect(w.isPaused).toBe(false)
    w.stop()
  })

  it('veille seule : le réveil relance tout de suite', async () => {
    vi.useFakeTimers()
    const f = fakeClipboard({ formats: [] })
    const { w, checkText } = watcher(f.clipboard)
    w.start()
    await vi.advanceTimersByTimeAsync(1500)
    w.suspend()
    checkText.mockClear()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(checkText).not.toHaveBeenCalled()
    w.wake()
    await vi.advanceTimersByTimeAsync(0)
    expect(checkText).toHaveBeenCalledTimes(1)
    w.stop()
  })

  it('tout coupé : un réveil par minute seulement, et poke() relance aussitôt', async () => {
    vi.useFakeTimers()
    let on = false
    const f = fakeClipboard({ formats: [] })
    const anyEnabled = vi.fn(() => on)
    const { w, checkText } = watcher(f.clipboard, { anyEnabled })
    w.start()
    await vi.advanceTimersByTimeAsync(1500)
    anyEnabled.mockClear()
    await vi.advanceTimersByTimeAsync(59_000)
    // plus aucun passage toutes les 1,5 s
    expect(anyEnabled).not.toHaveBeenCalled()
    expect(checkText).not.toHaveBeenCalled()
    on = true
    w.poke()
    await vi.advanceTimersByTimeAsync(0)
    expect(checkText).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1500)
    expect(checkText).toHaveBeenCalledTimes(2)
    w.stop()
  })

  it('une erreur imprévue pendant un passage n’arrête pas la surveillance', async () => {
    vi.useFakeTimers()
    const f = fakeClipboard({ pixels: Buffer.from('dib-1') })
    let boom = true
    const readImage = f.clipboard.readImage
    f.clipboard.readImage = () => {
      const img = readImage()
      if (boom) {
        boom = false
        img.toBitmap = () => {
          throw new RangeError('Array buffer allocation failed')
        }
      }
      return img
    }
    const { w, checkText, images } = watcher(f.clipboard, { platform: 'win32' })
    w.start()
    await vi.advanceTimersByTimeAsync(1500)
    expect(checkText).toHaveBeenCalledTimes(1)
    f.state.formats = ['image/png', 'text/plain'] // nouvelle copie
    await vi.advanceTimersByTimeAsync(1500)
    expect(checkText).toHaveBeenCalledTimes(2)
    expect(images).toHaveLength(1)
    w.stop()
  })

  it('un réglage illisible qui lève ne bloque pas non plus la minuterie', async () => {
    vi.useFakeTimers()
    const f = fakeClipboard({ formats: [] })
    let n = 0
    const { w, checkText } = watcher(f.clipboard, {
      anyEnabled: () => {
        if (n++ === 0) throw new Error('config illisible')
        return true
      },
      imagesEnabled: () => {
        throw new Error('config illisible')
      },
    })
    w.start()
    await vi.advanceTimersByTimeAsync(1500 * 3)
    expect(checkText).toHaveBeenCalledTimes(2)
    w.stop()
  })

  it('une lecture du texte qui ne répond jamais ne bloque pas les suivantes', async () => {
    vi.useFakeTimers()
    const f = fakeClipboard({ formats: [] })
    let calls = 0
    const checkText = vi.fn(() => {
      calls++
      return calls === 1 ? new Promise<void>(() => {}) : Promise.resolve()
    })
    const { w } = watcher(f.clipboard, { checkText })
    w.start()
    await vi.advanceTimersByTimeAsync(1500)
    expect(calls).toBe(1)
    await vi.advanceTimersByTimeAsync(15_000 + 1500)
    expect(calls).toBe(2)
    await vi.advanceTimersByTimeAsync(1500)
    expect(calls).toBe(3)
    w.stop()
  })

  it('une idleSeconds qui échoue (Wayland) garde le rythme normal', async () => {
    vi.useFakeTimers()
    const f = fakeClipboard({ formats: [] })
    const { w, checkText } = watcher(f.clipboard, {
      idleSeconds: () => {
        throw new Error('indisponible')
      },
    })
    w.start()
    await vi.advanceTimersByTimeAsync(1500 * 3)
    expect(checkText).toHaveBeenCalledTimes(3)
    w.stop()
  })
})

describe('ClipboardWatcher : empreinte et miniature', () => {
  it('l’empreinte transmise est la même d’un lancement à l’autre pour la même copie', async () => {
    const f = fakeClipboard({ raw: { 'public.png': Buffer.from('capture-1') }, pixels: Buffer.from('pix-1') })
    const a = watcher(f.clipboard)
    await a.w.tick()
    // « redémarrage » : une nouvelle surveillance relit la même image
    const b = watcher(f.clipboard)
    await b.w.tick()
    expect(a.images[0]?.fp).toMatch(/^raw:public\.png:/)
    expect(b.images[0]?.fp).toBe(a.images[0]?.fp)
    f.state.raw['public.png'] = Buffer.from('capture-2')
    await b.w.tick()
    expect(b.images[1]?.fp).not.toBe(a.images[0]?.fp)
  })

  // image 2x1 au format d'Electron : 4 octets par pixel, alpha en dernier,
  // couleurs déjà multipliées par l'alpha
  function img(bitmap: Buffer, extra: Partial<WatchedImage> = {}): WatchedImage & { jpegFrom: Buffer[] } {
    const jpegFrom: Buffer[] = []
    const self: WatchedImage & { jpegFrom: Buffer[] } = {
      jpegFrom,
      isEmpty: () => false,
      getSize: () => ({ width: 2, height: 1 }),
      toPNG: () => Buffer.from('png'),
      toBitmap: () => Buffer.from(bitmap),
      resize: () => self,
      toDataURL: () => 'data:image/png;base64,UE5H',
      toJPEG: (q: number) => {
        expect(q).toBe(80)
        jpegFrom.push(Buffer.from(bitmap))
        return Buffer.from('jpg')
      },
      ...extra,
    }
    return self
  }

  it('image opaque : miniature JPEG', () => {
    const i = img(Buffer.from([10, 20, 30, 255, 40, 50, 60, 255]))
    expect(thumbDataURL(i)).toBe(`data:image/jpeg;base64,${Buffer.from('jpg').toString('base64')}`)
  })

  it('image transparente : posée sur du blanc avant le JPEG', () => {
    const made: Buffer[] = []
    const src = img(Buffer.from([0, 0, 128, 128, 0, 0, 0, 0]))
    const url = thumbDataURL(src, (bmp, size) => {
      expect(size).toEqual({ width: 2, height: 1 })
      made.push(bmp)
      return img(bmp)
    })
    expect(url.startsWith('data:image/jpeg;base64,')).toBe(true)
    // rouge à moitié transparent -> rose clair ; transparent -> blanc
    expect([...made[0]!]).toEqual([127, 127, 255, 255, 255, 255, 255, 255])
    // on n'encode jamais la version transparente (fond noir en JPEG)
    expect(src.jpegFrom).toHaveLength(0)
  })

  it('repli PNG : transparence sans moyen d’aplatir, JPEG absent ou en échec', () => {
    expect(thumbDataURL(img(Buffer.from([0, 0, 0, 0, 0, 0, 0, 0])))).toBe('data:image/png;base64,UE5H')
    expect(thumbDataURL(img(Buffer.from([1, 1, 1, 255, 1, 1, 1, 255]), { toJPEG: undefined }))).toBe('data:image/png;base64,UE5H')
    expect(
      thumbDataURL(
        img(Buffer.from([1, 1, 1, 255, 1, 1, 1, 255]), {
          toJPEG: () => {
            throw new Error('encodeur absent')
          },
        })
      )
    ).toBe('data:image/png;base64,UE5H')
    // pixels de taille inattendue (écran Retina) : transparence inconnue, PNG
    expect(thumbDataURL(img(Buffer.from([1, 1, 1, 255])))).toBe('data:image/png;base64,UE5H')
  })

  it('flattenOnWhite : rien à faire sur une image opaque', () => {
    expect(flattenOnWhite(Buffer.from([1, 2, 3, 255]))).toBeNull()
    expect([...flattenOnWhite(Buffer.from([0, 0, 0, 0]))!]).toEqual([255, 255, 255, 255])
  })

  it('la surveillance transmet une miniature JPEG', async () => {
    const f = fakeClipboard({ raw: { 'public.png': Buffer.from('c') }, pixels: Buffer.from('p') })
    const opaque = img(Buffer.from([1, 1, 1, 255, 1, 1, 1, 255]))
    const clipboard: WatchedClipboard = { ...f.clipboard, readImage: () => ({ ...opaque, getSize: () => ({ width: 2, height: 1 }) }) }
    const { w, images } = watcher(clipboard)
    await w.tick()
    expect(images[0]?.thumb.startsWith('data:image/jpeg;base64,')).toBe(true)
  })
})
