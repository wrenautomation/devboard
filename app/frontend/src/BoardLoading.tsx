import { useRef } from 'react'

// Over the canvas while a board with no replica on this device loads. Fades in after 150 ms, so a fast
// switch never flashes it; stays mounted so it can fade out.
export function BoardLoading({ board }: { board: string | null }) {
  const last = useRef(board)
  if (board) last.current = board
  const name = last.current?.split('/').pop() || 'board'
  return (
    <div className={`board-loading ${board ? 'on' : ''}`} role="status" aria-live="polite" aria-hidden={!board}>
      <div className="board-loading-card">
        <svg className="board-loading-pen" viewBox="0 0 72 32" aria-hidden="true">
          <path d="M4 24c8-14 16-18 22-10s10 12 18 2 14-10 24-6" pathLength={100} />
        </svg>
        <span>
          Opening <b>{name}</b>
        </span>
      </div>
    </div>
  )
}
