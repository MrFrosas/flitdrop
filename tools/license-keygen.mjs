#!/usr/bin/env node
// Génère la paire de clés Ed25519 des licences Flitdrop Pro.
//
//   node tools/license-keygen.mjs <fichier>
//     Écrit la clé PRIVÉE (PKCS8 DER en base64, une ligne) dans <fichier>, créé en
//     lecture seule pour son propriétaire et jamais écrasé, puis affiche UNIQUEMENT la
//     clé PUBLIQUE (32 octets bruts en base64) à embarquer dans l'app.
//     Le contenu du fichier se colle tel quel dans le secret LICENSE_SIGNING_KEY de
//     Cloudflare Pages, puis le fichier se range hors du dépôt (gestionnaire de mots
//     de passe). Voir docs/licence.md.
//
//   node tools/license-keygen.mjs --public <fichier>
//     Réaffiche la clé publique d'une clé privée existante (rien d'autre).
import { generateKeyPairSync, createPrivateKey, createPublicKey } from 'node:crypto'
import { writeFileSync, readFileSync } from 'node:fs'

function publicRawBase64(privateKey) {
  const { x } = createPublicKey(privateKey).export({ format: 'jwk' })
  return Buffer.from(x, 'base64url').toString('base64')
}

function fail(message) {
  process.stderr.write(message + '\n')
  process.exit(1)
}

const args = process.argv.slice(2)

if (args[0] === '--public') {
  if (!args[1]) fail('Usage : node tools/license-keygen.mjs --public <fichier-cle-privee>')
  let key
  try {
    const b64 = readFileSync(args[1], 'utf8').replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '')
    key = createPrivateKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'pkcs8' })
  } catch {
    fail('Clé privée illisible.')
  }
  if (key.asymmetricKeyType !== 'ed25519') fail("Ce n'est pas une clé Ed25519.")
  process.stdout.write(publicRawBase64(key) + '\n')
} else {
  const out = args[0]
  if (!out || out.startsWith('-')) fail('Usage : node tools/license-keygen.mjs <fichier-cle-privee>')
  const { privateKey } = generateKeyPairSync('ed25519')
  const der = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64')
  try {
    // « wx » : refuse d'écraser une clé existante ; 0600 : lisible par son seul propriétaire
    writeFileSync(out, der + '\n', { flag: 'wx', mode: 0o600 })
  } catch (err) {
    fail(err && err.code === 'EEXIST' ? 'Ce fichier existe déjà : rien écrit.' : "Impossible d'écrire le fichier.")
  }
  process.stdout.write(publicRawBase64(privateKey) + '\n')
}
