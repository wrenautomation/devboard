#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process'
// launchd entry for the three agents: `agent.mjs canvas | tunnel | backup`.
// Node, not bash: macOS lets launchd's node read ~/Documents, but not /bin/bash (same as autobrowse's agents).
//   canvas  serves the project named in ./current (default main) on $HOST:$PORT.
//   tunnel  cloudflared for draw.wrenautomation.com, token from ./tunnel.token.
//   backup  commits changed boards in ./projects (its own private repo, devboard-boards) and pushes.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const mode = process.argv[2]

if (mode === 'canvas') {
  const name =
    (() => {
      try {
        return fs.readFileSync(path.join(DIR, 'current'), 'utf8').trim()
      } catch {
        return ''
      }
    })() || 'main'
  fs.mkdirSync(path.join(DIR, 'projects', name), { recursive: true })
  Object.assign(process.env, {
    EXCALIDRAW_PROJECTS_DIR: path.join(DIR, 'projects'),
    EXCALIDRAW_CURRENT_FILE: path.join(DIR, 'current'),
    EXCALIDRAW_DATA_DIR: path.join(DIR, 'projects', name),
  })
  const { startServer } = await import(path.join(DIR, 'app/dist/server.js'))
  await startServer()
} else if (mode === 'tunnel') {
  const token = fs.readFileSync(path.join(DIR, 'tunnel.token'), 'utf8').trim()
  const child = spawn(process.env.CLOUDFLARED ?? 'cloudflared', ['tunnel', '--no-autoupdate', 'run'], {
    stdio: 'inherit',
    env: { ...process.env, TUNNEL_TOKEN: token },
  })
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => child.kill(sig))
  child.on('exit', code => process.exit(code ?? 1))
} else if (mode === 'backup') {
  const git = (...a) => execFileSync('git', a, { cwd: path.join(DIR, 'projects'), encoding: 'utf8' })
  for (const f of fs.readdirSync(path.join(DIR, 'projects'), { recursive: true })) {
    if (path.basename(f) === 'canvas-state-v1.json' && !f.startsWith('.git'))
      JSON.parse(fs.readFileSync(path.join(DIR, 'projects', f), 'utf8')) // a broken board stops the backup
  }
  git('add', '-A')
  try {
    git('diff', '--cached', '--quiet')
    console.log(`${new Date().toISOString()} no board changes`)
    process.exit(0)
  } catch {}
  const day = new Date().toISOString().slice(0, 10)
  git(
    '-c',
    'user.name=William Jin',
    '-c',
    'user.email=jinwilliam.jin@gmail.com',
    'commit',
    '-q',
    '-m',
    `boards: ${day}`,
  )
  git('push', '-q', 'origin', 'HEAD')
  console.log(`${new Date().toISOString()} pushed boards ${day}`)
} else {
  console.error('usage: agent.mjs canvas | tunnel | backup')
  process.exit(2)
}
