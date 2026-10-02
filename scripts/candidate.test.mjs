import {test} from 'node:test';
import assert from 'node:assert/strict';
import {needsPreparation} from './lib/ko-candidate.mjs';
const previous={status:'ready',upstreamTag:'v1.2.3',opsCommit:'ops',forkBaseCommit:'base',sourceCommit:'source'};
const current={tag:'v1.2.3',opsCommit:'ops',forkBaseCommit:'base'};
test('unchanged successful preparation and promotion do not rebuild',()=>{assert.equal(needsPreparation(previous,current),false);assert.equal(needsPreparation(previous,{...current,forkBaseCommit:'source'}),false);});
test('new stable, fork change, tooling change, failure and manual retry prepare',()=>{for(const change of [{tag:'v1.2.4'},{opsCommit:'new'},{forkBaseCommit:'changed'},{force:true}])assert.equal(needsPreparation(previous,{...current,...change}),true);assert.equal(needsPreparation({...previous,status:'failed'},current),true);});
