// Local patch: send a note to the Claude Code sessions that run `draw watch`.
// The note carries the text and either a marked area (a box dragged over the canvas) or the selected shapes.
// Claude then screenshots only that part, which keeps the image small. Mic = Safari speech to text.
import React, { useEffect, useRef, useState } from 'react'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { BoxDraw, boxStyle, toScreen, type Box } from './BoxDraw'

const Speech: any = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition

export function Notify({ api, flush }: { api: ExcalidrawImperativeAPI | null; flush: () => Promise<void> }) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [to, setTo] = useState('')
  const [watchers, setWatchers] = useState<string[]>([])
  const [picked, setPicked] = useState(0)
  const [status, setStatus] = useState('')
  const [listening, setListening] = useState(false)
  const [area, setArea] = useState<Box | null>(null) // scene coords
  const [marking, setMarking] = useState(false)
  const [, setView] = useState(0)
  const rec = useRef<any>(null)

  useEffect(() => {
    if (!api) return
    const read = () => { setPicked(Object.keys(api.getAppState().selectedElementIds).length); setView(v => v + 1) }
    read()
    return api.onChange(read)
  }, [api])

  const mic = () => {
    if (listening) { rec.current?.stop(); return }
    const r = new Speech()
    r.lang = navigator.language || 'en-US'
    r.continuous = true
    r.interimResults = false
    r.onresult = (e: any) => {
      let said = ''
      for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) said += e.results[i][0].transcript
      if (said) setText(t => (t ? t.replace(/\s*$/, ' ') : '') + said.trim())
    }
    r.onerror = (e: any) => setStatus(`Mic: ${e.error}`)
    r.onend = () => setListening(false)
    rec.current = r
    r.start()
    setListening(true)
  }

  const send = async () => {
    if (!api) return
    rec.current?.stop()
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
      <button className={`btn-secondary notify-toggle ${open ? 'on' : ''}`} onClick={() => setOpen(o => !o)} aria-expanded={open}>Send to Claude</button>
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
            {Speech && (
              <button className={`nt-mic ${listening ? 'on' : ''}`} onClick={mic} aria-pressed={listening} title="Speak">
                {listening ? 'Stop' : 'Mic'}
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
