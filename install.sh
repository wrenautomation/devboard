#!/usr/bin/env bash
# Devboard: Excalidraw canvas for iPad pair-designing with Claude Code sessions, under launchd (up at login, restarted on exit).
#   install.sh          write the two agents and start them
#   install.sh remove   stop them and delete the agents
# canvas  127.0.0.1:3100  mcp_excalidraw built from source in ./app (8084a1c + local commits: library in IndexedDB, /lib/ URLs allowed, project picker; the npm 2.1.2
#         release has no disk persistence). State in ./projects/<name>; ./current names the open one
#         (agent.mjs canvas reads it at start; the page dropdown and `draw project` switch in place).
#         ./library/wren.excalidrawlib (brand logos + catalog sets, built by library/brands.js + merge.py) is
#         served at /lib/; import it once per browser with /#addLibrary=<that url>.
# tunnel  draw.wrenautomation.com → canvas, Cloudflare tunnel "wren-canvas", token in tunnel.token.
#         Cloudflare Access app "Excalidraw canvas" (team little-hill-c547) lets in jinwilliam.jin@gmail.com
#         by emailed code; the tunnel route requires its Access JWT (originRequest.access), so nothing else gets through.
# backup  nightly 03:30: agent.mjs backup commits ./projects and pushes (private repo wrenautomation/devboard).
# Repo layout: app/ = the mcp_excalidraw fork (history kept; upstream remote = yctimlin), bin/draw (linked to
#         ~/.local/bin/draw and devboard), skill/excalidraw-skill (linked to ~/.claude/skills), library/, projects/.
# All three run `node agent.mjs <mode>`: launchd's bash may not read ~/Documents, node may.
# Logs: ~/Library/Logs/excalidraw-canvas*.log, devboard-backup.log
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd -P)"
DOMAIN="gui/$(id -u)"
AGENTS="$HOME/Library/LaunchAgents"
NODE="$(realpath "$(command -v node)")"
APP="$DIR/app"
mkdir -p "$AGENTS" "$HOME/Library/Logs"

agent() { # label, log name, extra env xml, program args... (SCHEDULE: launchd keys; default = always up)
  local label="com.wrenautomation.$1" log="$2" env="$3"; shift 3
  local SCHEDULE="${SCHEDULE:-<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>}"
  local args=""; for a in "$@"; do args+="<string>$a</string>"; done
  launchctl bootout "$DOMAIN/$label" 2>/dev/null || true
  for _ in $(seq 50); do launchctl print "$DOMAIN/$label" >/dev/null 2>&1 || break; sleep 0.2; done
  [ "${MODE:-}" = remove ] && { rm -f "$AGENTS/$label.plist"; return; }
  cat > "$AGENTS/$label.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key><array>$args</array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>EnvironmentVariables</key><dict>$env</dict>
  $SCHEDULE
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/$log.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/$log.log</string>
</dict>
</plist>
PLIST
  launchctl bootstrap "$DOMAIN" "$AGENTS/$label.plist"
}

MODE="${1:-}"
if [ "$MODE" != remove ]; then
  [ -f "$APP/dist/server.js" ] || (cd "$APP" && npm ci --no-audit --no-fund --ignore-scripts && npm run build)
  ln -sfn "$DIR/library" "$APP/dist/frontend/lib"
  [ -f "$DIR/current" ] || echo main > "$DIR/current"
fi
# draw.wrenautomation.com/* has a no-Worker route (wren deploy/scripts/custom-domains.sh): without it
# wren-portal's `*/*` route serves its own /assets/* and the page is white.
P="<key>PATH</key><string>$(dirname "$NODE"):/opt/homebrew/bin:/usr/bin:/bin</string>"
agent excalidraw-canvas excalidraw-canvas \
  "$P<key>HOST</key><string>127.0.0.1</string><key>PORT</key><string>3100</string>" "$NODE" "$DIR/agent.mjs" canvas
agent excalidraw-canvas-tunnel excalidraw-canvas-tunnel \
  "$P<key>CLOUDFLARED</key><string>$(command -v cloudflared)</string>" "$NODE" "$DIR/agent.mjs" tunnel
SCHEDULE="<key>StartCalendarInterval</key><dict><key>Hour</key><integer>3</integer><key>Minute</key><integer>30</integer></dict>" \
  agent devboard-backup devboard-backup "$P" "$NODE" "$DIR/agent.mjs" backup
echo "${MODE:-installed}"
