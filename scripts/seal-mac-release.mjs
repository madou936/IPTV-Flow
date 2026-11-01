import { existsSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const appPath = resolve(projectRoot, 'release/mac-arm64/IPTV Flow.app')

if (!existsSync(appPath)) {
  throw new Error(`Paquet macOS introuvable : ${appPath}`)
}

// ffprobe-static embarque aussi des exécutables Linux et Intel inutiles dans
// une build macOS Apple Silicon. Les retirer évite de distribuer ces binaires.
for (const relativePath of [
  'Contents/Resources/app.asar.unpacked/node_modules/ffprobe-static/bin/linux',
  'Contents/Resources/app.asar.unpacked/node_modules/ffprobe-static/bin/darwin/x64'
]) {
  rmSync(resolve(appPath, relativePath), { recursive: true, force: true })
}

// CastLabs requires production VMP signing before Apple's code signature.
// Keep the EVS tooling local to this project and allow an explicit override.
const evsPython = process.env.EVS_PYTHON || resolve(projectRoot, 'native/evs-venv/bin/python3')
if (!existsSync(evsPython)) {
  throw new Error(`Outil CastLabs EVS introuvable : ${evsPython}`)
}
execFileSync(evsPython, ['-m', 'castlabs_evs.vmp', 'sign-pkg', resolve(projectRoot, 'release/mac-arm64')], {
  stdio: 'inherit'
})

execFileSync('codesign', ['--force', '--deep', '--sign', '-', '--timestamp=none', appPath], {
  stdio: 'inherit'
})
execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath], {
  stdio: 'inherit'
})
