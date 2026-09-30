import test from 'node:test';
import assert from 'node:assert/strict';
import {isProduction} from '../scripts/mode.mjs';
test('production detection follows NODE_ENV or a public https origin',()=>{
  assert.equal(isProduction({NODE_ENV:'production'}),true);
  assert.equal(isProduction({NODE_ENV:'development',APP_ORIGIN:'https://connect-four.jevplay.games'}),true);
  assert.equal(isProduction({APP_ORIGIN:'https://connect-four.jevplay.games'}),true);
  assert.equal(isProduction({APP_ORIGIN:'http://localhost:8787'}),false);
  assert.equal(isProduction({APP_ORIGIN:'https://localhost'}),false);
  assert.equal(isProduction({APP_ORIGIN:'http://example.com'}),false);
  assert.equal(isProduction({}),false);
});
