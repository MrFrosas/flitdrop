import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClipboardWatcher, rawImageFormats, type WatchedClipboard, type WatchedImage } from '../src/clipwatch.js'

// Faux presse-papiers : compte les décodages (readImage) et les réencodages
// (toPNG), le vrai coût mesuré sur Mac quand une capture reste copiée.
function fakeClipboard(opts: { raw?: Record<string, Buffer>; pixels?: Buffer; formats?: string[] } = {}) {
  const count = { readImage: 0, toPNG: 0, readBuffer: 0 }
  const state = { raw: opts.raw ?? {}, pixels: opts.pixels ?? Buffer.alloc(0), formats: opts.formats ?? ['image/png'] }
  const makeImage = (): WatchedImage => ({
    isEmpty: () => state.pixels.length === 0,
    getSize: () => ({ width: 400, height: 300 }),
    toPNG: () => {
      count.toPNG++
      return Buffer.concat([Buffer.from('png:'), state.pixels])
    },
    toBitmap: () => Buffer.from(state.pixels),
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
  const images: Array<{ png: Buffer; w: number }> = []
  const checkText = vi.fn(async () => {})
  const w = new ClipboardWatcher({
    clipboard,
    platform: 'darwin',
    checkText,
    imagesEnabled: () => true,
    anyEnabled: () => true,
    onImage: (png, _thumb, width) => images.push({ png, w: width }),
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
    w.pause()
    checkText.mockClear()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(checkText).not.toHaveBeenCalled()
    // filet de sécurité : un coup d'oeil par minute même en pause
    await vi.advanceTimersByTimeAsync(30_000)
    expect(checkText).toHaveBeenCalledTimes(1)
    checkText.mockClear()
    w.resume()
    await vi.advanceTimersByTimeAsync(0)
    expect(checkText).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1500)
    expect(checkText).toHaveBeenCalledTimes(2)
    w.stop()
    checkText.mockClear()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(checkText).not.toHaveBeenCalled()
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
