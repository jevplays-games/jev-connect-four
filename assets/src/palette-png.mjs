// Indexed PNG encoding using only Node built-ins; frequent colors preserve flat UI art.
import { deflateSync } from 'node:zlib';
const crcTable=Array.from({length:256},(_,n)=>{for(let k=0;k<8;k++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
function chunk(type,data){const t=Buffer.from(type),out=Buffer.alloc(data.length+12);out.writeUInt32BE(data.length);t.copy(out,4);data.copy(out,8);let c=0xffffffff;for(const v of Buffer.concat([t,data]))c=crcTable[(c^v)&255]^(c>>>8);out.writeUInt32BE((c^0xffffffff)>>>0,out.length-4);return out;}
export function palettePNG(rgba,width,height){
 const counts=new Map();for(let i=0;i<rgba.length;i+=4){const c=(rgba[i]<<16)|(rgba[i+1]<<8)|rgba[i+2];counts.set(c,(counts.get(c)||0)+1);}
 const colors=[...counts].sort((a,b)=>b[1]-a[1]).slice(0,256).map(([c])=>[c>>16,(c>>8)&255,c&255]);
 const indices=new Map();for(const c of counts.keys()){const r=c>>16,g=(c>>8)&255,b=c&255;let best=Infinity,index=0;colors.forEach(([pr,pg,pb],i)=>{const d=(r-pr)**2+(g-pg)**2+(b-pb)**2;if(d<best){best=d;index=i;}});indices.set(c,index);}
 const raw=Buffer.alloc((width+1)*height);for(let y=0;y<height;y++)for(let x=0;x<width;x++){const i=(y*width+x)*4;raw[y*(width+1)+x+1]=indices.get((rgba[i]<<16)|(rgba[i+1]<<8)|rgba[i+2]);}
 const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=3;
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('PLTE',Buffer.from(colors.flat())),chunk('IDAT',deflateSync(raw,{level:9})),chunk('IEND',Buffer.alloc(0))]);
}
