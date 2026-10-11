import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html=fs.readFileSync(new URL('../templates/maintenance.html',import.meta.url),'utf8');
const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
function element(){return {textContent:'',value:'',children:[],append(x){this.children.push(x)},replaceChildren(...x){this.children=x},insertRow(){const r=element();r.insertCell=()=>{const c=element();r.children.push(c);return c;};this.children.push(r);return r;},focus(){},select(){}};}
async function render(data,{brokenStorage=false,missing=false}={}) {
  const elements={};
  const storage=new Map();
  const context={document:{hidden:false,getElementById:id=>elements[id]??=element(),createElement:element,createTextNode:t=>({textContent:t})},ko:{readText:async()=>{if(missing)throw Error('missing');return JSON.stringify(data);}},localStorage:{getItem:k=>{if(brokenStorage)throw Error();return storage.get(k)},setItem:(k,v)=>{if(brokenStorage)throw Error();storage.set(k,v)}},navigator:{clipboard:{writeText:async()=>{throw Error('blocked')}}},window:{addEventListener(){}},setInterval:()=>1,clearInterval(){},Date,JSON,Number};
  vm.runInNewContext(script,context);await new Promise(r=>setImmediate(r));return {elements,context};
}
const sample=()=>({schemaVersion:1,checkedAt:new Date().toISOString(),preparation:{status:'ready',checkedAt:new Date().toISOString(),releaseId:'release-1',sourceCommit:'abc',releaseUrl:'https://github.com/example'},machines:[{id:'mac',label:'Mac',reachable:false}]});
test('blocked storage and clipboard leave reminder and copyable request usable',async()=>{
  const {elements:e}=await render(sample(),{brokenStorage:true});
  assert.match(e['t3-maintenance-status'].textContent,/ready/);
  assert.match(e['t3-maintenance-request'].value,/Mac/);
  await e['t3-maintenance-copy'].onclick();e['t3-maintenance-dismiss'].onclick();
  assert.match(e['t3-maintenance-status'].textContent,/storage is unavailable/);
});
test('missing cache never claims current state',async()=>{const {elements:e}=await render(null,{missing:true});assert.match(e['t3-maintenance-status'].textContent,/unknown/);});
test('stale observation is clearly unknown',async()=>{const data=sample();data.checkedAt='2000-01-01';const {elements:e}=await render(data);assert.match(e['t3-maintenance-status'].textContent,/stale/);});
test('dismissal is scoped to one candidate',async()=>{
  const data=sample(),{elements:e,context}=await render(data);
  e['t3-maintenance-dismiss'].onclick();await new Promise(r=>setImmediate(r));assert.match(e['t3-maintenance-status'].textContent,/dismissed/);
  data.preparation.releaseId='release-2';context.ko.readText=async()=>JSON.stringify(data);
  await e['t3-maintenance-refresh'].onclick();assert.doesNotMatch(e['t3-maintenance-status'].textContent,/dismissed/);
});
test('an operations-only candidate is not pending where its source is verified',async()=>{
  const data=sample();data.machines=[{id:'mac',label:'Mac',reachable:true,verifiedRelease:'release-0',verifiedCommit:'abc'}];
  const {elements:e}=await render(data);
  assert.match(e['t3-maintenance-status'].textContent,/only changes operations tooling/);assert.match(e['t3-maintenance-request'].value,/No T3 release update is pending/);
  data.machines[0].verifiedCommit='old';const again=await render(data);
  assert.match(again.elements['t3-maintenance-status'].textContent,/ready for agent review/);
});
test('a failing observer is reported with its logged problems',async()=>{
  const data=sample();data.log=[{source:'observer',label:'Observer',message:'boom',firstAt:data.checkedAt,lastAt:data.checkedAt,count:3,resolvedAt:null},{source:'machine:mac',label:'Mac',message:'offline',firstAt:data.checkedAt,lastAt:data.checkedAt,count:1,resolvedAt:data.checkedAt}];
  const {elements:e}=await render(data);
  assert.match(e['t3-maintenance-status'].textContent,/observer is failing: boom/);assert.match(e['t3-maintenance-request'].value,/observe\.mjs/);
  const rows=e['t3-maintenance-log'].children[0].children;assert.equal(rows.length,3);
  assert.deepEqual(rows[1].children.map(c=>c.textContent).filter((_,i)=>[0,1,4,5].includes(i)),['Observer','boom','3','Ongoing']);
});
test('an observation without machines still shows its log',async()=>{
  const {elements:e}=await render({schemaVersion:1,log:[]});
  assert.match(e['t3-maintenance-status'].textContent,/stale/);assert.equal(e['t3-maintenance-log'].children[0].textContent,'No problems recorded.');
});
