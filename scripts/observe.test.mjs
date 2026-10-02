import {test} from 'node:test';
import assert from 'node:assert/strict';
import {collect} from './observe.mjs';
const config={reportUrl:'https://example.test/report',machines:[{id:'mac',url:'https://mac.test',environmentId:'mac-id'}]};
test('offline observation preserves history without claiming current health',async()=>{
  const r=await collect(config,{machines:[{id:'mac',observedVersion:'0.0.40',lastSeenAt:'2026-01-01'}]},async()=>{throw Error('offline')});
  assert.equal(r.machines[0].reachable,false);assert.equal(r.machines[0].observedVersion,'0.0.40');assert.equal(r.preparation,null);assert.equal(r.preparationError,'offline');
});
test('wrong environment never becomes reachable',async()=>{
  const r=await collect(config,{},async()=>({ok:true,json:async()=>({environmentId:'other',serverVersion:'0.0.44'})}));
  assert.equal(r.machines[0].reachable,false);assert.match(r.machines[0].error,/identity/);
});
test('successful observation separates verified commit from observed version',async()=>{
  const r=await collect(config,{},async url=>({ok:true,json:async()=>String(url).includes('report')?{schemaVersion:1,status:'ready',checkedAt:new Date().toISOString(),releaseId:'candidate'}:{environmentId:'mac-id',serverVersion:'0.0.44'}}));
  assert.equal(r.machines[0].observedVersion,'0.0.44');assert.equal(r.machines[0].verifiedCommit,undefined);assert.equal(r.preparation.status,'ready');
});
