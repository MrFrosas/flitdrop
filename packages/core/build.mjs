import * as esbuild from 'esbuild'
import { readFileSync } from 'node:fs'

const mode = process.argv[2] ?? 'all'

// version unique source de vérité = package.json (injectée à la compilation),
// pour que le footer et les échanges reflètent toujours la vraie version publiée.
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
const versionDefine = { __FLITDROP_VERSION__: JSON.stringify(pkg.version) }

const webTargets = [
  { entry: 'src/webclient/phone.ts', out: 'public/phone/app.js' },
  { entry: 'src/webclient/desktop.ts', out: 'public/desktop/app.js' },
]

async function buildWeb() {
  for (const t of webTargets) {
    await esbuild.build({
      entryPoints: [t.entry],
      outfile: t.out,
      bundle: true,
      format: 'iife',
      minify: true,
      target: ['es2020', 'safari15'],
      define: versionDefine,
      logLevel: 'warning',
    })
  }
}

async function buildNode() {
  const common = {
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['bufferutil', 'utf-8-validate'],
    banner: { js: "const __import_meta_url = require('url').pathToFileURL(__filename).href;" },
    define: { 'import.meta.url': '__import_meta_url', ...versionDefine },
    logLevel: 'warning',
  }
  await esbuild.build({ ...common, entryPoints: ['src/server.ts'], outfile: 'dist/flitdrop.cjs' })
  await esbuild.build({ ...common, entryPoints: ['src/index.ts'], outfile: 'dist/cli.cjs' })
}

if (mode === 'web') {
  await buildWeb()
} else {
  await buildWeb()
  await buildNode()
}
console.log(`build ${mode} ok`)
