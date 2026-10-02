import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {databaseState,snapshotStoppedHome,requireSafeBinaryRollback,installedCli,parseMigrationReport} from './lib/ko-safety.mjs';
import {nativeManage} from './lib/ko-deployment-native.mjs';
test('rollback cannot replace binaries against a migrated live database',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'t3-safety-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const c={root,baseDir:path.join(root,'home'),platform:'darwin',unitDirectory:path.join(root,'units'),service:'test',port:3773};
  fs.mkdirSync(path.join(c.baseDir,'userdata'),{recursive:true});
  const db=new DatabaseSync(path.join(c.baseDir,'userdata/state.sqlite'));
  db.exec('CREATE TABLE effect_sql_migrations (id INTEGER); INSERT INTO effect_sql_migrations VALUES (54);');db.close();
  const backup=snapshotStoppedHome(c,{});
  assert.equal(backup.before.integrity,'ok');assert.ok(fs.existsSync(path.join(backup.backup,'state.sqlite')));
  assert.equal(databaseState(c.baseDir).migrations[0].rows[0].id,54);
  assert.throws(()=>requireSafeBinaryRollback(c,{}),/binary-only rollback is disabled/);
  fs.writeFileSync(path.join(root,'activation.json'),JSON.stringify({config:c,phase:'active',previous:{}}));
  let restored=false;
  await assert.rejects(nativeManage(c,'rollback',undefined,{adapter:{restore:()=>{restored=true;}}}),/binary-only rollback is disabled/);
  assert.equal(restored,false);
});
test('after initial Mac migration, idle checks use the selected CLI instead of the old fallback',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'t3-cli-selection-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const c={root,platform:'darwin',node:process.execPath,initialCli:['old-node','old-cli']};
  assert.deepEqual(installedCli(c),c.initialCli);
  const target=path.join(root,'releases/new');
  fs.writeFileSync(path.join(root,'current.json'),JSON.stringify({target}));
  assert.deepEqual(installedCli(c),[c.node,path.join(target,'node_modules/t3/dist/bin.mjs')]);
});
test('upstream migration logging cannot hide or corrupt the final integrity report',()=>{
  const report={applied:[[54,'migration']],events:[{count:141748}],integrity:[{integrity_check:'ok'}]};
  assert.deepEqual(parseMigrationReport('INFO: Migrations ran successfully\n'+JSON.stringify(report)+'\n'),report);
  assert.throws(()=>parseMigrationReport('INFO: success only'));
  assert.throws(()=>parseMigrationReport(JSON.stringify({...report,integrity:[{integrity_check:'corrupt'}]})));
});
