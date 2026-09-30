/** Production mode: NODE_ENV=production, or an https APP_ORIGIN on a non-loopback host (hosts may override NODE_ENV). */
export function isProduction(env=process.env) {
  if(env.NODE_ENV==='production')return true;
  try{const u=new URL(env.APP_ORIGIN||'');return u.protocol==='https:'&&!['localhost','127.0.0.1','[::1]'].includes(u.hostname);}catch{return false;}
}
