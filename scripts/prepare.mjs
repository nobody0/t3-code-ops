import fs from 'node:fs';
import path from 'node:path';
import {github,git} from './github.mjs';
const ops=git(['rev-parse','HEAD']);
const latest=await github('/repos/pingdotgg/t3code/releases/latest');
if(latest.draft || latest.prerelease || !/^v\d+\.\d+\.\d+$/.test(latest.tag_name)) throw Error('Expected a stable upstream release');
const tag=latest.tag_name;
const forkBaseCommit=(await github('/repos/nobody0/t3code/commits/main')).sha;
let previous;
try { const r=await fetch('https://github.com/nobody0/t3-code-ops/releases/download/maintenance-status/latest.json'); if(r.ok) previous=await r.json(); } catch {}
const unchanged=previous?.upstreamTag===tag && previous?.opsCommit===ops && [previous?.forkBaseCommit,previous?.sourceCommit].includes(forkBaseCommit) && previous?.status==='ready' && process.env.FORCE_PREPARE!=='true';
const report={schemaVersion:1,checkedAt:new Date().toISOString(),upstreamTag:tag,upstreamUrl:latest.html_url,opsCommit:ops,forkBaseCommit,status:'preparing',reportUrl:`https://github.com/nobody0/t3-code-ops/actions/runs/${process.env.GITHUB_RUN_ID}`};
function output(name,value) {if(process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT,`${name}=${value}\n`);}
fs.mkdirSync('work',{recursive:true});
if(unchanged) {
  fs.writeFileSync('work/report.json',JSON.stringify({...previous,checkedAt:report.checkedAt},null,2));
  output('build','false');
} else {
  try {
    const branch=`candidate/${tag}-${forkBaseCommit.slice(0,12)}-${ops.slice(0,12)}`;
    const fork='https://github.com/nobody0/t3code.git';
    const exists=git(['ls-remote',fork,`refs/heads/${branch}`]);
    const source=path.resolve('work/source');
    git(['clone','--branch',exists?branch:'main',fork,source]);
    git(['fetch','https://github.com/pingdotgg/t3code.git',`refs/tags/${tag}`],source);
    const upstreamCommit=git(['rev-parse','FETCH_HEAD'],source);
    if(!exists) {
      git(['config','user.name','T3 maintenance'],source);git(['config','user.email','t3-ops@users.noreply.github.com'],source);
      git(['merge','--no-edit',upstreamCommit],source);
      for(const file of ['apps/server/package.json','apps/web/package.json','apps/desktop/package.json','packages/contracts/package.json']) {
        const p=path.join(source,file),json=JSON.parse(fs.readFileSync(p,'utf8'));json.version=tag.slice(1);
        if(file==='apps/server/package.json') json.repository={...json.repository,url:'https://github.com/nobody0/t3code'};
        fs.writeFileSync(p,JSON.stringify(json,null,2)+'\n');
      }
      git(['config','user.name','T3 maintenance'],source);git(['config','user.email','t3-ops@users.noreply.github.com'],source);
      git(['add','apps','packages/contracts/package.json'],source);
      if(git(['diff','--cached','--name-only'],source)) git(['commit','-m',`Prepare managed T3 ${tag} (${ops.slice(0,12)})`],source);
      git(['push','git@github.com:nobody0/t3code.git',`HEAD:refs/heads/${branch}`],source);
    }
    const commit=git(['rev-parse','HEAD'],source);
    Object.assign(report,{sourceCommit:commit,sourceRef:`refs/heads/${branch}`,upstreamCommit});
    output('build','true');output('source_ref',report.sourceRef);output('commit',commit);
    fs.writeFileSync('work/report.json',JSON.stringify(report,null,2));
  } catch(e) {
    fs.writeFileSync('work/report.json',JSON.stringify({...report,status:'needs-review',error:'Candidate preparation failed; inspect the workflow log.'},null,2));
    throw e;
  }
}
