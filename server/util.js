export class HttpError extends Error {
  constructor(status, code, details = null) { super(code); this.status=status; this.code=code; this.details=details; }
}
export function assert(condition,status,code,details) { if (!condition) throw new HttpError(status,code,details); }
export const now = env => env.CLOCK ? env.CLOCK() : Date.now();
export const utf8 = s => new TextEncoder().encode(s);
export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).filter(k => value[k] !== undefined).sort().map(k => JSON.stringify(k)+':'+canonical(value[k])).join(',') + '}';
}
export async function sha256(value) {
  const bytes = typeof value === 'string' ? utf8(value) : value;
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');
}
export function randomToken(bytes=32) { return [...crypto.getRandomValues(new Uint8Array(bytes))].map(x=>x.toString(16).padStart(2,'0')).join(''); }
export async function hmac(secret, data) {
  const key=await crypto.subtle.importKey('raw',utf8(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC',key,utf8(data)))].map(x=>x.toString(16).padStart(2,'0')).join('');
}
export function equal(a,b) {
  if (typeof a!=='string'||typeof b!=='string'||a.length!==b.length) return false;
  let diff=0; for(let i=0;i<a.length;i++) diff|=a.charCodeAt(i)^b.charCodeAt(i); return diff===0;
}
export function json(data,status=200,headers={}) {
  return new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8',...headers}});
}
export async function readJSON(request,limit=4096) {
  assert(request.headers.get('content-type')?.split(';')[0].trim()==='application/json',415,'JSON_REQUIRED');
  const text=await readText(request,limit);
  try { const value=JSON.parse(text); assert(value&&typeof value==='object'&&!Array.isArray(value),400,'OBJECT_REQUIRED'); return value; }
  catch(e) { if(e instanceof HttpError) throw e; throw new HttpError(400,'INVALID_JSON'); }
}
export async function readText(request,limit) {
  assert(Number(request.headers.get('content-length')||0)<=limit,413,'BODY_TOO_LARGE');
  const reader=request.body?.getReader(); if(!reader) return '';
  let size=0; const chunks=[];
  while(true) { const {done,value}=await reader.read(); if(done) break; size+=value.length;
    if(size>limit) { await reader.cancel(); throw new HttpError(413,'BODY_TOO_LARGE'); } chunks.push(value); }
  const all=new Uint8Array(size); let offset=0; for(const c of chunks) {all.set(c,offset);offset+=c.length;}
  return new TextDecoder().decode(all);
}
export function secureResponse(response) {
  const h=new Headers(response.headers);
  h.set('X-Content-Type-Options','nosniff'); h.set('Referrer-Policy','no-referrer');
  h.set('X-Frame-Options','DENY'); h.set('Permissions-Policy','camera=(), microphone=(), geolocation=()');
  h.set('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  h.set('Cache-Control','no-store');
  return new Response(response.body,{status:response.status,headers:h});
}
export function parseIdempotency(request) {
  const key=request.headers.get('Idempotency-Key');
  assert(typeof key==='string'&&/^[A-Za-z0-9_-]{8,100}$/.test(key),400,'IDEMPOTENCY_KEY_REQUIRED'); return key;
}
export function int(value,min,max,defaultValue) {
  if(value===null||value===undefined) return defaultValue;
  const n=Number(value); assert(Number.isInteger(n)&&n>=min&&n<=max,400,'INVALID_INTEGER'); return n;
}
export function safeConfig(env) {
  return {model:env.JEV_MODEL||'jev-1.13.0',inputUsdPerMillion:Number(env.JEV_INPUT_USD_PER_MILLION||0),
    outputUsdPerMillion:Number(env.JEV_OUTPUT_USD_PER_MILLION||0),appVersion:'1.0.0'};
}
