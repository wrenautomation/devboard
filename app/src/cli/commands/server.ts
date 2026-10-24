import { parseArgs } from '../args.js';
import { CodedError } from '../../core/errors.js';
import { printJson, note } from '../util.js';
import { ensureCanvasRunning, stopCanvas, canvasPort, isCanvasHealth, foreignServiceError } from '../../core/spawn.js';
import { getHealth, getSyncStatus, type HealthStatus } from '../../core/canvas-client.js';
import { EXPRESS_SERVER_URL } from '../../core/config.js';
import { readPidFile } from '../../core/pidfile.js';

export async function start(argv: string[]): Promise<void> {
  parseArgs(argv, {});

  // Explicit start is user intent — it overrides the auto-start opt-outs
  const result = await ensureCanvasRunning({ force: true });
  if (!result.spawned) {
    note(`Canvas server already running at ${result.url}`);
  }
  printJson({
    running: true,
    url: result.url,
    spawned: result.spawned,
    pid: readPidFile(canvasPort()) ?? undefined
  });
}

export async function stop(argv: string[]): Promise<void> {
  parseArgs(argv, {});
  const result = await stopCanvas();
  printJson(result);
}

export async function status(argv: string[]): Promise<void> {
  parseArgs(argv, {});

  let health: HealthStatus;
  try {
    health = await getHealth();
  } catch {
    printJson({ running: false, url: EXPRESS_SERVER_URL });
    // quiet: the JSON above already tells the story
    throw new CodedError(`Canvas server is not running at ${EXPRESS_SERVER_URL}`, 'CANVAS_UNREACHABLE', true);
  }

  if (!isCanvasHealth(health)) {
    printJson({
      running: false,
      url: EXPRESS_SERVER_URL,
      conflict: 'another service (or a pre-1.1 canvas build) is answering at this URL'
    });
    throw foreignServiceError(true);
  }

  let sync: Record<string, unknown> = {};
  try {
    sync = await getSyncStatus();
  } catch { /* health is enough */ }

  printJson({
    running: true,
    url: EXPRESS_SERVER_URL,
    // Prefer the pid the server reports about itself; the pidfile can be stale
    pid: health.pid ?? readPidFile(canvasPort()) ?? undefined,
    elements: health.elements_count,
    browserClients: health.websocket_clients,
    // Older servers predate the headless renderer and only report tabs
    renderers: health.renderers ?? { node: false, browser: health.websocket_clients },
    ...sync
  });
}
