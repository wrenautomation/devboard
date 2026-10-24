# Splitting app/src/server.ts (2026-10-24)

`server.ts` was 2000 lines and eleven jobs: the Express app, the WebSocket fan-out, element
routes and arrow routing, files, image export, viewport, snapshots, notes to Claude Code
sessions, boards on disk, project routes, and startup. A pure move puts each job in
`app/src/server/<job>.ts`; route modules export `mount<Job>(app)` and `server.ts` mounts them in
the order the routes were registered before (Express matches in that order), keeps the
middleware, `/`, `/health`, `/api/sync/status`, the error handler and `startServer`, and exports
the same two names. Module state (pending exports, watchers, terminals) stays with its routes.
`boards.ts` (the board filesystem) sits under `ws.ts` (the scene message needs the open board),
so `projects.ts` imports both and no module imports in a cycle. Typecheck, build and the check
scripts are the gate before and after; the tripwire after the split: no source file over 1200 lines.

## App.tsx (same day)

`frontend/src/App.tsx` (1375 lines) is one component, so it splits along what is not the component:
`store.ts` (what this browser keeps: library, replicas, image files, the last board), `export.ts` (an
image export the server asked for, `exportForServer(api, request, ready)`), `viewport.ts` (a viewport
change the server asked for, `applyViewport(api, request, setView)`). The WebSocket handler calls them
and keeps the state they do not need. Pure move; vite build and the browser regression tests are the gate.
