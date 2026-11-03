# Board pins and fast switch (2026-11-02)

## Problem

1. One board is open at a time. `draw` wrote to whichever board was open. William switched boards while an agent drew, and six films landed on the wrong board.
2. A switch sent the whole board: Strata 2.47 MB (images inline), Birdwatch system 2.2 MB (pen points). On an iPad: 2–3 s.

## Board pins

| | How | Problem |
|---|---|---|
| A. Lock | No switch while a command runs | A job is many commands; William gets blocked or the switch lands between two |
| B. Check, then write | CLI reads the open board, then writes | The switch can land between the check and the write |
| **C. Commands name their board (chosen)** | Every request carries `x-canvas-project`; the server refuses it while another board is open | Commands must know their board: autofilled |
| D. Write to closed boards | The server applies writes to any board | Ideal: a switch never stops an agent. Needs per-board stores in place of the one global store and lock (`canvas-persistence.ts`, ~1000 lines). Not now: risk to every write path |

Priorities: never a write on the wrong board > William never blocked > no agent effort. C meets all three. D is the follow-up if refusals get in the way.

- `bin/draw` picks the board: `--board`, else `DRAW_BOARD`, else the Claude session's pin (`pins/<CLAUDE_CODE_SESSION_ID>`), else the open board, pinned on the session's first command. `draw project open` moves the pin.
- `bin.ts` adds the header to every canvas request. `server.ts` checks it in one place, before every `/api` route except projects, media and notes. Node runs one request at a time, so the check and the write are one step.
- Refused: HTTP 409, exit 1, `board "X" is not open ("Y" is). Wait for it, or run: draw project open "X"`.
- A tab's pushes carry the same header, so a tab on an old board is refused the same way.

## Switch

- Images by id: the scene names file ids; the tab reads each from IndexedDB, else `GET /api/files/:id[?board=]` (immutable cache).
- Deltas: `POST /api/projects/scene {name, have}` (tab only). `have` = the stamps (`version:nonce`) the tab holds unchanged. The reply holds every id and only the elements that differ. Works for closed boards (parsed state file, cached by mtime). Tabs connect with `?scene=pull`: no full scene on connect or switch.
- Instant: on tap, the tab draws the board's replica, then posts the switch, then merges the delta. Agent edits for the old board that arrive in that window are skipped; the pull brings the truth.
- Preload: 4 s after a scene lands, at most once a minute, the six most recent boards are pulled into their replicas, with their images. A board with unsent edits is skipped.
- Thumbnails: not awaited; skipped when the board is unchanged.
- Compact: pen points rounded to 0.01 px on disk, on load and on the wire (half of a handwriting board).
- gzip/brotli on JSON replies (`compression`), deflate on WebSocket.

Result (emulated iPad, 4x CPU, 20 Mbps, 60 ms): Strata 2.5 s → 0.27 s; Birdwatch system 1.8 s → 0.33 s, pull 0 of 1332 changed.

## Switch, round 2

William: a switch still took seconds on the iPad. Bench (`app/scripts/switch-bench.mjs`): each switch drew the board twice, and the main thread was blocked 0.6–2.3 s.

- Cost: IndexedDB read 180–470 ms (it clones the whole board); a second full convert 180–310 ms; an extra `GET /api/projects` 160–430 ms; the open round trip waited 0.6–1.6 s behind the busy main thread.
- Memory replicas: an LRU of 8 boards in front of IndexedDB.
- One draw: the preview draws the replica as stored, with no convert. If the pull finds no change, that draw is final.
- `Replica.measured`: true when text was sized with this device's loaded fonts. An unmeasured replica gets one full apply, so the Safari clip fix (2d33d62) still holds.
- Open and pull run in parallel. Board pins (409) keep the closed board free of writes.
- Loader: `BoardLoading` covers the canvas only when no replica exists. It fades in after 150 ms, so a fast switch never shows it.
- Sheet closes at tap; a failure opens it again with the error.

Result, from the click event: final scene 1.2–1.8 s → 25–170 ms; main thread blocked up to 2.3 s → 0–370 ms. The first visit to a board whose replica is unmeasured draws twice.
