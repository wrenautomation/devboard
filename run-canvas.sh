#!/usr/bin/env bash
# launchd entry for the canvas: serves the project named in ./current (default main).
DIR="$(cd "$(dirname "$0")" && pwd -P)"
name="$(cat "$DIR/current" 2>/dev/null || echo main)"
mkdir -p "$DIR/projects/$name"
EXCALIDRAW_PROJECTS_DIR="$DIR/projects" EXCALIDRAW_CURRENT_FILE="$DIR/current" \
  EXCALIDRAW_DATA_DIR="$DIR/projects/$name" exec "$NODE" "$DIR/app/dist/server.js"
