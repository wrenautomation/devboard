// Local patch: browser speech to text (Safari on the iPad, Chrome on the Mac). Free; no key, no server.
// Used by the Send to Claude mic and by Voice text.
import { useRef, useState } from 'react'

const Speech: any = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition
export const canDictate = !!Speech

// Spoken commands → marks. Safari often adds its own punctuation; these cover the rest.
const SPOKEN: [RegExp, string][] = [
  [/\s*\bnew paragraph\b\s*/gi, '\n\n'],
  [/\s*\b(?:new|next) line\b\s*/gi, '\n'],
  [/\s*\b(?:new |next )?bullet(?: point)?\b\s*/gi, '\n• '],
  [/\s*\bquestion mark\b/gi, '?'],
  [/\s*\bexclamation (?:mark|point)\b/gi, '!'],
  [/\s*\b(?:full stop|period)\b/gi, '.'],
  [/\s*\bcomma\b/gi, ','],
  [/\s*\bcolon\b/gi, ':'],
  [/\s+\bdash\b\s+/gi, ' - '],
]

// Raw dictation → tidy text: spoken commands, a capital at each sentence and line start, "I", no double spaces.
export function formatSpeech(raw: string): string {
  let t = raw
  for (const [re, mark] of SPOKEN) t = t.replace(re, mark)
  t = t
    .replace(/[ \t]+/g, ' ')
    .replace(/ +([.,?!:])/g, '$1')
    .replace(/\bi\b/g, 'I')
    .split('\n').map(l => l.trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/(^|[.?!]\s+|\n(?:• )?)([a-z])/g, (_, a, b) => a + b.toUpperCase())
  return t.replace(/^\s+/, '').replace(/[ \t]+$/, '') // a trailing new line stays, so the next phrase starts there
}

// One recognizer. onText gets each final phrase; `interim` holds the words not yet final.
export function useDictation(onText: (said: string) => void, onError: (msg: string) => void) {
  const [listening, setListening] = useState(false)
  const [interim, setInterim] = useState('')
  const rec = useRef<any>(null)
  const stop = () => rec.current?.stop()
  const start = () => {
    if (!Speech || rec.current) return
    const r = new Speech()
    r.lang = navigator.language || 'en-US'
    r.continuous = true
    r.interimResults = true
    r.onresult = (e: any) => {
      let done = '', wip = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) done += e.results[i][0].transcript
        else wip += e.results[i][0].transcript
      }
      setInterim(wip)
      if (done.trim()) onText(done.trim())
    }
    r.onerror = (e: any) => { if (e.error !== 'aborted' && e.error !== 'no-speech') onError(`Mic: ${e.error}`) }
    r.onend = () => { rec.current = null; setListening(false); setInterim('') }
    rec.current = r
    r.start()
    setListening(true)
  }
  return { listening, interim, start, stop, toggle: () => (rec.current ? stop() : start()) }
}

// Adds a phrase to the end of a draft with one space between.
export const appendSaid = (draft: string, said: string) => (draft ? draft.replace(/[ \t]*$/, /\n$/.test(draft) ? '' : ' ') : '') + said
