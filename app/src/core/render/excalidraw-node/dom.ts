// Run Excalidraw's exporter in Node by giving it the browser globals it
// expects. The exporter builds its SVG through document.createElementNS and
// roughjs's SVG mode, both of which jsdom provides. The remaining gaps are
// small and stubbed here:
//   - FontFace / document.fonts: Excalidraw constructs FontFace objects when it
//     reads font metrics; with skipInliningFonts nothing is ever fetched.
//   - HTMLCanvasElement#getContext: jsdom has no 2D canvas. Excalidraw measures
//     text to size and wrap labels; the stub answers measureText from the
//     bundled TTFs' real advance widths (see text-metrics.ts).
//   - matchMedia / ResizeObserver: touched at module scope by the editor code
//     that the bundle still contains.
// Everything is installed once and the bundle is imported once per process.

import { JSDOM, VirtualConsole } from 'jsdom';
import type { ExcalidrawFile, ServerElement } from '../../../types.js';
import { measureTextWidth } from '../text-metrics.js';

// The bundle's exports, as far as the renderer calls them. Elements are the server's loose element type.
export interface ExcalidrawNodeModule {
  exportToSvg: (opts: {
    elements: readonly ServerElement[];
    appState?: Record<string, unknown>;
    files: Record<string, ExcalidrawFile> | null;
    exportPadding?: number;
    renderEmbeddables?: boolean;
    exportingFrame?: ServerElement | null;
    skipInliningFonts?: true;
    reuseImages?: boolean;
  }) => Promise<SVGSVGElement>;
  restoreElements: (
    elements: readonly ServerElement[] | null | undefined,
    localElements: readonly ServerElement[] | null | undefined,
    opts?: { refreshDimensions?: boolean; repairBindings?: boolean }
  ) => ServerElement[];
  getCommonBounds: (elements: readonly ServerElement[]) => [number, number, number, number];
  serializeAsJSON: (
    elements: readonly ServerElement[], appState: Record<string, unknown>, files: Record<string, ExcalidrawFile>, type: 'local'
  ) => string;
  elementsOverlappingBBox: (options: {
    elements: readonly ServerElement[]; bounds: ServerElement; type: 'overlap';
  }) => ServerElement[];
  FONT_FAMILY: Record<string, number>;
  // The canvas tab's own scene preparation (frontend/src/utils/scene.ts)
  prepareServerScene: (elements: readonly ServerElement[]) => ServerElement[];
  cleanElementForExcalidraw: (element: ServerElement) => ServerElement;
}

// jsdom's window with the browser globals the exporter touches stubbed onto it; typed loosely on purpose.
// biome-ignore lint/suspicious/noExplicitAny: the shim writes fields jsdom's Window type does not declare
type ShimWindow = any;

let modulePromise: Promise<ExcalidrawNodeModule> | null = null;
let domWindow: ShimWindow | null = null;

function installGlobals(): ShimWindow {
  if (domWindow) return domWindow;

  // Swallow jsdom's "not implemented" noise; real errors still surface as
  // exceptions from the exporter.
  const virtualConsole = new VirtualConsole();
  const dom = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>', {
    pretendToBeVisual: true,
    url: 'http://127.0.0.1/',
    virtualConsole
  });
  const win: ShimWindow = dom.window;

  class FontFaceStub {
    family: string;
    status = 'loaded';
    style: string;
    weight: string;
    unicodeRange: string;
    display: string;
    constructor(family: string, _source: unknown, descriptors: Record<string, string> = {}) {
      this.family = family;
      this.style = descriptors.style ?? 'normal';
      this.weight = descriptors.weight ?? '400';
      this.unicodeRange = descriptors.unicodeRange ?? 'U+0-10FFFF';
      this.display = descriptors.display ?? 'swap';
    }
    load(): Promise<FontFaceStub> { return Promise.resolve(this); }
  }
  const fontSet = {
    has: () => true,
    add: () => fontSet,
    delete: () => true,
    check: () => true,
    load: async () => [],
    ready: Promise.resolve(),
    [Symbol.iterator]: function* () { /* no faces registered */ }
  };
  win.FontFace = FontFaceStub;
  Object.defineProperty(win.document, 'fonts', { value: fontSet, configurable: true });

  win.HTMLCanvasElement.prototype.getContext = function getContext() {
    let font = '10px sans-serif';
    return {
      get font() { return font; },
      set font(value: string) { font = value; },
      measureText(text: string) {
        return { width: measureTextWidth(text, font) };
      },
      save() {}, restore() {}, scale() {}, translate() {}, rotate() {},
      beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, stroke() {}, fill() {},
      fillRect() {}, clearRect() {}, drawImage() {}, setTransform() {}, clip() {},
      getImageData() { return { data: new Uint8ClampedArray(4) }; }
    };
  };

  // The shape cache builds a Path2D per freedraw element for canvas hit-testing
  // even during SVG export; the SVG path itself comes from getFreeDrawSvgPath.
  if (!win.Path2D) {
    win.Path2D = class Path2D {
      d: string;
      constructor(d: string | Path2D = '') { this.d = typeof d === 'string' ? d : d.d; }
      addPath() {} moveTo() {} lineTo() {} closePath() {} rect() {} arc() {}
      bezierCurveTo() {} quadraticCurveTo() {}
    };
  }

  win.matchMedia = () => ({
    matches: false, media: '', onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; }
  });
  if (!win.ResizeObserver) {
    win.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  }

  const g = globalThis as Record<string, unknown>;
  const expose = [
    'window', 'document', 'navigator', 'location', 'self', 'top', 'parent', 'frames',
    'HTMLElement', 'HTMLCanvasElement', 'HTMLImageElement', 'Image', 'SVGElement', 'SVGSVGElement',
    'Node', 'Element', 'Text', 'Comment', 'DOMParser', 'XMLSerializer', 'FontFace',
    'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'matchMedia', 'ResizeObserver',
    'MutationObserver', 'CustomEvent', 'Event', 'localStorage', 'sessionStorage', 'devicePixelRatio', 'Path2D'
  ];
  for (const key of expose) {
    if (key in g) continue;
    const value = ['window', 'self', 'top', 'parent'].includes(key) ? win : win[key];
    if (value === undefined) continue;
    Object.defineProperty(g, key, { value, configurable: true, writable: true });
  }

  domWindow = win;
  return win;
}

export function getDomWindow(): ShimWindow {
  return installGlobals();
}

export function loadExcalidrawNode(): Promise<ExcalidrawNodeModule> {
  if (!modulePromise) {
    modulePromise = (async () => {
      installGlobals();
      // dist/core/render/excalidraw-node/dom.js -> dist/render/excalidraw-node.mjs
      const bundleUrl = new URL('../../../render/excalidraw-node.mjs', import.meta.url);
      const mod = await import(bundleUrl.href);
      return mod as ExcalidrawNodeModule;
    })();
    modulePromise.catch(() => { modulePromise = null; });
  }
  return modulePromise;
}
