import http from 'node:http';
import {fileURLToPath} from 'node:url';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import {randomBytes} from 'node:crypto';
import {localDatabase} from './local-db.mjs';
import worker from '../server/worker.js';
const root=resolve(fileURLToPath(new URL('..',import.meta.url))),publicRoot=resolve(root,'public');
await mkdir(resolve(root,'.data'),{recursive:true});
let secret=process.env.APP_SECRET;
if(!secret){const path=resolve(root,'.data','local-secret');try{secret=await readFile(path,'utf8');}catch{secret=randomBytes(32).toString('hex');await writeFile(path,secret,{mode:0o600});}}
const port=Number(process.env.PORT||8787),origin=process.env.APP_ORIGIN||`http://localhost:${port}`;
if(!['localhost','127.0.0.1','[::1]'].includes(new URL(origin).hostname))throw new Error('Local dev binds to loopback only. Use the Worker deployment for hosting.');
const mime={'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.json':'application/json'};
const db=localDatabase(resolve(root,'.data','game.sqlite'));
const env={...process.env,APP_ORIGIN:origin,APP_SECRET:secret,DEV_LOCAL:'1',DB:db,
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
    headers.delete('cf-connecting-ip');headers.set('x-local-address',req.socket.remoteAddress||'loopback');
    const body=['GET','HEAD'].includes(req.method)?undefined:ReadableStreamFromRequest(req);
    const request=new Request(new URL(req.url,origin),{method:req.method,headers,body,duplex:'half'});
    const tasks=[],response=await worker.fetch(request,env,{waitUntil:p=>tasks.push(p)});
    res.writeHead(response.status,Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));await Promise.allSettled(tasks);
  }catch(e){console.error('Local transport error:',e.message);res.writeHead(500);res.end('Transport error');}
});
function ReadableStreamFromRequest(req){return new ReadableStream({start(controller){req.on('data',c=>controller.enqueue(c));req.on('end',()=>controller.close());req.on('error',e=>controller.error(e));}});}
server.listen(port,'127.0.0.1',()=>console.log(`Connect Four: ${origin}\nJEV: ${env.TYPESAFE_API_KEY?'configured':'not configured — local practice available'}\nDiscord: ${env.DISCORD_CLIENT_ID?'configured':'not configured'}`));
const cleanup=setInterval(()=>worker.scheduled({},env).catch(e=>console.error('Cleanup failed:',e.message)),60000);cleanup.unref();
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close(()=>{clearInterval(cleanup);db.close();process.exit(0);}));
