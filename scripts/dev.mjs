import http from 'node:http';
import {fileURLToPath} from 'node:url';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import {randomBytes} from 'node:crypto';
import {localDatabase} from './local-db.mjs';
import {isProduction} from './mode.mjs';
import worker from '../server/worker.js';
const root=resolve(fileURLToPath(new URL('..',import.meta.url))),publicRoot=resolve(root,'public');
// Production (NODE_ENV=production or a public https APP_ORIGIN): plain Node hosting (e.g. GoDaddy). Worker-equivalent env: no DEV_LOCAL, required secrets, public bind.
const prod=isProduction();
const dataDir=prod?resolve(root,'data'):resolve(root,'.data');
await mkdir(dataDir,{recursive:true});
let secret=process.env.APP_SECRET;
if(prod&&!(secret&&secret.length>=32))throw new Error('Production requires APP_SECRET of at least 32 characters.');
if(!secret){const path=resolve(root,'.data','local-secret');try{secret=await readFile(path,'utf8');}catch{secret=randomBytes(32).toString('hex');await writeFile(path,secret,{mode:0o600});}}
const port=Number(process.env.PORT||8787),host=prod?(process.env.HOST||'0.0.0.0'):'127.0.0.1',trustProxy=prod&&process.env.TRUST_PROXY==='1',origin=process.env.APP_ORIGIN||(prod?'':`http://localhost:${port}`);
if(!origin)throw new Error('Production requires APP_ORIGIN.');
if(!prod&&!['localhost','127.0.0.1','[::1]'].includes(new URL(origin).hostname))throw new Error('Local dev binds to loopback only. Use the Worker deployment for hosting.');
const mime={'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.json':'application/json','.woff2':'font/woff2','.txt':'text/plain; charset=utf-8'};
const db=localDatabase(resolve(dataDir,prod?(process.env.DB_FILE||'connect-four.sqlite'):'game.sqlite'));
const env={...process.env,APP_ORIGIN:origin,APP_SECRET:secret,DB:db,...(prod?{}:{DEV_LOCAL:'1'}),
  ASSETS:{async fetch(request){
    const pathname=new URL(request.url).pathname;
    let path;try{path=resolve(publicRoot,'.'+decodeURIComponent(pathname==='/'?'/index.html':pathname));}catch{return new Response('Bad path',{status:400});}
    if(!path.startsWith(publicRoot+sep))return new Response('Not found',{status:404});
    try{return new Response(await readFile(path),{headers:{'Content-Type':mime[extname(path)]||'application/octet-stream'}});}
    catch{return new Response('Not found',{status:404});}
  }}};
const server=http.createServer(async(req,res)=>{
  try {
    // Do not trust a caller-provided Host or spoofed client IP in local development.
    const headers=new Headers();for(const [k,v] of Object.entries(req.headers))if(v!==undefined)headers.set(k,Array.isArray(v)?v.join(','):v);
    headers.delete('cf-connecting-ip');
    // Behind a trusted proxy the nearest hop appends the real client address last; never use the first (client-supplied) entry.
    const forwarded=trustProxy?String(headers.get('x-forwarded-for')||'').split(',').pop().trim():'';
    headers.set('x-local-address',forwarded||req.socket.remoteAddress||'loopback');
    const body=['GET','HEAD'].includes(req.method)?undefined:ReadableStreamFromRequest(req);
    const request=new Request(new URL(req.url,origin),{method:req.method,headers,body,duplex:'half'});
    const tasks=[],response=await worker.fetch(request,env,{waitUntil:p=>tasks.push(p)});
    res.writeHead(response.status,Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));await Promise.allSettled(tasks);
  }catch(e){console.error('Local transport error:',e.message);res.writeHead(500);res.end('Transport error');}
});
function ReadableStreamFromRequest(req){return new ReadableStream({start(controller){req.on('data',c=>controller.enqueue(c));req.on('end',()=>controller.close());req.on('error',e=>controller.error(e));}});}
server.listen(port,host,()=>console.log(`Connect Four: ${origin}\nJEV: ${env.TYPESAFE_API_KEY?'configured':'not configured — local practice available'}\nDiscord: ${env.DISCORD_CLIENT_ID?'configured':'not configured'}`));
const cleanup=setInterval(()=>worker.scheduled({},env).catch(e=>console.error('Cleanup failed:',e.message)),60000);cleanup.unref();
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close(()=>{clearInterval(cleanup);db.close();process.exit(0);}));
