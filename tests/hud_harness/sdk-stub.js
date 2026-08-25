// Stub of @hermes/plugin-sdk for the cockpit harness: real event-bus
// semantics; the board / detail / build registry come from fixtures
// (synthetic rows in the backend's exact shapes — no owner data).
import { useEffect, useState } from 'react'
export const PALETTE_AREA = 'palette', ROUTES_AREA = 'routes', SIDEBAR_NAV_AREA = 'nav'
const listeners = new Map()
export function emit(type, payload, extra = {}) { for (const [t, fns] of listeners) if (t === '*' || t === type) fns.forEach(fn => fn({ type, payload, ...extra })) }
window.__jvEmit = emit
window.__jvNav = []
const busyAtom = { get: () => false, subscribe: fn => { fn(false); return () => undefined }, listen: () => () => undefined }
export const host = {
  state: { busy: busyAtom },
  navigate: path => { window.__jvNav.push({ navigate: path }); console.log('navigate', path) },
  openSession: async (id, opts) => { window.__jvNav.push({ openSession: id, opts }); console.log('openSession', id, JSON.stringify(opts || {})) },
  onEvent: (type, fn) => { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); return () => listeners.get(type).delete(fn) },
  request: async method => (method === 'cron.manage' ? { jobs: [{ id: 'sync', name: 'Sync project index', schedule_display: 'every 60m', last_run: '2026-08-24 19:00', prompt: 'Synchronize the project index.' }] } : {})
}
export function useValue(atom) { const [v, set] = useState(atom.get()); useEffect(() => atom.subscribe(set), [atom]); return v }
const fx = name => fetch('./fixtures/' + name).then(r => r.json())
window.addEventListener('jarvis:display-request', () => fx('board.json').then(result => emit('display.projects', { result, silent: true })))
window.addEventListener('jarvis:builds-request', () => fx('builds.json').then(r => emit('build.list', { builds: (r.builds || []).map(b => ({ ...b, inFlight: b.state === 'working', turnStartedAt: b.state === 'working' ? Date.now() - 65000 : 0 })) })))
// Pointer seams — the mirror of the voice supervisor's.
let focused = null
window.addEventListener('jarvis:detail-request', e => fx('detail.json').then(all => { const row = all[e.detail?.name]; if (row) { focused = row.name; emit('display.detail', { focus: true, result: { projects: [row] }, source: 'pointer' }) } }))
window.addEventListener('jarvis:stage-collapse', e => { focused = e.detail?.focus || null; emit('display.stage.clear', { focus: focused, source: 'pointer' }) })
window.addEventListener('jarvis:board-filter', e => fx('board.json').then(result => { const status = e.detail?.status || null; const projects = status ? result.projects.filter(p => p.status === status) : result.projects; emit('display.projects', { focus: false, result: { ...result, projects }, source: 'pointer', status }) }))
window.__jvFocused = () => focused
