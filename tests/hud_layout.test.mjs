// Cockpit slot-grid geometry: operations plates (builds, task) and project
// cards must never overlap — with several simultaneous plates, with the
// detail stage open, and past the slot budget. Runs the plugin's own
// computeCockpitLayout/slotStyle (extracted between its layout markers, since
// plugin.js imports the SDK and cannot be loaded in node).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'jarvis-hud', 'plugin.js'), 'utf8')
const block = src.slice(src.indexOf('// --- layout:begin'), src.indexOf('// --- layout:end'))
const { computeCockpitLayout, slotStyle, GRID } = new Function(block + '\nreturn { computeCockpitLayout, slotStyle, GRID }')()

const W = 1522, H = 910
function rect(pos, width) {
  const style = slotStyle(pos, width)
  const x = pos.side === 'left' ? (GRID.side / 100) * W : W - (GRID.side / 100) * W - width
  const y = (parseFloat(style.top) / 100) * H
  return { h: (GRID.pitch / 100) * H - 12, w: width, x, y }
}
const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
function assertNoOverlap(layout, label) {
  const rects = [
    ...layout.ops.filter(Boolean).map(pos => ({ ...rect(pos, GRID.opWidth), kind: 'op' })),
    ...layout.cards.filter(Boolean).map(pos => ({ ...rect(pos, GRID.cardWidth), kind: 'card' }))
  ]
  for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) assert.ok(!overlaps(rects[i], rects[j]), `${label}: ${rects[i].kind}#${i} overlaps ${rects[j].kind}#${j}`)
  const keys = [...layout.ops, ...layout.cards].filter(Boolean).map(p => p.side + p.slot)
  assert.equal(new Set(keys).size, keys.length, `${label}: a slot was claimed twice`)
}

// 1. The witnessed bug: one pinned build + a full board — the build must take a
//    right-column slot and the card that lived there must move, not be covered.
let layout = computeCockpitLayout({ cards: 8, detailOpen: false, ops: 1 })
assert.deepEqual(layout.ops[0], { side: 'right', slot: 0 })
assert.deepEqual(layout.cards.slice(0, 5), [{ side: 'left', slot: 0 }, { side: 'left', slot: 1 }, { side: 'left', slot: 2 }, { side: 'left', slot: 3 }, { side: 'right', slot: 1 }])
assert.equal(layout.hidden, 1)
assertNoOverlap(layout, 'one build + 8 cards')

// 2. 2+ simultaneous plates: two builds + a running task + 8 cards.
layout = computeCockpitLayout({ cards: 8, detailOpen: false, ops: 3 })
assert.deepEqual(layout.ops, [{ side: 'right', slot: 0 }, { side: 'right', slot: 1 }, { side: 'right', slot: 2 }])
assert.deepEqual(layout.cards[4], { side: 'right', slot: 3 })
assert.equal(layout.hidden, 3)
assertNoOverlap(layout, 'two builds + task + 8 cards')

// 3. Detail stage open: the right column belongs to it; ops go left; cards reflow below.
layout = computeCockpitLayout({ cards: 8, detailOpen: true, ops: 2 })
assert.deepEqual(layout.ops, [{ side: 'left', slot: 0 }, { side: 'left', slot: 1 }])
assert.deepEqual(layout.cards.slice(0, 2), [{ side: 'left', slot: 2 }, { side: 'left', slot: 3 }])
assert.equal(layout.hidden, 6)
assertNoOverlap(layout, 'detail open')

// 4. Past the budget: a 9th operation gets no slot rather than a stacked one.
layout = computeCockpitLayout({ cards: 3, detailOpen: false, ops: 9 })
assert.equal(layout.ops.filter(Boolean).length, 8)
assert.equal(layout.ops[8], null)
assert.equal(layout.cards.filter(Boolean).length, 0)
assert.equal(layout.hidden, 3)
assertNoOverlap(layout, 'over budget')

// 5. No ops: the classic board — cards fill left then right, nothing hidden.
layout = computeCockpitLayout({ cards: 8, detailOpen: false, ops: 0 })
assert.equal(layout.hidden, 0)
assert.deepEqual(layout.cards[7], { side: 'right', slot: 3 })
assertNoOverlap(layout, 'no ops')

// 6. Slot plates are height-capped to their slot so content cannot spill into the next one.
assert.equal(slotStyle({ side: 'right', slot: 2 }, GRID.opWidth).maxHeight, 'calc(20.5% - 12px)')

console.log('hud layout: 6 scenarios, no overlaps ✓')
