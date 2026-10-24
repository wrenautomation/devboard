// Devboard terminal: the canvas (127.0.0.1:3100) presses Enter in the terminal that runs a Claude Code session,
// so a message typed there goes in with a note sent from the iPad. Each window holds GET /api/terminals open with
// the shell pids of its terminals; the canvas sends { pid } when a note asks for Enter in that shell.
const vscode = require('vscode')
const http = require('node:http')

const CANVAS = process.env.DEVBOARD_CANVAS ?? 'http://127.0.0.1:3100'

function activate(context) {
  let req,
    timer,
    stopped = false
  const press = async pid => {
    for (const t of vscode.window.terminals) if ((await t.processId) === pid) t.sendText('', true)
  }
  const later = ms => {
    clearTimeout(timer)
    if (!stopped) timer = setTimeout(connect, ms)
  }
  async function connect() {
    req?.destroy()
    const pids = (await Promise.all(vscode.window.terminals.map(t => t.processId))).filter(Boolean)
    const mine = http.get(`${CANVAS}/api/terminals?pids=${pids.join(',')}`, res => {
      let buf = ''
      res.setEncoding('utf8')
      res.on('data', chunk => {
        buf += chunk
        for (let end = buf.indexOf('\n\n'); end >= 0; end = buf.indexOf('\n\n')) {
          const line = buf
            .slice(0, end)
            .split('\n')
            .find(l => l.startsWith('data: '))
          buf = buf.slice(end + 2)
          if (line) {
            try {
              void press(JSON.parse(line.slice(6)).pid)
            } catch {}
          }
        }
      })
      res.on('end', () => {
        if (req === mine) later(5000)
      })
    })
    req = mine
    mine.on('error', () => {
      if (req === mine) later(5000)
    })
  }
  context.subscriptions.push(
    vscode.window.onDidOpenTerminal(() => later(300)),
    vscode.window.onDidCloseTerminal(() => later(300)),
    {
      dispose: () => {
        stopped = true
        clearTimeout(timer)
        req?.destroy()
      },
    },
  )
  void connect()
}

module.exports = { activate, deactivate() {} }
