import {localDecision} from './policy.js';
self.onmessage = ({data}) => {
  try { self.postMessage({id:data.id, decision:localDecision(data.state,data.difficulty)}); }
  catch(e) { self.postMessage({id:data.id,error:e.message}); }
};
