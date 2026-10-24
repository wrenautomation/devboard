#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
// Local patch: `draw watch [--name x] [--all] [--once]`. Holds the canvas event stream open and prints one
// line per note sent from the canvas. Run it with Claude Code's Monitor tool: each line wakes the session.
// --once exits after the first note (and any sent within 300ms): for a background Bash task, which wakes
// the session when it exits and costs nothing while it waits. The session starts it again after each note.
// It reconnects by itself and keeps the last note id in watch/<name>.last, so a restart gets missed notes.
// It exits when its shell ends, and a new --once start replaces a watcher whose shell is gone.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const flag = k => {
  const i = args.indexOf(k)
  return i >= 0 ? args[i + 1] : undefined
}
const name = flag('--name') ?? 'session'
if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(name)) {
  console.error('--name: lowercase letters, digits, dashes')
  process.exit(2)
}
const url = process.env.EXPRESS_SERVER_URL ?? 'http://127.0.0.1:3100'
const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../watch')
const lastFile = path.join(dir, `${name}.last`)
fs.mkdirSync(dir, { recursive: true })
// First run starts from now; --all replays the kept history.
const saved = (() => {
  try {
    return Number(fs.readFileSync(lastFile, 'utf8').trim())
  } catch {
    return NaN
  }
})()
const once = args.includes('--once')
// One --once watcher per name: a session that starts it twice (resume, compact) gets one wake per note.
const pidFile = path.join(dir, `${name}.pid`)
if (once) {
  const other = (() => {
    try {
      return Number(fs.readFileSync(pidFile, 'utf8'))
    } catch {
      return 0
    }
  })()
  const alive = (() => {
    try {
      if (!(other > 0 && other !== process.pid)) return false
      process.kill(other, 0)
      return true
    } catch {
      return false
    }
  })()
  // A watcher whose shell died (ppid 1) still holds the stream but wakes no session: stop it and take over.
  const orphan =
    alive &&
    (() => {
      try {
        return Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(other)], { encoding: 'utf8' })) <= 1
      } catch {
        return true
      }
    })()
  if (orphan) {
    try {
      process.kill(other)
    } catch {}
  } else if (alive) {
    console.log(`[canvas watch] already listening as ${name}`)
    process.exit(0)
  }
  fs.writeFileSync(pidFile, String(process.pid))
  process.on('exit', () => {
    try {
      if (Number(fs.readFileSync(pidFile, 'utf8')) === process.pid) fs.rmSync(pidFile)
    } catch {}
  })
}
// Stop when the shell that started this ends; its output reaches no one after that.
const parent = process.ppid
setInterval(() => {
  if (process.ppid !== parent) process.exit(0)
}, 2000).unref()
let last = args.includes('--all') ? 0 : saved || Date.now()

const show = n => {
  const what = n.area ? 'marked area' : n.ids.length ? `${n.ids.length} shape(s)` : 'no shapes'
  const box = n.box ? ` at x${n.box.x} y${n.box.y} ${n.box.w}x${n.box.h}` : ''
  const look = n.area
    ? ` Look: draw screenshot --area ${n.box.x},${n.box.y},${n.box.w},${n.box.h} --out /tmp/note-${n.id}.png`
    : n.ids.length
      ? ` Look: draw screenshot --ids ${n.ids.join(',')} --out /tmp/note-${n.id}.png`
      : ' Look: draw describe'
  console.log(
    `[canvas note ${n.id}] project ${n.project}${n.to ? ` to @${n.to}` : ''}, ${what}${box}: "${n.text || '(no text)'}".${look}`,
  )
  last = n.id
  fs.writeFileSync(lastFile, `${last}\n`)
  if (once) setTimeout(() => process.exit(0), 300)
}

let down = false
for (let wait = 1000; ; wait = Math.min(wait * 2, 30000)) {
  try {
    const res = await fetch(`${url}/api/events?name=${name}`, { headers: { 'last-event-id': String(last) } })
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
    if (down && !once) console.log(`[canvas watch] connected again as ${name}`)
    else console.error(`[canvas watch] watching as ${name}`)
    down = false
    wait = 500
    let buf = ''
    for await (const chunk of res.body) {
      buf += Buffer.from(chunk).toString('utf8')
      for (let end = buf.indexOf('\n\n'); end >= 0; end = buf.indexOf('\n\n')) {
        const block = buf.slice(0, end)
        buf = buf.slice(end + 2)
        const data = block
          .split('\n')
          .filter(l => l.startsWith('data: '))
          .map(l => l.slice(6))
          .join('\n')
        if (data) {
          try {
            show(JSON.parse(data))
          } catch {}
        }
      }
    }
    throw new Error('stream ended')
  } catch (e) {
    if (!down && !once) console.log(`[canvas watch] lost the canvas (${e.message}); trying again`)
    down = true
  }
  await new Promise(r => setTimeout(r, wait))
}
