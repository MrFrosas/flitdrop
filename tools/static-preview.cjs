// Serveur statique minimal pour prévisualiser la page téléphone.
// N'appelle jamais process.cwd() : le sandbox le bloque parfois.
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.argv[2]
const PORT = Number(process.argv[3] || 8199)

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
}

http
  .createServer((req, res) => {
    let rel = decodeURIComponent((req.url || '/').split('?')[0])
    if (rel.endsWith('/')) rel += 'index.html'
    const abs = path.join(ROOT, rel)
    if (!abs.startsWith(ROOT)) {
      res.writeHead(403).end('forbidden')
      return
    }
    fs.readFile(abs, (err, buf) => {
      if (err) {
        res.writeHead(404).end('not found')
        return
      }
      res.writeHead(200, { 'content-type': MIME[path.extname(abs)] || 'application/octet-stream' })
      res.end(buf)
    })
  })
  .listen(PORT, '127.0.0.1', () => {
    console.log(`static preview on http://127.0.0.1:${PORT} root=${ROOT}`)
  })
