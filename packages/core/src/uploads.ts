import Busboy from 'busboy'
import fs from 'node:fs'
import path from 'node:path'
import { randomToken } from './crypto.js'
import type { Request } from 'express'
import { sanitizeFilename, reserveUniquePath } from './util.js'

export interface SavedFile {
  name: string
  path: string
  size: number
  mime?: string
}

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/heic': 'heic',
  'image/heif': 'heic',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/quicktime': 'mov',
  'video/mp4': 'mp4',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
}

function fallbackName(mime: string | undefined): string {
  const ext = (mime && EXT_BY_MIME[mime.toLowerCase()]) || 'bin'
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)
  // suffixe aléatoire : deux fichiers sans nom, même mime, même requête, ne
  // doivent pas produire le même nom de base.
  return `recu-${stamp}-${randomToken(3)}.${ext}`
}

/** Reçoit un envoi multipart (Raccourci iOS ou interface PC) et écrit chaque
 *  fichier directement dans destDir sous un nom sûr et unique. */
export function saveMultipartFiles(req: Request, destDir: string, maxFileBytes: number): Promise<SavedFile[]> {
  fs.mkdirSync(destDir, { recursive: true })
  return new Promise((resolve, reject) => {
    let bb: ReturnType<typeof Busboy>
    try {
      bb = Busboy({ headers: req.headers, limits: { fileSize: maxFileBytes, files: 20, fields: 10 } })
    } catch (e) {
      return reject(new Error('multipart invalide'))
    }
    const saved: SavedFile[] = []
    const pending: Promise<void>[] = []
    let errored = false

    const fail = (err: Error & { code?: number }) => {
      if (errored) return
      errored = true
      req.unpipe(bb)
      for (const f of saved) fs.unlink(f.path, () => {})
      reject(err)
    }

    bb.on('file', (_field, stream, info) => {
      const rawName = typeof info.filename === 'string' ? info.filename : ''
      const name = rawName ? sanitizeFilename(rawName) : fallbackName(info.mimeType)
      // réservation atomique : le nom est posé sur disque avant l'écriture, donc
      // deux parties du même nom dans la même requête ne se marchent pas dessus.
      let finalPath: string
      let ws: fs.WriteStream
      try {
        const reserved = reserveUniquePath(destDir, name)
        finalPath = reserved.path
        ws = fs.createWriteStream('', { fd: reserved.fd })
      } catch (e) {
        stream.resume()
        return fail(Object.assign(new Error('impossible d’écrire le fichier'), { code: 500 }))
      }
      let size = 0
      stream.on('data', (d: Buffer) => {
        size += d.length
      })
      stream.on('limit', () => {
        ws.destroy()
        fs.unlink(finalPath, () => {})
        fail(Object.assign(new Error('fichier trop volumineux'), { code: 413 }))
      })
      pending.push(
        new Promise<void>((res, rej) => {
          stream.pipe(ws)
          ws.on('finish', () => {
            if (errored) {
              fs.unlink(finalPath, () => {})
              return res()
            }
            saved.push({ name: path.basename(finalPath), path: finalPath, size, mime: info.mimeType })
            res()
          })
          ws.on('error', rej)
        })
      )
    })
    bb.on('error', () => fail(new Error('flux multipart interrompu')))
    bb.on('close', () => {
      Promise.all(pending)
        .then(() => {
          if (!errored) resolve(saved)
        })
        .catch((e) => fail(e))
    })
    req.pipe(bb)
  })
}
