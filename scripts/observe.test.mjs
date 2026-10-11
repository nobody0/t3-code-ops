import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {collect,recordProblems,recordFailure,announce,attention} from './observe.mjs';
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
  const r=await collect(config,{},async url=>({ok:true,json:async()=>String(url).includes('report')?{schemaVersion:1,status:'ready',checkedAt:new Date().toISOString(),releaseId:'candidate',releaseUrl:'https://example.test/release',sourceCommit:'abc'}:{environmentId:'mac-id',serverVersion:'0.0.44'}}));
  assert.equal(r.machines[0].observedVersion,'0.0.44');assert.equal(r.machines[0].verifiedCommit,undefined);assert.equal(r.preparation.status,'ready');
});
test('ready report without the fields an agent request needs is rejected',async()=>{
  const r=await collect(config,{},async url=>({ok:true,json:async()=>String(url).includes('report')?{schemaVersion:1,status:'ready',checkedAt:new Date().toISOString()}:{environmentId:'mac-id',serverVersion:'0.0.44'}}));
  assert.equal(r.preparation,null);assert.match(r.preparationError,/Invalid preparation report/);assert.equal(r.machines[0].reachable,true);
});
test('malformed previous observation does not stop a fresh one',async()=>{
  const r=await collect(config,{machines:{}},async()=>{throw Error('offline')});
  assert.equal(r.machines[0].reachable,false);assert.equal(r.machines[0].lastSeenAt,null);
});
test('a continuing problem is counted once and resolved on recovery',async()=>{
  const offline=async()=>{throw Error('offline')};
  const first=await collect(config,{},offline);
  const second=await collect(config,first,offline);
  const open=second.log.filter(e=>!e.resolvedAt);
  assert.deepEqual(open.map(e=>[e.source,e.count]).sort(),[['machine:mac',2],['preparation',2]]);
  const back=await collect(config,second,async url=>({ok:true,json:async()=>String(url).includes('report')?{schemaVersion:1,status:'failed',checkedAt:new Date().toISOString()}:{environmentId:'mac-id',serverVersion:'0.0.44'}}));
  assert.equal(back.log.length,2);assert.ok(back.log.every(e=>e.resolvedAt));
});
test('a changed message resolves the old entry and opens a new one',()=>{
  const a=recordProblems([],[{source:'machine:mac',label:'Mac',message:'HTTP 502'}],'t1');
  const b=recordProblems(a,[{source:'machine:mac',label:'Mac',message:'offline'}],'t2');
  assert.deepEqual(b.map(e=>[e.message,e.resolvedAt]),[['offline',null],['HTTP 502','t2']]);
});
test('the log keeps open problems and only the newest resolved ones',()=>{
  let log=[];
  for(let i=0;i<40;i++) log=recordProblems(log,[{source:'s'+i,label:'s',message:'down'},{source:'s'+(i-1),label:'s',message:null}],'t'+i);
  assert.equal(log.length,30);assert.equal(log.filter(e=>!e.resolvedAt).length,1);assert.equal(log[0].source,'s39');
});
test('a failed run keeps the last observation and logs the failure',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'observe-'));const output=path.join(dir,'status.json');
  try {
    fs.writeFileSync(output,JSON.stringify({schemaVersion:1,checkedAt:'t0',machines:[{id:'mac'}],log:[]}));
    const sent=[];recordFailure(output,Error('config.machines is not iterable'),{now:'2026-01-01T00:00:00.000Z',notifier:n=>sent.push(n)});
    const r=JSON.parse(fs.readFileSync(output,'utf8'));
    assert.equal(r.checkedAt,'t0');assert.equal(r.machines.length,1);
    assert.deepEqual(r.log.map(e=>[e.source,e.message,e.resolvedAt]),[['observer','config.machines is not iterable',null]]);
    assert.equal(sent.length,1);assert.match(sent[0].message,/observer is failing/);assert.equal(r.alerts[0].notifiedAt,'2026-01-01T00:00:00.000Z');
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
const T0=Date.parse('2026-10-11T08:00:00Z'),at=minutes=>new Date(T0+minutes*60000).toISOString();
const ready=(over={})=>({status:'ready',checkedAt:at(0),releaseId:'r2',sourceCommit:'new',releaseUrl:'u',...over});
test('a ready candidate is announced once and stays quiet while it persists',()=>{
  const sent=[],notifier=n=>sent.push(n);
  const status={preparation:ready(),machines:[{id:'mac',label:'Mac',reachable:true,verifiedRelease:'r1',verifiedCommit:'old'}],log:[]};
  const first=announce(status,{},{notifier,now:T0});
  const second=announce(status,first,{notifier,now:T0+300000});
  assert.equal(sent.length,1);assert.match(sent[0].message,/r2 is ready.*Mac/);assert.equal(sent[0].url,'http://localhost:4321/e/t3-maintenance');
  assert.equal(second.alerts[0].notifiedAt,first.alerts[0].notifiedAt);
});
test('an operations-only candidate raises no alert',()=>{
  assert.deepEqual(attention({preparation:ready({sourceCommit:'same'}),machines:[{id:'mac',reachable:true,verifiedRelease:'r1',verifiedCommit:'same'}]},T0),[]);
});
test('an outage alerts after its threshold, once per outage, unless disabled',()=>{
  const log=[{source:'machine:caps',firstAt:at(0),resolvedAt:null},{source:'machine:mac',firstAt:at(0),resolvedAt:null}];
  const machines=[{id:'caps',label:'Caps',reachable:false,error:'HTTP 502'},{id:'mac',label:'Mac',reachable:false,offlineAlertMinutes:null}];
  assert.deepEqual(attention({machines,log},T0+59*60000),[]);
  const alerts=attention({machines,log},T0+60*60000);
  assert.equal(alerts.length,1);assert.match(alerts[0].message,/Caps.*HTTP 502/);
  log[0]={source:'machine:caps',firstAt:at(120),resolvedAt:null};
  assert.notEqual(attention({machines,log},T0+180*60000)[0].key,alerts[0].key);
});
test('stale or failed preparation is announced',()=>{
  assert.match(attention({preparation:ready({checkedAt:at(-9*60)}),machines:[]},T0)[0].message,/eight hours/);
  assert.match(attention({preparation:{status:'failed',checkedAt:at(0),upstreamTag:'v0.0.46'},machines:[]},T0)[0].message,/failed for v0.0.46/);
});
test('a failed delivery is logged and retried on the next run',()=>{
  const status={preparation:ready(),machines:[{id:'mac',reachable:true}],log:[]};
  const failed=announce(status,{},{notifier:()=>{throw Error('no toast')},now:T0});
  assert.equal(failed.alerts[0].notifiedAt,null);assert.equal(failed.log[0].message,'no toast');
  const sent=[];const retried=announce({...status,log:failed.log},failed,{notifier:n=>sent.push(n),now:T0+300000});
  assert.equal(sent.length,1);assert.ok(retried.alerts[0].notifiedAt);assert.ok(retried.log[0].resolvedAt);
});
test('a condition that disappears and returns is not announced again',()=>{
  const sent=[],notifier=n=>sent.push(n),machines=[{id:'mac',reachable:true,verifiedRelease:'r1',verifiedCommit:'old'}];
  const first=announce({preparation:ready(),machines,log:[]},{},{notifier,now:T0});
  const hidden=announce({preparation:ready({checkedAt:at(-9*60)}),machines,log:[]},first,{notifier,now:T0});
  const back=announce({preparation:ready(),machines,log:[]},hidden,{notifier,now:T0});
  assert.deepEqual(sent.map(n=>n.message.slice(0,12)),['T3 candidate','T3 preparati']);assert.equal(back.alerts[0].notifiedAt,first.alerts[0].notifiedAt);
});
test('a delivery failure clears once nothing is left to deliver',()=>{
  const failed=announce({preparation:ready(),machines:[{id:'mac',reachable:true}],log:[]},{},{notifier:()=>{throw Error('no toast')},now:T0});
  const quiet=announce({preparation:null,machines:[],log:failed.log},failed,{notifier:()=>{},now:T0+60000});
  assert.equal(quiet.alerts.length,0);assert.ok(quiet.log.every(e=>e.resolvedAt));
});
