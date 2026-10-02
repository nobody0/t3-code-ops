import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {atomicJson} from './lib/ko-release.mjs';

export async function collect(config, previous = {}, fetcher = fetch) {
  const now = new Date().toISOString();
  async function json(url) {
    const r = await fetcher(url, {signal: AbortSignal.timeout(8000), headers: {'User-Agent':'t3-code-ops'}});
    if (!r.ok) throw Error(`HTTP ${r.status}`);
    return r.json();
  }
  let preparation = previous.preparation ?? null, preparationError = null;
  try {
    const next = await json(config.reportUrl);
    if (next.schemaVersion !== 1 || !['ready','failed','preparing','needs-review'].includes(next.status)
        || !Number.isFinite(Date.parse(next.checkedAt))) throw Error('Invalid preparation report');
    preparation = next;
  } catch (e) { preparationError = e.message; }
  const machines = await Promise.all(config.machines.map(async m => {
    const last = previous.machines?.find(x => x.id === m.id);
    try {
      const d = await json(new URL('/.well-known/t3/environment', m.url));
      if (d.environmentId !== m.environmentId || typeof d.serverVersion !== 'string') throw Error('Environment identity mismatch');
      return {...m, observedVersion:d.serverVersion, reachable:true, checkedAt:now, lastSeenAt:now};
    } catch(e) {
      return {...m, observedVersion:last?.observedVersion ?? null, reachable:false,
        checkedAt:now,lastSeenAt:last?.lastSeenAt ?? null,error:e.message};
    }
  }));
  return {schemaVersion:1, checkedAt:now, preparation, preparationError, machines};
}
export async function observe(config) {
  let previous;
  try {previous=JSON.parse(fs.readFileSync(config.output,'utf8'));} catch {previous={};}
  const result=await collect(config,previous);
  fs.mkdirSync(path.dirname(config.output),{recursive:true});
  atomicJson(config.output,result);
  return result;
}
if (process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  const config=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
  await observe(config);
  console.log('Maintenance observation refreshed. No installation performed.');
}
