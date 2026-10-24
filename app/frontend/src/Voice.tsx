// Local patch: Voice text. Speak, check the draft, then place it on the canvas as one text box.
// Spoken "new line", "new paragraph" and "bullet" shape the text (see formatSpeech).

import { CaptureUpdateAction, convertToExcalidrawElements, FONT_FAMILY } from '@excalidraw/excalidraw'
import type { ExcalidrawTextElement } from '@excalidraw/excalidraw/element/types'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { Mic } from 'lucide-react'
import { useState } from 'react'
import { appendSaid, canDictate, formatSpeech, useDictation } from './speech'

const EMS = 26 // wrap width in font sizes (about 50 letters); the text rewraps when the box is resized

// Greedy word wrap at maxWidth. Excalidraw keeps its own wrapText private, so this measures with the same font.
// A resize or an edit rewraps from originalText with Excalidraw's own code.
function wrap(text: string, font: string, maxWidth: number): string {
  const ctx = document.createElement('canvas').getContext('2d')
  if (!ctx) return text
  ctx.font = font
  return text
    .split('\n')
    .map(line => {
      const out: string[] = []
      let cur = ''
      for (const word of line.split(' ')) {
        const next = cur ? `${cur} ${word}` : word
        if (cur && ctx.measureText(next).width > maxWidth) {
          out.push(cur)
          cur = word
        } else cur = next
      }
      out.push(cur)
      return out.join('\n')
    })
    .join('\n')
}

export function Voice({ api, flush }: { api: ExcalidrawImperativeAPI | null; flush: () => Promise<void> }) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [status, setStatus] = useState('')
  const mic = useDictation(said => setDraft(d => formatSpeech(appendSaid(d, said))), setStatus)
  if (!canDictate) return null

  const toggle = () => {
    if (open) {
      mic.stop()
      setOpen(false)
      return
    }
    setOpen(true)
    setStatus('')
    mic.start()
  }

  const place = () => {
    const text = formatSpeech(draft).trim()
    if (!api || !text) return
    mic.stop()
    const s = api.getAppState(),
      z = s.zoom.value
    // Centre of the visible canvas, in scene coords.
    const fontSize = s.currentItemFontSize,
      WIDTH = EMS * fontSize
    const x = s.width / 2 / z - s.scrollX - WIDTH / 2,
      y = s.height / 2 / z - s.scrollY - 2 * fontSize
    const [el] = convertToExcalidrawElements([
      {
        type: 'text',
        x,
        y,
        text,
        fontSize,
        fontFamily: s.currentItemFontFamily,
        strokeColor: s.currentItemStrokeColor,
      },
    ]) as ExcalidrawTextElement[]
    if (!el) return
    const name = Object.entries(FONT_FAMILY).find(([, n]) => n === el.fontFamily)?.[0] ?? 'Excalifont'
    const wrapped = wrap(text, `${el.fontSize}px ${name}`, WIDTH)
    const lines = wrapped.split('\n').length
    const box =
      el.width <= WIDTH
        ? el
        : {
            ...el,
            text: wrapped,
            originalText: text,
            autoResize: false,
            width: WIDTH,
            height: lines * el.fontSize * el.lineHeight,
          }
    api.updateScene({
      elements: [...api.getSceneElementsIncludingDeleted(), box],
      appState: { selectedElementIds: { [box.id]: true } },
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    })
    void flush() // a button edit has no canvas touch, so autosave would wait; save now
    setDraft('')
    setOpen(false)
  }

  return (
    <div className="notify">
      <button
        type="button"
        className={`btn-secondary notify-toggle ${open ? 'on' : ''}`}
        onClick={toggle}
        aria-expanded={open}
        aria-label="Voice text"
      >
        <Mic size={17} />
        <span className="hb-word">Voice text</span>
      </button>
      {open && (
        <div className="nt-pop">
          <div className="nt-area">
            <span>Say "new line", "new paragraph" or "bullet" to shape the text.</span>
          </div>
          <div className="nt-text">
            <textarea
              value={draft}
              onChange={e => setDraft(e.target.value)}
              placeholder="Speak, then check the text here"
              rows={6}
            />
            <button
              type="button"
              className={`nt-mic ${mic.listening ? 'on' : ''}`}
              onClick={mic.toggle}
              aria-pressed={mic.listening}
              title="Speak"
            >
              {mic.listening ? 'Stop' : 'Mic'}
            </button>
          </div>
          {mic.interim && <div className="nt-status vc-interim">{mic.interim}</div>}
          <div className="nt-row">
            <button type="button" className="nt-mark-btn" onClick={() => setDraft(d => formatSpeech(d))}>
              Tidy
            </button>
            <span style={{ flex: 1 }} />
            <button type="button" className="nt-send" onClick={place} disabled={!draft.trim()}>
              Place on canvas
            </button>
          </div>
          {status && <div className="nt-status">{status}</div>}
        </div>
      )}
    </div>
  )
}
