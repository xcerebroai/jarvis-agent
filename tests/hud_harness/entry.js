import { createRoot } from 'react-dom/client'
import plugin from 'jarvis-hud-plugin'
const regs = []
plugin.register({ registerMany: items => regs.push(...items), onDispose: () => undefined })
const path = new URLSearchParams(location.search).get('route') || '/hud'
const route = regs.find(r => r.area === 'routes' && r.data.path === path)
document.title = 'JARVIS harness ' + path
createRoot(document.getElementById('root')).render(route.render())
