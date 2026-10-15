import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {summarize,flattenEvidence,csv} from '../public/analytics.js';
const args=process.argv.slice(2),outIndex=args.indexOf('--out'),out=resolve(outIndex>=0?args[outIndex+1]:'analytics-report');
if(outIndex>=0)args.splice(outIndex,2);
if(!args.length){console.error('Usage: npm run report -- audit.json [more.json] --out report-directory');process.exit(2);}
const exports=[];
for(const file of args){const data=JSON.parse(await readFile(file,'utf8'));if(data.runs)exports.push(...data.runs);else exports.push(data);}
if(exports.some(e=>!e.match||!Array.isArray(e.events)))throw new Error('Expected complete audit exports or benchmark bundles.');
const summary=summarize(exports),tables=flattenEvidence(exports);
await mkdir(out,{recursive:true});
await writeFile(resolve(out,'summary.json'),JSON.stringify(summary,null,2));
for(const [name,data] of Object.entries(tables))await writeFile(resolve(out,`${name}.csv`),csv(data));
const esc=s=>String(s??'—').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const num=n=>Number.isFinite(n)?n.toLocaleString(undefined,{maximumFractionDigits:3}):'—';
const table=(headers,rows)=>`<table><thead><tr>${headers.map(h=>`<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(r=>`<tr>${r.map(c=>`<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
const cards=[['Matches',summary.outcomes.matches],['Verified results',summary.outcomes.verified],['Model decisions',summary.jev.modelDecisions],['Audit events',summary.eventCount]];
const html=`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Choice Four · Evidence report</title>
<style>/* jevplay.games palette: ink #1E1E1E, pink #F386A1, grey #DEDEDE, paper #FEFEFE. Pink is never text on a light ground. */body{font:15px/1.6 system-ui;background:#FEFEFE;color:#1E1E1E;max-width:1100px;margin:40px auto;padding:0 24px}h1{font-weight:700;letter-spacing:-.02em}h2{margin-top:36px}p,small{color:#333333}.tag{display:inline-block;margin:0;padding:2px 10px;background:#1E1E1E;color:#F386A1;font:13px/1.7 ui-monospace,monospace;letter-spacing:.08em}.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:15px}.card{padding:20px;background:#DEDEDE;border:1px solid #1E1E1E;box-shadow:3px 3px 0 #1E1E1E}.card strong{font-size:32px;display:block;color:#1E1E1E}table{width:100%;border-collapse:collapse;font-size:13px}th,td{padding:10px;text-align:left;border-bottom:1px solid #DEDEDE}th{color:#1E1E1E;border-bottom-color:#1E1E1E}pre{white-space:pre-wrap;background:#DEDEDE;padding:18px;border:1px solid #1E1E1E;overflow-wrap:anywhere}a{color:#1E1E1E}.scroll{overflow-x:auto}@media(max-width:600px){.cards{grid-template-columns:1fr 1fr}}</style>
<p class="tag">JEVPLAY.GAMES / RESEARCH ANALYTICS</p><h1>Choice Four evidence report</h1><p>${exports.length} selected exports · generated ${esc(summary.generatedAt)}. Diagnostic completeness and trust are source-dependent.</p>
<div class="cards">${cards.map(([k,v])=>`<div class="card"><small>${k}</small><strong>${num(v)}</strong></div>`).join('')}</div>
<h2>Outcome cohorts</h2><div class="scroll">${table(['Difficulty','Opponent version','Human disc','Mode','Matches','Verified','W / L / D','Result rate'],summary.cohorts.map(c=>[c.difficulty,c.opponentVersion,c.humanDisc,c.mode,c.matches,c.verified,`${c.wins} / ${c.losses} / ${c.draws}`,num(c.resultRate)]))}</div>
<h2>Latency distributions</h2>${table(['Metric','n','Mean','p50','p90','p95','p99'],Object.entries(summary.latency).map(([k,v])=>[k,v.n,num(v.mean),num(v.p50),num(v.p90),num(v.p95),num(v.p99)]))}
<h2>Tactical observations</h2>${table(['Actor','Moves','Immediate-win opportunities','Missed wins','Blockable threats','Neutralized threats','Avoidable immediate losses'],Object.entries(summary.tactics).map(([actor,v])=>[actor,v.moves,v.immediateWinOpportunities,v.missedImmediateWins,v.blockableThreatTurns,v.threatsNeutralized,v.avoidableImmediateLosses]))}
<h2>Model, search and reliability</h2><pre>${esc(JSON.stringify(summary.jev,null,2))}</pre><h2>Cost accounting</h2><pre>${esc(JSON.stringify(summary.cost,null,2))}</pre>
<h2>Machine-readable tables</h2><p>${Object.keys(tables).map(name=>`<a href="${name}.csv">${name}.csv</a>`).join(' · ')} · <a href="summary.json">summary.json</a></p>
<h2>Interpretation limits</h2>${summary.notes.map(n=>`<p>${esc(n)}</p>`).join('')}<p>This report derives statistics; it does not replace the independent audit command. No provider confidence is treated as a calibrated win probability.</p></html>`;
await writeFile(resolve(out,'report.html'),html);console.log(out);
