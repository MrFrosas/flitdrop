import { spawn } from 'node:child_process'

function clipboardDisabled(): boolean {
  return process.env.FLITDROP_NO_CLIP === '1'
}

function run(cmd: string, args: string[], stdinText?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'ignore'] })
    let out = ''
    p.stdout.setEncoding('utf8')
    p.stdout.on('data', (d) => {
      if (out.length < 4 * 1024 * 1024) out += d
    })
    p.on('error', reject)
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} a retourné ${code}`))))
    if (stdinText !== undefined) p.stdin.end(stdinText, 'utf8')
    else p.stdin.end()
  })
}

export async function writeClipboard(text: string): Promise<void> {
  if (clipboardDisabled()) return
  if (process.platform === 'darwin') {
    await run('pbcopy', [], text)
  } else if (process.platform === 'win32') {
    await run(
      'powershell',
      ['-NoProfile', '-Command', '[Console]::InputEncoding=[System.Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())'],
      text
    )
  } else {
    await run('xclip', ['-selection', 'clipboard'], text)
  }
}

export async function readClipboard(): Promise<string> {
  if (clipboardDisabled()) return ''
  if (process.platform === 'darwin') {
    return run('pbpaste', [])
  } else if (process.platform === 'win32') {
    return run('powershell', [
      '-NoProfile',
      '-Command',
      '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Get-Clipboard -Raw',
    ])
  }
  return run('xclip', ['-selection', 'clipboard', '-o'])
}
