// node icon.js <name> <x> <y>  → elements JSON for `draw add`: one library item, fresh ids, moved to x,y.
// node icon.js --list          → item names
const fs = require('node:fs')
const items = JSON.parse(fs.readFileSync(`${__dirname}/wren.excalidrawlib`, 'utf8')).libraryItems
const [name, x = 0, y = 0] = process.argv.slice(2)
if (!name || name === '--list') {
  console.log([...new Set(items.map(i => i.name))].join('\n'))
  process.exit(0)
}
const it =
  items.find(i => i.name.toLowerCase() === name.toLowerCase()) ||
  items.find(i => i.name.toLowerCase().includes(name.toLowerCase()))
if (!it) {
  console.error(`no item "${name}"; try --list`)
  process.exit(2)
}
const x0 = Math.min(...it.elements.map(e => e.x)),
  y0 = Math.min(...it.elements.map(e => e.y))
const ids = new Map(),
  id = old => ids.get(old) || ids.set(old, Math.random().toString(36).slice(2, 12)).get(old)
const out = it.elements.map(e => ({
  ...e,
  id: id(e.id),
  x: e.x - x0 + +x,
  y: e.y - y0 + +y,
  groupIds: (e.groupIds || []).map(id),
  containerId: e.containerId ? id(e.containerId) : e.containerId,
  boundElements: e.boundElements ? e.boundElements.map(b => ({ ...b, id: id(b.id) })) : e.boundElements,
}))
console.log(JSON.stringify(out))
