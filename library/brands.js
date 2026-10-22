// Simple Icons → Excalidraw library items. Each icon: filled polygons (holes in white) + a label, grouped.
// usage: node brands.js <out.excalidrawlib> <grid.excalidraw>
const fs = require("fs");
const si = require("simple-icons");
const { svgPathProperties } = require("svg-path-properties");

const SLUGS = "youtube x tiktok instagram facebook meta threads reddit discord pinterest snapchat bluesky twitch spotify applepodcasts substack medium producthunt ycombinator gmail google googleads googlemaps googlesearchconsole googledrive googlesheets calendly loom stripe wise paypal gumroad quickbooks shopify hubspot mailchimp sendgrid resend zapier notion airtable slack whatsapp telegram twilio trustpilot yelp upwork fiverr cloudflare vercel postgresql apachekafka redis docker kubernetes github nodedotjs react typescript python openai anthropic claude perplexity figma webflow wordpress framer canva hootsuite".split(" ");
const BADGES = [["LinkedIn", "in", "#0A66C2"], ["Cal.com", "Cal", "#111111"], ["Jobber", "J", "#1A3D5C"], ["Customer.io", "cio", "#7131FF"], ["AWS", "aws", "#FF9900"], ["Hacker News", "Y", "#FF6600"], ["Instantly", "⚡", "#2E6BFF"], ["Exa", "exa", "#1F40ED"], ["Restate", "R", "#222222"], ["Clutch", "C", "#17313B"]];

const SIZE = 64, S = SIZE / 24, now = Date.now();
let n = 0;
const rid = () => `b${(n++).toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const base = (o) => ({
  angle: 0, strokeColor: "#1e1e1e", backgroundColor: "transparent", fillStyle: "solid", strokeWidth: 1,
  strokeStyle: "solid", roughness: 0, opacity: 100, frameId: null, roundness: null, seed: (Math.random() * 2 ** 31) | 0,
  version: 1, versionNonce: (Math.random() * 2 ** 31) | 0, isDeleted: false, boundElements: null, updated: now,
  link: null, locked: false, ...o, id: rid(),
});

function subpaths(d) {
  const parts = new svgPathProperties(require("svgpath")(d).abs().unarc().unshort().toString()).getParts();
  const out = []; let cur = null;
  for (const p of parts) {
    const jump = !cur || Math.hypot(p.start.x - cur.end.x, p.start.y - cur.end.y) > 1e-3;
    if (jump) { cur = { pts: [], end: p.end }; out.push(cur); }
    const steps = Math.max(1, Math.ceil(p.length / 0.7));
    for (let i = 0; i <= steps; i++) {
      const q = p.getPointAtLength((p.length * i) / steps);
      const last = cur.pts[cur.pts.length - 1];
      if (!last || Math.hypot(q.x - last[0], q.y - last[1]) > 0.15) cur.pts.push([q.x, q.y]);
    }
    cur.end = p.end;
  }
  return out.map((s) => s.pts).filter((p) => p.length > 2);
}
const area = (p) => Math.abs(p.reduce((a, [x, y], i) => { const [u, v] = p[(i + 1) % p.length]; return a + x * v - u * y; }, 0) / 2);
function inside([x, y], poly) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

function polygon(pts, color, gid, ox, oy) {
  const xs = pts.map((p) => p[0] * S), ys = pts.map((p) => p[1] * S);
  const x0 = Math.min(...xs), y0 = Math.min(...ys);
  const points = pts.map((p) => [p[0] * S - x0, p[1] * S - y0]); points.push([...points[0]]);
  return base({ type: "line", x: ox + x0, y: oy + y0, width: Math.max(...xs) - x0, height: Math.max(...ys) - y0,
    strokeColor: color, backgroundColor: color, strokeWidth: 0.5, groupIds: [gid], points, polygon: true,
    lastCommittedPoint: null, startBinding: null, endBinding: null, startArrowhead: null, endArrowhead: null });
}
function label(text, gid, ox, oy) {
  const w = text.length * 7.4;
  return base({ type: "text", x: ox + SIZE / 2 - w / 2, y: oy + SIZE + 6, width: w, height: 20, text, originalText: text,
    fontSize: 14, fontFamily: 2, textAlign: "center", verticalAlign: "top", containerId: null, autoResize: true,
    lineHeight: 1.25, groupIds: [gid] });
}

function brandIcon(icon, ox, oy) {
  const gid = rid(), color = "#" + icon.hex;
  const polys = subpaths(icon.path).sort((a, b) => area(b) - area(a));
  const depth = polys.map((p, i) => polys.filter((q, j) => j < i && inside(p[0], q)).length);
  const els = polys.map((p, i) => polygon(p, depth[i] % 2 ? "#ffffff" : color, gid, ox, oy));
  return [...els, label(icon.title, gid, ox, oy)];
}
function badge([name, mark, color], ox, oy) {
  const gid = rid(), box = base({ type: "rectangle", x: ox, y: oy, width: SIZE, height: SIZE, strokeColor: color,
    backgroundColor: color, roundness: { type: 3 }, groupIds: [gid] });
  const fs = mark.length > 2 ? 20 : 30;
  const tw = mark.length * fs * 0.6;
  const t = base({ type: "text", x: ox + (SIZE - tw) / 2, y: oy + SIZE / 2 - fs * 0.625, width: tw, height: fs * 1.25, text: mark,
    originalText: mark, fontSize: fs, fontFamily: 2, textAlign: "center", verticalAlign: "middle", containerId: null,
    autoResize: true, lineHeight: 1.25, strokeColor: "#ffffff", groupIds: [gid] });
  return [box, t, label(name, gid, ox, oy)];
}

const bySlug = new Map(Object.values(si).filter((i) => i && i.slug).map((i) => [i.slug, i]));
const items = [], grid = [];
const all = [...SLUGS.map((s) => ["icon", bySlug.get(s)]), ...BADGES.map((b) => ["badge", b])];
all.forEach(([kind, v], k) => {
  const make = (ox, oy) => (kind === "icon" ? brandIcon(v, ox, oy) : badge(v, ox, oy));
  items.push({ id: rid(), status: "published", created: now, name: kind === "icon" ? v.title : v[0], elements: make(0, 0) });
  grid.push(...make((k % 10) * 120, Math.floor(k / 10) * 120));
});
fs.writeFileSync(process.argv[2], JSON.stringify({ type: "excalidrawlib", version: 2, source: "wren brands", libraryItems: items }));
fs.writeFileSync(process.argv[3], JSON.stringify({ type: "excalidraw", version: 2, source: "wren", elements: grid, appState: { viewBackgroundColor: "#ffffff" }, files: {} }));
console.log(items.length, "items,", grid.length, "elements");
