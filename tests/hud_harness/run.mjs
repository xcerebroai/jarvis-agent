// Cockpit harness: bundles the REAL plugin against a stub SDK + synthetic
// fixtures, serves it, and drives it with Playwright.
//
//   HERMES_SRC=/path/to/hermes-agent node tests/hud_harness/run.mjs
//
// HERMES_SRC only supplies node_modules (esbuild, react, react-dom,
// playwright — all desktop deps). Checks: the board renders with no page
// errors, pointer interaction, and the DISMISS MATRIX — every plate type
// (project, build, task/research, sight, judgment, activity row, scheduled
// job) is expanded and each of the three dismiss paths (Esc — including with
// keyboard focus swallowed inside the lens — the × node, click-outside)
// returns the board to its exact prior state with no navigation.
import { createServer } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..', '..')
const src = process.env.HERMES_SRC || ''
// Desktop deps live at the checkout root and/or apps/desktop (workspace hoisting varies).
const roots = [src, join(src, 'apps', 'desktop')].map(r => join(r, 'node_modules')).filter(existsSync)
const find = name => roots.map(r => join(r, name)).find(existsSync)
if (!src || !find('esbuild') || !find('react') || !find('playwright')) { console.error('HERMES_SRC must point at a Hermes checkout whose desktop deps are installed (esbuild, react, playwright)'); process.exit(2) }
const mod = name => import(pathToFileURL(join(find(name), name === 'playwright' ? 'index.mjs' : 'lib/main.js')).href)
const esbuild = await mod('esbuild')
const { chromium } = await mod('playwright')

await esbuild.build({
  entryPoints: [join(here, 'entry.js')], bundle: true, format: 'esm', outfile: join(here, 'bundle.js'), logLevel: 'error',
  nodePaths: roots,
  alias: { '@hermes/plugin-sdk': join(here, 'sdk-stub.js'), 'jarvis-hud-plugin': join(repo, 'plugins', 'jarvis-hud', 'plugin.js') },
  define: { 'process.env.NODE_ENV': '"production"' }
})

const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' }
const server = createServer((req, res) => {
  const path = join(here, decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.html')
  if (!path.startsWith(here) || !existsSync(path)) { res.writeHead(404); res.end(); return }
  res.writeHead(200, { 'content-type': types[extname(path)] || 'application/octet-stream' }); res.end(readFileSync(path))
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const base = 'http://127.0.0.1:' + server.address().port + '/index.html?route=/hud&orb=off'

let pass = 0, fail = 0
const ok = (cond, label) => { console.log((cond ? '  ✓ ' : '  ✗ ') + label); cond ? pass++ : fail++ }
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1522, height: 910 } })
const errors = []
page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
await page.addInitScript(() => { try { localStorage.setItem('jarvis:hud-scale','comfortable'); localStorage.setItem('jarvis:hud-expand','zoom') } catch (e) {} })
await page.goto(base); await page.waitForTimeout(3500)
const text = async () => (await page.locator('#root').innerText()).replace(/\s+/g, ' ')
const stageOpen = () => page.locator('[data-jv-stage]').count()
const snapshot = async () => JSON.stringify({ header: ((await text()).match(/\d+ ON BOARD( · \d+ SHOWN)?/) || [''])[0], plates: await page.locator('.jv-drift').count(), nav: await page.evaluate(() => window.__jvNav.length), focused: await page.evaluate(() => window.__jvFocused()) })
const f = { force: true }

console.log('== render ==')
ok(errors.length === 0, 'no page errors on boot' + (errors.length ? ': ' + errors[0].slice(0, 120) : ''))
ok((await text()).includes('8 ON BOARD · 6 SHOWN'), 'board + two build plates reflow (8 on board · 6 shown)')
ok((await page.locator('.jv-drift').count()) === 8, 'eight drifting plates (6 cards + 2 builds), no ghosts')

console.log('== pointer ==')
const card = page.locator('[data-jv-interactive]', { hasText: /Agent Installation/i }).first()
await card.hover(f); await page.waitForTimeout(250)
ok((await text()).includes('CLICK · EXPAND'), 'card hover → CLICK · EXPAND')
await page.getByText(/^Blocked$/).first().click(f); await page.waitForTimeout(1500)
ok((await text()).includes('BLOCKED ·ONLY') && (await page.locator('.jv-drift').count()) === 3, 'BLOCKED tile → blocked only (1 card + 2 builds)')
await page.getByText(/^Blocked ·ONLY$/).first().click(f); await page.waitForTimeout(1500)
ok((await text()).includes('8 ON BOARD · 6 SHOWN'), 'tile toggles off → prior board')

console.log('== dismiss matrix ==')
// synthetic operations, emitted exactly as the supervisor would
await page.evaluate(() => {
  window.__jvEmit('voice.task.started', { goal: 'Research the market for AI receptionists', id: 1, kind: 'research', sessionId: 'rt-9' })
  window.__jvEmit('message.delta', { text: 'Opening the first page…' }, { session_id: 'rt-9' })
  window.__jvEmit('voice.sight.done', { answer: 'A terminal with a failing test.', analyzeMs: 2100, captureMs: 130, costUsd: 0.0011, latencyMs: 2300, model: 'gpt-4.1-mini', question: 'what is on my screen', target: { app: 'Terminal', kind: 'window', title: 'zsh' } })
  window.__jvEmit('voice.judgment.done', { answer: 'Focus on the blocked installation first.', elapsedMs: 6200, question: 'what should I focus on' })
})
await page.waitForTimeout(800)
const openers = [
  ['project card', () => page.locator('[data-jv-interactive]', { hasText: /Agent Installation/i }).first().click(f), /PROJECT DETAIL/],
  ['build plate (working)', () => page.locator('[data-jv-interactive]', { hasText: /Landing page refresh/i }).first().click(f), /BUILD SESSION · FULL DETAIL/],
  ['build plate (waiting)', () => page.locator('[data-jv-interactive]', { hasText: /Stripe integration/i }).first().click(f), /ANSWER IN SESSION ▸/],
  ['task / research plate', () => page.locator('[data-jv-interactive]', { hasText: /Research the market/i }).first().click(f), /RESEARCH OPERATION · FULL DETAIL/],
  ['sight plate', () => page.locator('[data-jv-interactive]', { hasText: /what is on my screen/i }).first().click(f), /SIGHT · SCREEN CAPTURE · FULL DETAIL/],
  ['judgment plate', () => page.locator('[data-jv-interactive]', { hasText: /what should I focus on/i }).first().click(f), /JUDGMENT · FULL AGENT · FULL DETAIL/],
  ['activity row', () => page.getByText('BOARD PROJECTED').first().click(f), /LIVE ACTIVITY · EVENT/],
  ['scheduled job row', () => page.getByText('Sync project index').first().click(f), /SCHEDULED OPERATION/]
]
const dismissals = [
  ['Esc (focus swallowed inside the lens)', async () => { await page.evaluate(() => { const i = document.createElement('input'); document.querySelector('[data-jv-lens]').appendChild(i); i.focus() }); await page.keyboard.press('Escape') }],
  ['× corner node', () => page.locator('[data-jv-close]').first().click(f)],
  ['click-outside on the backdrop', () => page.mouse.click(40, 470)]
]
for (const [name, open, marker] of openers) {
  for (const [how, dismiss] of dismissals) {
    const before = await snapshot()
    await open(); await page.waitForTimeout(700)
    const opened = (await stageOpen()) === 1 && marker.test(await text())
    await dismiss(); await page.waitForTimeout(500)
    const closed = (await stageOpen()) === 0
    const after = await snapshot()
    ok(opened && closed && before === after, name + ' → ' + how + (opened ? '' : ' [did not open]') + (closed ? '' : ' [did not close]') + (before === after ? '' : ' [state changed: ' + before + ' → ' + after + ']'))
  }
}

console.log('== navigation only through explicit controls ==')
await page.locator('[data-jv-interactive]', { hasText: /Stripe integration/i }).first().click(f); await page.waitForTimeout(600)
await page.getByText('ANSWER IN SESSION ▸').first().click(f); await page.waitForTimeout(200)
const opens = (await page.evaluate(() => window.__jvNav)).filter(n => n.openSession)
ok(opens.length === 1 && opens[0].openSession === '20260824_000000_abcdef', 'ANSWER IN SESSION opens the STORED session id (never a runtime id): ' + JSON.stringify(opens))
await page.keyboard.press('Escape'); await page.waitForTimeout(400)
await page.getByText('Sync project index').first().click(f); await page.waitForTimeout(500)
await page.getByText('OPEN SCHEDULER ▸').first().click(f); await page.waitForTimeout(200)
ok((await page.evaluate(() => window.__jvNav)).some(n => n.navigate === '/cron'), 'OPEN SCHEDULER navigates to /cron only when asked')
await page.keyboard.press('Escape'); await page.waitForTimeout(400)

console.log('== collapse restores the prior focus card ==')
await page.evaluate(() => window.__jvEmit('display.focus', { focus: true, result: { projects: [{ name: 'Coastal Campaign', status: 'Build Mode', priority: 'High', tasks_done: 5, tasks_total: 8 }] } }))
await page.waitForTimeout(600)
const focusBefore = await page.locator('.jv-drift').count()
await page.locator('[data-jv-interactive]', { hasText: /Northwind Onboarding/i }).first().click(f); await page.waitForTimeout(700)
ok((await stageOpen()) === 1, 'lens opens over a focus card')
await page.keyboard.press('Escape'); await page.waitForTimeout(600)
ok((await stageOpen()) === 0 && (await page.locator('.jv-drift').count()) === focusBefore && (await page.evaluate(() => window.__jvFocused())) === 'Coastal Campaign', 'collapse brings the focus card back and the supervisor focus follows it')
console.log('== task-to-task handoff reachable by mouse ==')
// Esc back to a clean board, then expand a project and page with the NEXT
// affordance — the SAME jvHandoffOut/In spatial pass the voice path fires.
await page.keyboard.press('Escape'); await page.waitForTimeout(400)
await page.evaluate(() => window.__jvEmit('display.clear', {})); await page.waitForTimeout(700)
await page.evaluate(() => window.dispatchEvent(new CustomEvent('jarvis:display-request'))); await page.waitForTimeout(900)
await page.locator('[data-jv-interactive]', { hasText: /Agent Installation/i }).first().click(f); await page.waitForTimeout(700)
const stageText = async () => ((await page.locator('[data-jv-stage]').innerText()).replace(/\s+/g, ' '))
const stageWas = (await stageOpen()) === 1 && /P-002/.test(await stageText())
const nextCtrl = page.locator('[data-jv-stage] [data-jv-interactive]', { hasText: 'NEXT' }).first()
ok(await nextCtrl.count() > 0, 'expanded project stage shows an explicit NEXT affordance')
await nextCtrl.click(f)
// mid-flight: the outgoing lens is thrown aside with the jvHandoffOut pass
await page.waitForTimeout(120)
const throwing = await page.evaluate(() => Array.from(document.querySelectorAll('[data-jv-stage] *')).some(el => (getComputedStyle(el).animationName || '').includes('jvHandoffOut')))
await page.waitForFunction(() => { const el = document.querySelector('[data-jv-stage]'); return el && /P-003/.test(el.innerText) && !/P-002/.test(el.innerText) }, { timeout: 4000 }).catch(() => {})
const stAfter = await stageText()
const switched = /P-003/.test(stAfter) && !/P-002/.test(stAfter) && (await stageOpen()) === 1
ok(stageWas && throwing && switched, 'mouse NEXT throws the current project aside and pulls the next in (jvHandoffOut fired, content switched)' + (throwing ? '' : ' [no jvHandoffOut]') + (switched ? '' : ' [content did not switch; stage=' + stAfter.slice(0,70) + ']'))
// arrow keys page too
const namePre = await stageText()
await page.keyboard.press('ArrowLeft'); await page.waitForTimeout(900)
ok((await stageOpen()) === 1 && (await stageText()) !== namePre, 'ArrowLeft pages to the previous project (same handoff)')
await page.keyboard.press('Escape'); await page.waitForTimeout(500)

console.log('== NAV is a real toggle ==')
const sidebarOpen = () => page.evaluate(() => window.__jvChrome)
await page.locator('[data-jv-navtab]').first().click(f); await page.waitForTimeout(200)
const navShown = await sidebarOpen()
await page.locator('[data-jv-navtab]').first().click(f); await page.waitForTimeout(200)
const navHidden = await sidebarOpen()
ok(navShown === true && navHidden === false, 'clicking NAV twice = open then closed (chrome ' + navShown + ' -> ' + navHidden + ')')
await page.locator('[data-jv-navtab]').first().click(f); await page.waitForTimeout(150)
await page.keyboard.press('Escape'); await page.waitForTimeout(200)
ok((await sidebarOpen()) === false, 'Esc closes the NAV drawer')
await page.locator('[data-jv-navtab]').first().click(f); await page.waitForTimeout(150)
await page.mouse.click(760, 470); await page.waitForTimeout(200)
ok((await sidebarOpen()) === false, 'click-outside closes the NAV drawer')

ok(errors.length === 0, 'no page errors during the run' + (errors.length ? ': ' + errors[0].slice(0, 160) : ''))

await browser.close(); server.close()
console.log(`\n  hud harness: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
