import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import net from 'node:net';
import {run,atomicJson} from './ko-release.mjs';

export function databaseState(baseDir) {
  const file=path.join(baseDir,'userdata/state.sqlite');
  if (!fs.existsSync(file)) return null;
  const db=new DatabaseSync(file,{readOnly:true});
  try {
    const integrity=db.prepare('PRAGMA integrity_check').all();
    if (integrity.length!==1 || Object.values(integrity[0])[0]!=='ok') throw Error('Database integrity check failed');
    const migrations=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%migration%' ORDER BY name").all()
      .map(({name})=>({name,rows:db.prepare(`SELECT * FROM "${name.replaceAll('"','""')}" ORDER BY 1`).all()}));
    return {migrations,integrity:'ok'};
  } finally {db.close();}
}
export async function assertIdle(c) {
  if (!fs.existsSync(path.join(c.baseDir,'userdata/state.sqlite'))) return;
  const environmentId=fs.readFileSync(path.join(c.baseDir,'userdata/environment-id'),'utf8').trim();
  let argv=c.initialCli;
  if(!argv) {
    const current=c.platform && c.platform!=='linux' ? JSON.parse(fs.readFileSync(path.join(c.root,'current.json'),'utf8')).target : fs.realpathSync(path.join(c.root,'current'));
    argv=[c.node,path.join(current,'node_modules/t3/dist/bin.mjs')];
  }
  const helper=path.resolve(import.meta.dirname,'../ko-session.mjs');
  const result=JSON.parse(run(c.node,[helper,'idle','--home-dir',c.baseDir,'--origin',`http://127.0.0.1:${c.port}`,'--environment-id',environmentId,'--t3-command',JSON.stringify(argv)]));
  if(result.status!=='idle') throw Error('Machine is busy or idle inspection failed; defer activation.');
}
export function snapshotStoppedHome(c, previous) {
  const state=databaseState(c.baseDir);
  const backup=path.join(c.root,'backups',new Date().toISOString().replaceAll(':','-'));
  fs.mkdirSync(backup,{recursive:true,mode:0o700});
  for (const name of ['state.sqlite','state.sqlite-wal','state.sqlite-shm','settings.json','keybindings.json','environment-id','secrets']) {
    const source=path.join(c.baseDir,'userdata',name);
    if(fs.existsSync(source)) fs.cpSync(source,path.join(backup,name),{recursive:true,dereference:false});
  }
  atomicJson(path.join(backup,'recovery.json'),{createdAt:new Date().toISOString(),baseDir:c.baseDir,previous,state});
  return {backup,before:state};
}
export async function assertStopped(c) {
  await new Promise((resolve,reject)=>{
    const socket=net.connect({host:'127.0.0.1',port:c.port});
    socket.setTimeout(2000);
    socket.once('connect',()=>{socket.destroy();reject(Error('T3 port is still listening; stopped-home backup refused.'));});
    socket.once('timeout',()=>{socket.destroy();reject(Error('Could not establish that T3 stopped.'));});
    socket.once('error',e=>{socket.destroy();if(e.code==='ECONNREFUSED')resolve();else reject(e);});
  });
}
export function requireSafeBinaryRollback(c,journal) {
  if (fs.existsSync(path.join(c.baseDir,'userdata/state.sqlite')))
    throw Error('Live database exists: binary-only rollback is disabled. An agent must review the recorded backup and migrations; never overwrite newer work automatically.');
}
export function verifyMigrationSource(c,target) {
  if(!fs.existsSync(path.join(c.baseDir,'userdata/state.sqlite'))) return;
  if(!c.migrationSource) throw Error('Configure migrationSource to the verified candidate checkout before upgrading a database.');
  const manifest=JSON.parse(fs.readFileSync(path.join(target,'release.json'),'utf8'));
  const commit=run('git',['rev-parse','HEAD'],{cwd:c.migrationSource});
  if(commit!==manifest.commit || run('git',['status','--porcelain','--untracked-files=no'],{cwd:c.migrationSource})) throw Error('Migration source must be clean and match the installed candidate commit.');
  for(const p of ['apps/server/node_modules/effect/dist/Effect.js','apps/server/src/persistence/Migrations.ts','packages/shared/src/nodeSqliteClient.ts'])
    if(!fs.existsSync(path.join(c.migrationSource,p))) throw Error('Migration source dependencies are missing.');
}
export async function rehearseMigrations(c,target,safety) {
  if(!safety.before) return;
  verifyMigrationSource(c,target);
  const script=path.resolve(import.meta.dirname,'../rehearse-migrations.mjs');
  const report=JSON.parse(run(c.node,[script,c.migrationSource,safety.backup],{timeout:120000}));
  atomicJson(path.join(safety.backup,'migration-report.json'),report);
}
