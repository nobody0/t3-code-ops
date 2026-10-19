import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {DatabaseSync,backup as backupDatabase} from 'node:sqlite';
const [source,backup]=process.argv.slice(2).map(x=>path.resolve(x));
const load=p=>import(pathToFileURL(path.join(source,p)));
const effect=p=>['dist','dist/unstable'].map(d=>`apps/server/node_modules/effect/${d}/${p}`).find(x=>fs.existsSync(path.join(source,x)));
const Effect=await load('apps/server/node_modules/effect/dist/Effect.js');
const SqlClient=await load(effect('sql/SqlClient.js'));
const NodeSqlite=await load('packages/shared/src/nodeSqliteClient.ts');
const {runMigrations}=await load('apps/server/src/persistence/Migrations.ts');
const scratch=fs.mkdtempSync(path.join(backup,'rehearsal-'));
const copy=name=>{for(const suffix of ['','-wal','-shm']) if(fs.existsSync(path.join(backup,name+suffix))) fs.copyFileSync(path.join(backup,name+suffix),path.join(scratch,name+suffix),fs.constants.COPYFILE_EXCL);};
// A V2 candidate migrates statev2.sqlite; on first start the server seeds it as a snapshot of the V1 database.
const v2=fs.existsSync(path.join(source,'apps/server/src/persistence/initializeV2Database.ts'));
let target;
if(v2 && fs.existsSync(path.join(backup,'statev2.sqlite'))) {copy('statev2.sqlite');target=path.join(scratch,'statev2.sqlite');}
else {
  copy('state.sqlite');target=path.join(scratch,'state.sqlite');
  if(v2) {
    const v1=new DatabaseSync(target,{readOnly:true});
    try {await backupDatabase(v1,path.join(scratch,'statev2.sqlite'));} finally {v1.close();}
    target=path.join(scratch,'statev2.sqlite');
  }
}
const result=await Effect.runPromise(Effect.gen(function*(){
  const sql=yield* SqlClient.SqlClient;
  const [{last}]=yield* sql`SELECT COALESCE(MAX(sequence),0) AS last FROM orchestration_events`;
  // Existing events must survive unchanged; V2 appends one project.created event per existing project.
  const existing=()=>sql`SELECT COUNT(*) AS count, COALESCE(SUM(LENGTH(payload_json)),0) AS bytes FROM orchestration_events WHERE sequence<=${last}`;
  const before=yield* existing();
  const applied=yield* runMigrations();
  const after=yield* existing();
  const appended=yield* sql`SELECT event_type AS type, COUNT(*) AS count FROM orchestration_events WHERE sequence>${last} GROUP BY event_type ORDER BY event_type`;
  const integrity=yield* sql`PRAGMA integrity_check`;
  if(JSON.stringify(before)!==JSON.stringify(after)) throw Error('Migration changed existing events');
  if(integrity.some(x=>x.integrity_check!=='ok')) throw Error('Migration damaged database integrity');
  return {database:path.basename(target),applied,events:after,appended,integrity};
}).pipe(Effect.provide(NodeSqlite.layer({filename:target})),Effect.scoped));
console.log(JSON.stringify(result));
