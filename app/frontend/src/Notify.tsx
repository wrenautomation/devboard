// Local patch: send a note to the Claude Code sessions that run `draw watch`.
// The note carries the text and the selected shapes (the area to check). Mic = Safari speech to text.
import React, { useEffect, useRef, useState } from 'react'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'

const Speech: any = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition

export function Notify({ api, flush }: { api: ExcalidrawImperativeAPI | null; flush: () => Promise<void> }) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [to, setTo] = useState('')
  const [watchers, setWatchers] = useState<string[]>([])
  const [picked, setPicked] = useState(0)
  const [status, setStatus] = useState('')
  const [listening, setListening] = useState(false)
  const rec = useRef<any>(null)

  useEffect(() => {
    if (!api) return
    const read = () => setPicked(Object.keys(api.getAppState().selectedElementIds).length)
    read()
    return api.onChange(read)
  }, [api])

  useEffect(() => {
    if (!open) return
    setStatus('')
    fetch('/api/watchers').then(r => r.json()).then(d => setWatchers(d.watchers ?? [])).catch(() => setWatchers([]))
  }, [open])

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
    const sel = api.getAppState().selectedElementIds
    const els = api.getSceneElements().filter(e => sel[e.id])
    const ids = els.map(e => e.id)
    const box = els.length ? (() => {
      const x = Math.min(...els.map(e => e.x)), y = Math.min(...els.map(e => e.y))
      return { x, y, w: Math.max(...els.map(e => e.x + Math.abs(e.width))) - x, h: Math.max(...els.map(e => e.y + Math.abs(e.height))) - y }
    })() : undefined
    if (!text.trim() && !ids.length) { setStatus('Write a note or select shapes'); return }
    setStatus('Sending…')
    try {
      await flush() // Claude reads the saved scene, so save first.
      const r = await fetch('/api/notify', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, ids, box, to }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error)
      setText('')
      setStatus(d.reached ? `Sent to ${d.reached} session${d.reached > 1 ? 's' : ''}` : 'Kept. No session is watching now')
    } catch (e) {
      setStatus(`Not sent: ${(e as Error).message}`)
    }
  }

  return (
    <div className="notify">
      <button className={`btn-secondary notify-toggle ${open ? 'on' : ''}`} onClick={() => setOpen(o => !o)} aria-expanded={open}>Send to Claude</button>
      {open && (
        <div className="nt-pop">
          <div className="nt-area">{picked ? `${picked} shape${picked > 1 ? 's' : ''} selected: Claude checks these` : 'Nothing selected: Claude checks the whole canvas'}</div>
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
