/** Exact endgame minimax when the entire remaining tree fits the declared limit.
 * This is a reference algorithm, not a full-game Connect Four solver or a production opponent. */
import {getLegalActions,applyAction} from '../public/rules.js';
export function solveEndgame(state,disc=state.toMove,{maxEmpty=8,maxNodes=200000}={}) {
  if(42-state.ply>maxEmpty)return {exact:false,reason:'outside_endgame_window',nodes:0,bounds:[-1,1],optimalColumns:null};
  const cache=new Map();let nodes=0,exhausted=false;
  function visit(s){
    if(s.status!=='active')return s.winner===null?0:s.winner===disc?1:-1;
    if(nodes++>=maxNodes){exhausted=true;return null;}
    const key=s.board.join('')+s.toMove;if(cache.has(key))return cache.get(key);
    const maximize=s.toMove===disc;let best=maximize?-1:1;
    for(const a of getLegalActions(s)){
      const value=visit(applyAction(s,a));if(value===null)return null;
      best=maximize?Math.max(best,value):Math.min(best,value);
      if((maximize&&best===1)||(!maximize&&best===-1))break;
    }
    cache.set(key,best);return best;
  }
  const actions=[];
  for(const a of getLegalActions(state)){const value=visit(applyAction(state,a));actions.push({column:a.column,value});if(value===null)break;}
  if(exhausted||actions.some(a=>a.value===null))return {exact:false,reason:'node_budget',nodes,bounds:[-1,1],optimalColumns:null,actions};
  const value=actions.length?Math.max(...actions.map(a=>a.value)):(state.winner===null?0:state.winner===disc?1:-1);
  return {exact:true,nodes,bounds:[value,value],value,actions,optimalColumns:actions.filter(a=>a.value===value).map(a=>a.column)};
}
