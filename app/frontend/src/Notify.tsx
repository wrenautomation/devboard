// Local patch: send a note to the Claude Code sessions that run `draw watch`.
// The note carries the text and either a marked area (a box dragged over the canvas) or the selected shapes.
// Claude then screenshots only that part, which keeps the image small. Mic = Safari speech to text.
import React, { useEffect, useState } from 'react'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { Send } from 'lucide-react'
import { BoxDraw, boxStyle, toScreen, type Box } from './BoxDraw'
import { appendSaid, canDictate, useDictation } from './speech'

export function Notify({ api, flush }: { api: ExcalidrawImperativeAPI | null; flush: () => Promise<void> }) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [to, setTo] = useState('')
  const [watchers, setWatchers] = useState<string[]>([])
  const [picked, setPicked] = useState(0)
  const [status, setStatus] = useState('')
  const [area, setArea] = useState<Box | null>(null) // scene coords
  const [marking, setMarking] = useState(false)
  const [, setView] = useState(0)
  const mic = useDictation(said => setText(t => appendSaid(t, said)), setStatus)

  useEffect(() => {
    if (!api) return
    const read = () => { setPicked(Object.keys(api.getAppState().selectedElementIds).length); setView(v => v + 1) }
    read()
    return api.onChange(read)
  }, [api])

  // Who is watching now, each time the panel opens.
  useEffect(() => {
    if (!open) return
    fetch('/api/watchers').then(r => r.json()).then(d => setWatchers(d.watchers ?? [])).catch(() => setWatchers([]))
  }, [open])

  const send = async () => {
    if (!api) return
    mic.stop()
    const sel = area ? {} : api.getAppState().selectedElementIds
    const els = api.getSceneElements().filter(e => sel[e.id])
    const ids = els.map(e => e.id)
    const box = area ? { x: area.x, y: area.y, w: area.w, h: area.h } : els.length ? (() => {
      const x = Math.min(...els.map(e => e.x)), y = Math.min(...els.map(e => e.y))
      return { x, y, w: Math.max(...els.map(e => e.x + Math.abs(e.width))) - x, h: Math.max(...els.map(e => e.y + Math.abs(e.height))) - y }
    })() : undefined
    if (!text.trim() && !ids.length && !area) { setStatus('Write a note, mark an area or select shapes'); return }
    setStatus('Sending…')
    try {
      await flush() // Claude reads the saved scene, so save first.
      const r = await fetch('/api/notify', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, ids, box, to, area: !!area }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error)
      setText('')
      setArea(null)
      setStatus(d.reached ? `Sent to ${d.reached} session${d.reached > 1 ? 's' : ''}` : 'Kept. No session is watching now')
    } catch (e) {
      setStatus(`Not sent: ${(e as Error).message}`)
    }
  }

  // The marked box follows the canvas when it pans or zooms (onChange re-renders).
  const shown = api && area && !marking ? toScreen(api, area) : null

  return (
    <div className="notify">
      {marking && api && (
        <BoxDraw api={api} hint="Drag a box over the part to check"
          onDone={b => { setArea(b); setStatus(''); setMarking(false); setOpen(true) }}
          onCancel={() => { setMarking(false); setOpen(true) }} />
      )}
      {shown && <div className="nt-box nt-box-set" style={boxStyle(shown)} />}
      <button className={`btn-secondary notify-toggle ${open ? 'on' : ''}`} onClick={() => setOpen(o => !o)} aria-expanded={open} aria-label="Send to Claude"><Send size={17} /><span className="hb-word">Send to Claude</span></button>
      {open && (
        <div className="nt-pop">
          <div className="nt-area">
            <span>{area ? 'Area marked: Claude checks this box' : picked ? `${picked} shape${picked > 1 ? 's' : ''} selected: Claude checks these` : 'Nothing marked: Claude checks the whole canvas'}</span>
            {area
              ? <button className="nt-mark-btn" onClick={() => setArea(null)}>Clear</button>
              : <button className="nt-mark-btn" onClick={() => { setOpen(false); setMarking(true) }}>Mark area</button>}
          </div>
          <div className="nt-text">
            <textarea value={text} onChange={e => setText(e.target.value)} placeholder="What should Claude check?" rows={4} />
            {canDictate && (
              <button className={`nt-mic ${mic.listening ? 'on' : ''}`} onClick={mic.toggle} aria-pressed={mic.listening} title="Speak">
                {mic.listening ? 'Stop' : 'Mic'}
              </button>
            )}
          </div>
          <div className="nt-row">
            <select value={to} onChange={e => setTo(e.target.value)} aria-label="Send to">
              <option value="">All sessions ({watchers.length})</option>
              {watchers.map(w => <option key={w} value={w}>@{w}</option>)}
            </select>
            <button className="nt-send" onClick={() => void send()}>Send</button>
          </div>
          {status && <div className="nt-status" role="status">{status}</div>}
        </div>
      )}
    </div>
  )
}
