// Our rows inside Excalidraw's panels. Excalidraw remounts its panels per selection and tool: a slot div goes
// back into each host every time, and the hook returns the live ones.
import { useEffect, useState } from 'react'

export function useSlots(host: string, className: string): HTMLElement[] {
  const [slots, setSlots] = useState<HTMLElement[]>([])
  useEffect(() => {
    const find = () => {
      const next = [...document.querySelectorAll<HTMLElement>(host)].map(h => {
        let el = h.querySelector<HTMLElement>(`:scope > .${className}`)
        if (!el) {
          el = document.createElement('div')
          el.className = className
          h.appendChild(el)
        }
        return el
      })
      setSlots(prev => (prev.length === next.length && prev.every((p, i) => p === next[i]) ? prev : next))
    }
    find()
    const mo = new MutationObserver(find)
    mo.observe(document.body, { childList: true, subtree: true })
    return () => mo.disconnect()
  }, [host, className])
  return slots
}
