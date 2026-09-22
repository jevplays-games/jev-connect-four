import {readFile} from 'node:fs/promises';
import {auditExport} from '../server/audit.js';
import {replay} from '../public/rules.js';
import {canonical} from '../server/util.js';
const replayOnly=process.argv.includes('--replay-only'),files=process.argv.slice(2).filter(a=>a!=='--replay-only');
if(!files.length){console.error('Usage: npm run audit -- match-audit.json [more.json] [--replay-only]');process.exit(2);}
let failed=false;
for(const file of files){try{const data=JSON.parse(await readFile(file,'utf8'));
  if(replayOnly){const actions=data.actions||data.match?.actions,state=replay(actions);const ok=!data.match?.state||canonical(state)===canonical(data.match.state);
    console.log(JSON.stringify({file,ok,moves:actions.length,assurance:'Replay legality only; does not prove JEV provenance, authenticity or ranking eligibility.'},null,2));failed||=!ok;}
  else{const result=await auditExport(data);console.log(JSON.stringify({file,...result},null,2));failed||=!result.ok;}
}catch(error){console.error(JSON.stringify({file,ok:false,error:error.message}));failed=true;}}
process.exitCode=failed?1:0;
