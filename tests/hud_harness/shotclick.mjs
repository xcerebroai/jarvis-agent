import { createServer } from 'node:http'; import { readFileSync, existsSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'; import { fileURLToPath, pathToFileURL } from 'node:url'
const here=dirname(fileURLToPath(import.meta.url)); const repo=resolve(here,'..','..')
const src=process.env.HERMES_SRC; const roots=[src,join(src,'apps','desktop')].map(r=>join(r,'node_modules')).filter(existsSync)
const find=n=>roots.map(r=>join(r,n)).find(existsSync)
const esbuild=await import(pathToFileURL(join(find('esbuild'),'lib','main.js')).href)
const { chromium }=await import(pathToFileURL(join(find('playwright'),'index.mjs')).href)
await esbuild.build({entryPoints:[join(here,'entry.js')],bundle:true,format:'esm',outfile:join(here,'bundle.js'),logLevel:'error',nodePaths:roots,alias:{'@hermes/plugin-sdk':join(here,'sdk-stub.js'),'jarvis-hud-plugin':join(repo,'plugins','jarvis-hud','plugin.js')},define:{'process.env.NODE_ENV':'"production"'}})
const types={'.html':'text/html','.js':'text/javascript','.json':'application/json'}
const server=createServer((req,res)=>{const p=join(here,decodeURIComponent(new URL(req.url,'http://x').pathname).replace(/^\/+/,'')||'index.html');if(!p.startsWith(here)||!existsSync(p)){res.writeHead(404);res.end();return}res.writeHead(200,{'content-type':types[extname(p)]||'application/octet-stream'});res.end(readFileSync(p))})
await new Promise(r=>server.listen(0,'127.0.0.1',r)); const base='http://127.0.0.1:'+server.address().port+'/index.html?route=/hud&orb=off'
const browser=await chromium.launch({headless:true}); const page=await browser.newPage({viewport:{width:1522,height:910},deviceScaleFactor:2})
await page.goto(base); await page.waitForTimeout(4000)
await page.locator('[data-jv-interactive]',{hasText:/Agent Installation/i}).first().click({force:true})
await page.waitForTimeout(1200)
await page.screenshot({path:process.env.OUT}); await browser.close(); server.close(); console.log('ok')
