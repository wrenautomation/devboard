import type {
  ExcalidrawEmbeddableElement,
  NonDeleted,
  NonDeletedExcalidrawElement,
} from '@excalidraw/excalidraw/element/types'
import type { AppState } from '@excalidraw/excalidraw/types'
import { useEffect, useRef } from 'react'

// Local patch: videos on the canvas (designs/2026-11-02-media.md). Link /media/<sha>.mp4; poster = same name .jpg.
const MEDIA_LINK = /^\/media\/[0-9a-f]{64}\.mp4$/

// true for media links; undefined hands other links to Excalidraw's own rules
export const validateEmbeddable = (link: string): true | undefined => (MEDIA_LINK.test(link) ? true : undefined)

// on screen by Excalidraw's own scroll and zoom; IntersectionObserver never fires inside its transformed layer on iPad
function onScreen(el: NonDeleted<ExcalidrawEmbeddableElement>, s: AppState): boolean {
  const left = -s.scrollX,
    top = -s.scrollY
  return (
    el.x < left + s.width / s.zoom.value &&
    el.x + el.width > left &&
    el.y < top + s.height / s.zoom.value &&
    el.y + el.height > top
  )
}

// muted + playsInline: iOS autoplay; preload none: no bytes until on screen. Active (tapped): native controls.
// Low Power Mode blocks autoplay: the poster stays until a tap.
function MediaVideo({ id, src, visible, active }: { id: string; src: string; visible: boolean; active: boolean }) {
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const video = ref.current
    if (!video) return
    const sync = () => {
      if (visible && !document.hidden) void video.play().catch(() => {})
      else video.pause()
    }
    sync()
    document.addEventListener('visibilitychange', sync)
    return () => document.removeEventListener('visibilitychange', sync)
  }, [visible])
  useEffect(() => () => ref.current?.pause(), [])
  return (
    <video
      ref={ref}
      data-embed={id}
      src={src}
      poster={src.replace(/\.mp4$/, '.jpg')}
      muted
      loop
      playsInline
      controls={active}
      preload="none"
      style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
    />
  )
}

export const renderEmbeddable = (element: NonDeleted<ExcalidrawEmbeddableElement>, appState: AppState) =>
  element.link && MEDIA_LINK.test(element.link) ? (
    <MediaVideo
      id={element.id}
      src={element.link}
      visible={onScreen(element, appState)}
      active={appState.activeEmbeddable?.element.id === element.id && appState.activeEmbeddable.state === 'active'}
    />
  ) : null

// the link icon on a video: full screen in place, never a new tab
export function openMedia(element: NonDeletedExcalidrawElement, event: CustomEvent): void {
  if (!element.link || !MEDIA_LINK.test(element.link)) return
  event.preventDefault()
  const video = document.querySelector<HTMLVideoElement & { webkitEnterFullscreen?: () => void }>(
    `video[data-embed="${CSS.escape(element.id)}"]`,
  )
  if (!video) return
  void video.play().catch(() => {})
  if (video.requestFullscreen) void video.requestFullscreen().catch(() => video.webkitEnterFullscreen?.())
  else video.webkitEnterFullscreen?.() // iPhone Safari: video only
}
