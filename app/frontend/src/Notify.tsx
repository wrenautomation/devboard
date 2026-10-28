// Local patch: send a note to the Claude Code sessions that run `draw watch`.
// The note carries the text and either a marked area (a box dragged over the canvas) or the selected shapes.
// Claude then screenshots only that part, which keeps the image small. Mic = Safari speech to text.

import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { useEffect, useState } from 'react'
import { getJson, postJson } from './api'
import { BoxDraw } from './BoxDraw'
import { Send } from './icons'
import { appendSaid, canDictate, useDictation } from './speech'
import { type Box, boxStyle, toScreen } from './view'

type Session = {
  watch: string
  name: string
  folder: string
  status: 'idle' | 'busy'
  listening: boolean
  terminal: boolean
}

const ENTER_KEY = 'canvas-note-enter'
const rememberedEnter = () => {
  try {
    return window.localStorage?.getItem(ENTER_KEY) !== '0'
  } catch {
    return true
  }
}

export function Notify({ api, flush }: { api: ExcalidrawImperativeAPI | null; flush: () => Promise<void> }) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [to, setTo] = useState('')
  const [sessions, setSessions] = useState<Session[]>([])
  const [others, setOthers] = useState<string[]>([])
  const [picked, setPicked] = useState(0)
  const [status, setStatus] = useState('')
  const [enter, setEnter] = useState(rememberedEnter)
  const [area, setArea] = useState<Box | null>(null) // scene coords
  const [marking, setMarking] = useState(false)
  const [, setView] = useState(0)
  const mic = useDictation(said => setText(t => appendSaid(t, said)), setStatus)

  useEffect(() => {
    if (!api) return
    const read = () => {
      setPicked(Object.keys(api.getAppState().selectedElementIds).length)
      setView(v => v + 1)
    }
    read()
    return api.onChange(read)
  }, [api])

  // Live sessions and who listens, each time the panel opens.
  useEffect(() => {
    if (!open) return
    void getJson<{ sessions?: Session[]; others?: string[] }>('/api/sessions').then(d => {
      setSessions(d?.sessions ?? [])
      setOthers(d?.others ?? [])
    })
  }, [open])
  const listening = sessions.filter(x => x.listening).length + others.length
  // Enter on the Mac: only for one picked session that runs in a VS Code terminal.
  const canEnter = !!sessions.find(x => x.watch === to)?.terminal
  const pickEnter = (on: boolean) => {
    setEnter(on)
    try {
      window.localStorage?.setItem(ENTER_KEY, on ? '1' : '0')
    } catch {
      /* private mode */
    }
  }

  const send = async () => {
    if (!api) return
    mic.stop()
    const sel = area ? {} : api.getAppState().selectedElementIds
    const els = api.getSceneElements().filter(e => sel[e.id])
    const ids = els.map(e => e.id)
    const box = area
      ? { x: area.x, y: area.y, w: area.w, h: area.h }
      : els.length
        ? (() => {
            const x = Math.min(...els.map(e => e.x)),
              y = Math.min(...els.map(e => e.y))
            return {
              x,
              y,
              w: Math.max(...els.map(e => e.x + Math.abs(e.width))) - x,
              h: Math.max(...els.map(e => e.y + Math.abs(e.height))) - y,
            }
          })()
        : undefined
    if (!text.trim() && !ids.length && !area) {
      setStatus('Write a note, mark an area or select shapes')
      return
    }
    setStatus('Sending…')
    try {
      await flush() // Claude reads the saved scene, so save first.
      const d = await postJson<{ reached: number; entered: boolean }>('/api/notify', {
        text,
        ids,
        box,
        to,
        area: !!area,
        enter: canEnter && enter,
      })
      setText('')
      setArea(null)
      setStatus(
        (d.reached ? `Sent to ${d.reached} session${d.reached > 1 ? 's' : ''}` : 'Kept. No session is watching now') +
          (d.entered ? '. Enter pressed on the Mac' : ''),
      )
    } catch (e) {
      setStatus(`Not sent: ${(e as Error).message}`)
    }
  }

  // The marked box follows the canvas when it pans or zooms (onChange re-renders).
  const shown = api && area && !marking ? toScreen(api, area) : null

  return (
    <div className="notify">
      {marking && api && (
        <BoxDraw
          api={api}
          hint="Drag a box over the part to check"
          onDone={b => {
            setArea(b)
            setStatus('')
            setMarking(false)
            setOpen(true)
          }}
          onCancel={() => {
            setMarking(false)
            setOpen(true)
          }}
        />
      )}
      {shown && <div className="nt-box nt-box-set" style={boxStyle(shown)} />}
      <button
        type="button"
        className={`btn-secondary notify-toggle ${open ? 'on' : ''}`}
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        aria-label="Send to Claude"
      >
        <Send size={17} />
        <span className="hb-word">Send to Claude</span>
      </button>
      {open && (
        <div className="nt-pop">
          <div className="nt-area">
            <span>
              {area
                ? 'Area marked: Claude checks this box'
                : picked
                  ? `${picked} shape${picked > 1 ? 's' : ''} selected: Claude checks these`
                  : 'Nothing marked: Claude checks the whole canvas'}
            </span>
            {area ? (
              <button type="button" className="nt-mark-btn" onClick={() => setArea(null)}>
                Clear
              </button>
            ) : (
              <button
                type="button"
                className="nt-mark-btn"
                onClick={() => {
                  setOpen(false)
                  setMarking(true)
                }}
              >
                Mark area
              </button>
            )}
          </div>
          <div className="nt-text">
            <textarea
              value={text}
              onChange={e => setText(e.target.value)}
              placeholder="What should Claude check?"
              rows={4}
            />
            {canDictate && (
              <button
                type="button"
                className={`nt-mic ${mic.listening ? 'on' : ''}`}
                onClick={mic.toggle}
                aria-pressed={mic.listening}
                title="Speak"
              >
                {mic.listening ? 'Stop' : 'Mic'}
              </button>
            )}
          </div>
          <div className="nt-to" role="radiogroup" aria-label="Send to">
            {/* biome-ignore lint/a11y/useSemanticElements: styled buttons with the radio roles; an <input type=radio> would be a restyle */}
            <button
              type="button"
              role="radio"
              aria-checked={to === ''}
              className={to === '' ? 'on' : ''}
              onClick={() => setTo('')}
            >
              <b>All listening</b>
              <span>
                {listening} session{listening === 1 ? '' : 's'}
              </span>
            </button>
            {sessions
              .filter(x => x.listening)
              .map(x => (
                // biome-ignore lint/a11y/useSemanticElements: same
                <button
                  key={x.watch}
                  type="button"
                  role="radio"
                  aria-checked={to === x.watch}
                  className={to === x.watch ? 'on' : ''}
                  onClick={() => setTo(x.watch)}
                >
                  <b>{x.name}</b>
                  <span>
                    {x.folder}
                    {x.status === 'busy' ? ' · busy' : ''}
                    {x.terminal ? ' · VS Code' : ''}
                  </span>
                </button>
              ))}
            {others.map(w => (
              // biome-ignore lint/a11y/useSemanticElements: same
              <button
                key={w}
                type="button"
                role="radio"
                aria-checked={to === w}
                className={to === w ? 'on' : ''}
                onClick={() => setTo(w)}
              >
                <b>@{w}</b>
                <span>watcher</span>
              </button>
            ))}
          </div>
          {canEnter && (
            <label className="nt-enter">
              <input type="checkbox" checked={enter} onChange={e => pickEnter(e.target.checked)} />
              <span>Also send what I typed in this session on the Mac</span>
            </label>
          )}
          <button type="button" className="nt-send" onClick={() => void send()}>
            Send
          </button>
          {status && (
            <div className="nt-status" role="status">
              {status}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
