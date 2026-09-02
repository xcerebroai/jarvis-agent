// Rendered-bounds clip test: the expanded project detail must never clip its
// content on the glass. Asserts the LAST task's real getBoundingClientRect is
// visible inside the scroll region (after any needed scroll) and the panel sits
// within the viewport — at every SIZE preset and down to a small window. This
// guards the class of bug where a computed maxHeight "passes" while the eye
// sees clipping.
//
//   HERMES_SRC=/path/to/hermes-agent node tests/hud_clip.test.mjs
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createServer } from 'node:http'

const here = dirname(fileURLToPath(import.meta.url))
const harness = join(here, 'hud_harness')
const repo = resolve(here, '..')
const src = process.env.HERMES_SRC || ''
const roots = [src, join(src, 'apps', 'desktop')].map(r => join(r, 'node_modules')).filter(existsSync)
const find = n => roots.map(r => join(r, n)).find(existsSync)
if (!src || !find('esbuild') || !find('playwright')) { console.error('HERMES_SRC must point at a Hermes checkout with desktop deps'); process.exit(2) }
const mod = n => import(pathToFileURL(join(find(n), n === 'playwright' ? 'index.mjs' : 'lib/main.js')).href)
const esbuild = await mod('esbuild'); const { chromium } = await mod('playwright')
await esbuild.build({ entryPoints: [join(harness, 'entry.js')], bundle: true, format: 'esm', outfile: join(harness, 'bundle.js'), logLevel: 'error', nodePaths: roots, alias: { '@hermes/plugin-sdk': join(harness, 'sdk-stub.js'), 'jarvis-hud-plugin': join(repo, 'plugins', 'jarvis-hud', 'plugin.js') }, define: { 'process.env.NODE_ENV': '"production"' } })
const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' }
const server = createServer((req, res) => { const path = join(harness, decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.html'); if (!path.startsWith(harness) || !existsSync(path)) { res.writeHead(404); res.end(); return } const ext = '.' + path.split('.').pop(); res.writeHead(200, { 'content-type': types[ext] || 'application/octet-stream' }); res.end(readFileSync(path)) })
await new Promise(r => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const b = await chromium.launch({ headless: true })

let pass = 0, fail = 0
const ok = (c, l) => { console.log((c ? '  ✓ ' : '  ✗ ') + l); c ? pass++ : fail++ }
const tall = () => { const t = []; for (let i = 1; i <= 30; i++) t.push({ done: i < 24, label: 'Task ' + i + ' — configure and validate subsystem ' + i + ' fully end to end with retries' }); t.push({ done: false, label: 'Jarvis Account A2P Suspended. Needs a new account and full re-registration of the messaging profile before launch.' }); return { name: 'Agent Installation', id: 'P-002', status: 'Blocked', priority: 'Urgent', client: 'Client B', company: 'Company B', note: 'Payment status and final scope need confirmation before we can unblock and resume.', tasks_done: 24, tasks_total: 31, task_list: t, payment: 'PAID', owner: 'Ops', deadline: '2026-08-12', start: '2026-07-17', target_end: '2026-08-12', build_type: 'Agent build', revenue_relevance: 'Low', revenue_outstanding: 527 } }

console.log('== expanded detail never clips (rendered bounds) ==')
for (const [scale, vp] of [['xl', { width: 1522, height: 910 }], ['xl', { width: 1280, height: 720 }], ['large', { width: 1280, height: 720 }], ['comfortable', { width: 1024, height: 640 }]]) {
  const page = await b.newPage({ viewport: vp })
  await page.addInitScript(sc => { try { localStorage.setItem('jarvis:hud-scale', sc); localStorage.setItem('jarvis:hud-expand', 'dolly') } catch (e) {} }, scale)
  await page.goto('http://127.0.0.1:' + port + '/index.html?route=/hud&orb=off'); await page.waitForTimeout(2600)
  await page.evaluate(row => window.__jvEmit('display.detail', { focus: true, result: { projects: [row] }, source: 'pointer' }), tall())
  await page.waitForTimeout(1100)
  const r = await page.evaluate(() => {
    const lens = document.querySelector('[data-jv-lens]'); if (!lens) return { err: 'no lens' }
    let sc = null; lens.querySelectorAll('div').forEach(d => { if (d.scrollHeight > d.clientHeight + 2 && getComputedStyle(d).overflowY === 'auto') sc = d })
    if (sc) sc.scrollTop = sc.scrollHeight
    return new Promise(res => requestAnimationFrame(() => requestAnimationFrame(() => {
      const region = sc || lens; const rb = region.getBoundingClientRect()
      const spans = [...lens.querySelectorAll('span')].filter(s => /A2P Suspended/.test(s.textContent || ''))
      const last = spans[spans.length - 1]; const lb = last ? last.getBoundingClientRect() : null
      const lensB = lens.getBoundingClientRect()
      res({ vh: window.innerHeight, hasScroll: !!sc, regionBottom: rb.bottom, lastFound: !!last, lastTop: lb ? lb.top : null, lastBottom: lb ? lb.bottom : null, lensBottom: lensB.bottom })
    })))
  })
  const lastVisible = r.lastFound && r.lastBottom <= r.regionBottom + 2 && r.lastTop >= r.regionBottom - r.regionBottom - 1 && r.lastBottom <= r.vh + 2
  const panelInView = r.lensBottom <= r.vh + 1
  ok(r.lastFound && lastVisible && panelInView, `${scale} @ ${vp.width}x${vp.height}: last task visible (bottom ${Math.round(r.lastBottom)} ≤ region ${Math.round(r.regionBottom)} ≤ vh ${r.vh}), panel in view (${Math.round(r.lensBottom)} ≤ ${r.vh})` + (r.lastFound ? '' : ' [last task not found]'))
  await page.close()
}

await b.close(); server.close()
console.log(`\n  hud clip: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
