import { createServer } from 'node:http'; import { readFileSync, existsSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'; import { fileURLToPath, pathToFileURL } from 'node:url'
const here=dirname(fileURLToPath(import.meta.url)); const repo=resolve(here,'..','..')
const src=process.env.HERMES_SRC; const roots=[src,join(src,'apps','desktop')].map(r=>join(r,'node_modules')).filter(existsSync); const find=n=>roots.map(r=>join(r,n)).find(existsSync)
const esbuild=await import(pathToFileURL(join(find('esbuild'),'lib','main.js')).href); const { chromium }=await import(pathToFileURL(join(find('playwright'),'index.mjs')).href)
await esbuild.build({entryPoints:[join(here,'entry.js')],bundle:true,format:'esm',outfile:join(here,'bundle.js'),logLevel:'error',nodePaths:roots,alias:{'@hermes/plugin-sdk':join(here,'sdk-stub.js'),'jarvis-hud-plugin':join(repo,'plugins','jarvis-hud','plugin.js')},define:{'process.env.NODE_ENV':'"production"'}})
const types={'.html':'text/html','.js':'text/javascript','.json':'application/json'}
const server=createServer((q,r)=>{const p=join(here,decodeURIComponent(new URL(q.url,'http://x').pathname).replace(/^\/+/,'')||'index.html');if(!p.startsWith(here)||!existsSync(p)){r.writeHead(404);r.end();return}r.writeHead(200,{'content-type':types[extname(p)]||'application/octet-stream'});r.end(readFileSync(p))})
await new Promise(r=>server.listen(0,'127.0.0.1',r))
const { SCALE='xl', EXPAND='zoom', OUT, CLICK, WAIT='4000', SHOT_DELAY='1200' } = process.env
const browser=await chromium.launch({headless:true}); const page=await browser.newPage({viewport:{width:1522,height:910},deviceScaleFactor:2})
await page.addInitScript(([sc,ex])=>{try{localStorage.setItem('jarvis:hud-scale',sc);localStorage.setItem('jarvis:hud-expand',ex)}catch(e){}},[SCALE,EXPAND])
await page.goto('http://127.0.0.1:'+server.address().port+'/index.html?route=/hud&orb=off'); await page.waitForTimeout(Number(WAIT))
if(CLICK){ await page.locator('[data-jv-interactive]',{hasText:new RegExp(CLICK,'i')}).first().click({force:true}); await page.waitForTimeout(Number(SHOT_DELAY)) }
await page.screenshot({path:OUT}); await browser.close(); server.close(); console.log('shot',SCALE,EXPAND,OUT)
