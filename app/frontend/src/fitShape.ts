// Local patch: the shape a pen stroke meant, for Snap.tsx. Pure math on scene points, no Excalidraw.
// line: ends kept, near 0/45/90° set exact. Closed: polygon (3-5 sharp corners) or ellipse. Else a smooth curve.
// Custom: shape fit libraries ($1, $Q) classify gestures, they do not fit points; RDP is 20 lines.

export type P = { x: number; y: number }
export type Kind = 'line' | 'ellipse' | 'polygon' | 'curve'
export type Fit = { kind: Kind; points: P[] }

const dist = (a: P, b: P) => Math.hypot(a.x - b.x, a.y - b.y)
const lengthOf = (ps: P[]) => ps.reduce((s, p, i) => (i ? s + dist(ps[i - 1] as P, p) : 0), 0)

// Distance from p to segment ab.
function toSegment(p: P, a: P, b: P) {
  const dx = b.x - a.x,
    dy = b.y - a.y,
    l2 = dx * dx + dy * dy
  const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy)
}

// Ramer-Douglas-Peucker: the corners that keep every point within eps.
function rdp(ps: P[], eps: number): P[] {
  if (ps.length < 3) return ps
  const a = ps[0] as P,
    b = ps[ps.length - 1] as P
  let at = 0,
    far = 0
  for (let i = 1; i < ps.length - 1; i++) {
    const d = toSegment(ps[i] as P, a, b)
    if (d > far) {
      far = d
      at = i
    }
  }
  if (far <= eps) return [a, b]
  return [...rdp(ps.slice(0, at + 1), eps).slice(0, -1), ...rdp(ps.slice(at), eps)]
}

// Points every `step` along a polyline.
export function resample(ps: P[], step: number): P[] {
  const out: P[] = [ps[0] as P]
  let carry = 0
  for (let i = 1; i < ps.length; i++) {
    const a = ps[i - 1] as P,
      b = ps[i] as P,
      d = dist(a, b)
    let t = step - carry
    while (t <= d) {
      out.push({ x: a.x + ((b.x - a.x) * t) / d, y: a.y + ((b.y - a.y) * t) / d })
      t += step
    }
    carry = d - (t - step)
  }
  const last = ps[ps.length - 1] as P
  if (dist(out[out.length - 1] as P, last) > step / 4) out.push(last)
  return out
}

// Centripetal Catmull-Rom through the control points: no loops or cusps between them.
function spline(cs: P[], per: number): P[] {
  if (cs.length < 3) return cs
  const pts = [cs[0] as P, ...cs, cs[cs.length - 1] as P]
  const out: P[] = []
  for (let i = 1; i < pts.length - 2; i++) {
    const p0 = pts[i - 1] as P,
      p1 = pts[i] as P,
      p2 = pts[i + 1] as P,
      p3 = pts[i + 2] as P
    const k = (a: P, b: P) => Math.max(Math.sqrt(dist(a, b)), 1e-6)
    const t1 = k(p0, p1),
      t2 = t1 + k(p1, p2),
      t3 = t2 + k(p2, p3)
    const lerp = (a: P, b: P, ta: number, tb: number, t: number): P => {
      const u = tb - ta ? (t - ta) / (tb - ta) : 0
      return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u }
    }
    for (let j = 0; j < per; j++) {
      const t = t1 + ((t2 - t1) * j) / per
      const a1 = lerp(p0, p1, 0, t1, t),
        a2 = lerp(p1, p2, t1, t2, t),
        a3 = lerp(p2, p3, t2, t3, t)
      const b1 = lerp(a1, a2, 0, t2, t),
        b2 = lerp(a2, a3, t1, t3, t)
      out.push(lerp(b1, b2, t1, t2, t))
    }
  }
  out.push(cs[cs.length - 1] as P)
  return out
}

// A line from a to b, its angle set exact when within 4° of a multiple of 45°.
export function straight(a: P, b: P): P[] {
  const len = dist(a, b),
    ang = Math.atan2(b.y - a.y, b.x - a.x)
  const near = Math.round(ang / (Math.PI / 4)) * (Math.PI / 4)
  const use = Math.abs(ang - near) < (4 * Math.PI) / 180 ? near : ang
  return [a, { x: a.x + len * Math.cos(use), y: a.y + len * Math.sin(use) }]
}

// Principal axes: centre, angle, and the half-lengths that fit the points best.
function ellipse(ps: P[]) {
  const n = ps.length
  const c = { x: ps.reduce((s, p) => s + p.x, 0) / n, y: ps.reduce((s, p) => s + p.y, 0) / n }
  let xx = 0,
    yy = 0,
    xy = 0
  for (const p of ps) {
    const dx = p.x - c.x,
      dy = p.y - c.y
    xx += dx * dx
    yy += dy * dy
    xy += dx * dy
  }
  const ang = 0.5 * Math.atan2(2 * xy, xx - yy)
  const cos = Math.cos(ang),
    sin = Math.sin(ang)
  const local = ps.map(p => ({ u: (p.x - c.x) * cos + (p.y - c.y) * sin, v: -(p.x - c.x) * sin + (p.y - c.y) * cos }))
  // Mean |u|, |v| of points on an ellipse with axes a, b is 2a/π, 2b/π: robust to an uneven pen speed.
  let a = (Math.PI / 2) * (local.reduce((s, q) => s + Math.abs(q.u), 0) / n)
  let b = (Math.PI / 2) * (local.reduce((s, q) => s + Math.abs(q.v), 0) / n)
  if (Math.abs(a - b) < 0.12 * Math.max(a, b)) a = b = (a + b) / 2 // a circle
  const err = local.reduce((s, q) => s + Math.abs(Math.hypot(q.u / a, q.v / b) - 1), 0) / n
  return { c, ang, a, b, err }
}

// The polygon's corners if the closed stroke has 3-5 sharp ones, and its fit error over the size.
function polygon(ps: P[], size: number) {
  let cs = rdp(ps, 0.07 * size)
  if (cs.length > 2 && dist(cs[0] as P, cs[cs.length - 1] as P) < 0.2 * size) cs = cs.slice(0, -1)
  // Drop corners that barely turn.
  cs = cs.filter((p, i) => {
    const a = cs[(i - 1 + cs.length) % cs.length] as P,
      b = cs[(i + 1) % cs.length] as P
    const t1 = Math.atan2(p.y - a.y, p.x - a.x),
      t2 = Math.atan2(b.y - p.y, b.x - p.x)
    const turn = Math.abs(((t2 - t1 + 3 * Math.PI) % (2 * Math.PI)) - Math.PI)
    return turn > (25 * Math.PI) / 180
  })
  if (cs.length < 3 || cs.length > 5) return null
  const err =
    ps.reduce((s, p) => s + Math.min(...cs.map((c, i) => toSegment(p, c, cs[(i + 1) % cs.length] as P))), 0) /
    ps.length /
    size
  return { cs, err }
}

// The fitted shape, sampled every `step` scene units; null for a stroke too short to mean one.
export function fit(raw: P[], step: number, minLength: number): Fit | null {
  const ps = raw.filter((p, i) => !i || dist(p, raw[i - 1] as P) > 0)
  const len = lengthOf(ps)
  if (ps.length < 2 || len < minLength) return null
  const first = ps[0] as P,
    last = ps[ps.length - 1] as P
  const xs = ps.map(p => p.x),
    ys = ps.map(p => p.y)
  const size = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys))

  const chord = dist(first, last)
  const off = Math.max(...ps.map(p => toSegment(p, first, last)))
  if (chord > 0.75 * len && off < Math.max(0.06 * chord, step))
    return { kind: 'line', points: resample(straight(first, last), step) }

  if (chord < 0.2 * size && len > 1.8 * size) {
    const e = ellipse(ps)
    const g = polygon(ps, size)
    if (g && (g.err < 0.03 || g.err * 2.2 < e.err)) {
      const cs = g.cs
      return { kind: 'polygon', points: resample([...cs, cs[0] as P, cs[1] as P], step).slice(0, -1) }
    }
    if (e.err < 0.16) {
      const n = Math.max(24, Math.ceil((Math.PI * (e.a + e.b)) / step))
      const cos = Math.cos(e.ang),
        sin = Math.sin(e.ang)
      // One step past the start, so the stroke's two caps overlap and the ring has no gap.
      return {
        kind: 'ellipse',
        points: Array.from({ length: n + 2 }, (_, i) => {
          const t = (2 * Math.PI * i) / n,
            u = e.a * Math.cos(t),
            v = e.b * Math.sin(t)
          return { x: e.c.x + u * cos - v * sin, y: e.c.y + u * sin + v * cos }
        }),
      }
    }
  }

  // A curve: the stroke's corners at 2.5% of its size, a spline through them.
  const cs = rdp(ps, Math.max(0.025 * size, step))
  return { kind: 'curve', points: resample(spline(cs, 16), step) }
}
