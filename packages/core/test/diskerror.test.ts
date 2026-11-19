import { describe, it, expect } from 'vitest'
import { diskErrorKey } from '../src/transfers.js'
import { t } from '../src/i18n.js'

const err = (code?: string) => Object.assign(new Error('x'), code ? { code } : {})

describe('échec d’écriture : la cause est dite au téléphone', () => {
  it('disque plein, dossier interdit, autre', () => {
    expect(diskErrorKey(err('ENOSPC'))).toBe('diskFull')
    expect(diskErrorKey(err('EDQUOT'))).toBe('diskFull')
    for (const c of ['EPERM', 'EACCES', 'EROFS']) expect(diskErrorKey(err(c))).toBe('diskDenied')
    expect(diskErrorKey(err('EIO'))).toBe('diskWrite')
    expect(diskErrorKey(err())).toBe('diskWrite')
    expect(diskErrorKey(null)).toBe('diskWrite')
  })
  it('un message dans chaque langue', () => {
    for (const lang of ['en', 'fr', 'de'] as const) {
      for (const k of ['err.diskFull', 'err.diskDenied']) expect(t(lang, k)).not.toBe(k)
    }
  })
})
