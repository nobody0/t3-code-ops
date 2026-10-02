import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {atomicJson,readJson,digest} from './lib/ko-release.mjs';
const repo='nobody0/t3-code-ops';
const gh=args=>execFileSync('gh',args,{encoding:'utf8',stdio:['ignore','pipe','inherit']});
let report;
try {report=readJson('work/report.json');} catch {report={schemaVersion:1,status:'failed',checkedAt:new Date().toISOString(),error:'Preparation did not produce a report.'};}
if(process.env.BUILD_REQUIRED==='true') {
  if(process.env.BUILD_RESULT!=='success' || process.env.PLATFORM_RESULT!=='success') {
    report.status='failed';report.error='Build or platform validation failed. This candidate is not approved for deployment.';
  } else {
    const root='work/artifact';
    const m=readJson(path.join(root,'release.json'));
    const keys=['linux-x64','win32-x64','darwin-arm64','darwin-x64'];
    const platformLocks={};
    for(const key of keys) {
      const receipt=readJson(path.join(root,'locks',key,'receipt.json'));
      platformLocks[key]={};
      for(const f of ['package.json','package-lock.json']) {
        const hash=digest(path.join(root,'locks',key,f));
        if(receipt[f]!==hash) throw Error('Platform validation receipt mismatch');
        platformLocks[key][f]=hash;
      }
    }
    atomicJson(path.join(root,'release.json'),{...m,schemaVersion:2,platformLocks});
    const archive=path.join('work',m.releaseId+'.tar.gz');
    execFileSync('tar',['-czf',archive,'-C',root,'.']);
    const manifest=readJson(path.join(root,'release.json'));
    atomicJson('work/test-report.json',{sourceCommit:m.commit,opsCommit:m.opsCommit,platforms:keys,checks:['ops-tests','guard-tests','build','locked-install','native-terminal','isolated-startup'],workflow:report.reportUrl});
    const tag=m.releaseId;
    const exists=(()=>{try {gh(['release','view',tag,'--repo',repo]);return true;}catch{return false;}})();
    let publishedHash=digest(archive);
    if(!exists) gh(['release','create',tag,archive,path.join(root,'release.json'),'work/test-report.json','--repo',repo,'--prerelease','--target',m.opsCommit,'--title',`Prepared T3 ${m.version}`,'--notes',`Tested candidate ${m.commit}. Agent approval and target migration rehearsal are required before activation.`]);
    else {
      fs.mkdirSync('work/existing',{recursive:true});
      gh(['release','download',tag,'--repo',repo,'--pattern','release.json','--pattern',path.basename(archive),'--dir','work/existing','--clobber']);
      const existing=readJson('work/existing/release.json');
      if(JSON.stringify(existing)!==JSON.stringify(manifest)) {
        report.status='failed';report.error='Immutable release already exists with different build or locks; change the operations revision before preparing again.';
      }
      publishedHash=digest(path.join('work/existing',path.basename(archive)));
    }
    if(report.status!=='failed') Object.assign(report,{status:'ready',releaseId:m.releaseId,version:m.version,sourceCommit:m.commit,archiveSha256:publishedHash,platforms:keys,releaseUrl:`https://github.com/${repo}/releases/tag/${tag}`});
  }
}
report.checkedAt=new Date().toISOString();
atomicJson('work/latest.json',report);
try {gh(['release','view','maintenance-status','--repo',repo]);}catch {gh(['release','create','maintenance-status','--repo',repo,'--prerelease','--title','Maintenance status','--notes','Mutable preparation status. No production credentials or machine inventory.']);}
gh(['release','upload','maintenance-status','work/latest.json','--repo',repo,'--clobber']);
