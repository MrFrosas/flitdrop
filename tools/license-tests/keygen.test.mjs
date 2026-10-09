// Test du générateur de clés : node --test tools/license-tests/*.test.mjs
// Le script doit écrire la clé privée dans le fichier demandé (0600, jamais écrasé)
// et n'afficher que la clé publique, utilisable telle quelle par le serveur.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { publicKeyBase64 } from '../../functions/_lib/license/crypto.js'
import { readLicenseEnv } from '../../functions/_lib/license/config.js'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'license-keygen.mjs')
const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' })

test('keygen : clé privée dans le fichier, seule la clé publique à l’écran', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'flitdrop-keygen-'))
  try {
    const file = join(dir, 'cle.txt')
    const r = run(file)
    assert.equal(r.status, 0, r.stderr)
    const out = r.stdout.trim()
    assert.match(out, /^[A-Za-z0-9+/]{43}=$/, 'une seule ligne : 32 octets en base64')
    assert.equal(r.stdout.split('\n').filter(Boolean).length, 1)

    const secret = readFileSync(file, 'utf8').trim()
    assert.ok(!r.stdout.includes(secret) && !r.stderr.includes(secret), 'la clé privée n’est jamais affichée')
    assert.equal(statSync(file).mode & 0o777, 0o600)

    const priv = createPrivateKey({ key: Buffer.from(secret, 'base64'), format: 'der', type: 'pkcs8' })
    assert.equal(priv.asymmetricKeyType, 'ed25519')
    // la clé publique affichée vérifie une signature faite avec la clé privée du fichier
    const pub = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(out, 'base64').toString('base64url') }, format: 'jwk' })
    const msg = Buffer.from('flitdrop')
    assert.ok(verify(null, msg, pub, sign(null, msg, priv)))

    // le contenu du fichier se colle tel quel dans LICENSE_SIGNING_KEY
    assert.equal(await publicKeyBase64(secret), out)
    assert.equal(
      readLicenseEnv({
        LICENSE_ENABLED: '1',
        PADDLE_ENV: 'sandbox',
        PADDLE_API_KEY: 'pdl_sdbx_apikey_xxxxxxxxxxxxxxxx',
        PADDLE_CLIENT_TOKEN: 'test_abc',
        PADDLE_PRICE_ID: 'pri_abc',
        LICENSE_SIGNING_KEY: readFileSync(file, 'utf8'),
        RESEND_API_KEY: 're_x',
      }).enabled,
      true,
    )

    const again = run('--public', file)
    assert.equal(again.status, 0)
    assert.equal(again.stdout.trim(), out)

    const overwrite = run(file)
    assert.notEqual(overwrite.status, 0, 'refuse d’écraser')
    assert.equal(overwrite.stdout, '')
    assert.equal(readFileSync(file, 'utf8').trim(), secret)

    assert.notEqual(run().status, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
