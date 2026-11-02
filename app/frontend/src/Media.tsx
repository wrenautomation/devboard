import type { ExcalidrawEmbeddableElement, NonDeleted } from '@excalidraw/excalidraw/element/types'
import { useEffect, useRef } from 'react'

// Local patch: videos on the canvas (designs/2026-11-02-media.md). Link /media/<sha>.mp4; poster = same name .jpg.
const MEDIA_LINK = /^\/media\/[0-9a-f]{64}\.mp4$/

// true for media links; undefined hands other links to Excalidraw's own rules
export const validateEmbeddable = (link: string): true | undefined => (MEDIA_LINK.test(link) ? true : undefined)

// muted + playsInline: iOS autoplay; preload none: no bytes until on screen
function MediaVideo({ src }: { src: string }) {
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const video = ref.current
    if (!video) return
    let seen = false
    const sync = () => {
      if (seen && !document.hidden) void video.play().catch(() => {})
      else video.pause()
    }
    const io = new IntersectionObserver(([entry]) => {
      seen = Boolean(entry?.isIntersecting)
      sync()
    })
    io.observe(video)
    document.addEventListener('visibilitychange', sync)
    return () => {
      io.disconnect()
      document.removeEventListener('visibilitychange', sync)
      video.pause()
    }
  }, [])
  return (
    <video
      ref={ref}
      src={src}
      poster={src.replace(/\.mp4$/, '.jpg')}
      muted
      loop
      playsInline
      preload="none"
      style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
    />
  )
}

export const renderEmbeddable = (element: NonDeleted<ExcalidrawEmbeddableElement>) =>
  element.link && MEDIA_LINK.test(element.link) ? <MediaVideo src={element.link} /> : null
