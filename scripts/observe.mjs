import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {atomicJson} from './lib/ko-release.mjs';

const LOG_LIMIT = 30;

export async function collect(config, previous = {}, fetcher = fetch) {
  const now = new Date().toISOString();
  async function json(url) {
    const r = await fetcher(url, {signal: AbortSignal.timeout(8000), headers: {'User-Agent':'t3-code-ops'}});
    if (!r.ok) throw Error(`HTTP ${r.status}`);
    return r.json();
  }
  const isText = x => typeof x === 'string' && x.length > 0;
  const preparationCheck = json(config.reportUrl).then(next => {
    if (next?.schemaVersion !== 1 || !['ready','failed','preparing','needs-review'].includes(next.status)
        || !Number.isFinite(Date.parse(next.checkedAt))
        || (next.status === 'ready' && ![next.releaseId, next.releaseUrl, next.sourceCommit].every(isText)))
      throw Error('Invalid preparation report');
    return next;
  });
  const history = Array.isArray(previous.machines) ? previous.machines : [];
  const machineChecks = Promise.all(config.machines.map(async m => {
    const last = history.find(x => x?.id === m.id);
    try {
      const d = await json(new URL('/.well-known/t3/environment', m.url));
      if (d.environmentId !== m.environmentId || typeof d.serverVersion !== 'string') throw Error('Environment identity mismatch');
      return {...m, observedVersion:d.serverVersion, reachable:true, checkedAt:now, lastSeenAt:now};
    } catch(e) {
      return {...m, observedVersion:last?.observedVersion ?? null, reachable:false,
        checkedAt:now,lastSeenAt:last?.lastSeenAt ?? null,error:e.message};
    }
  }));
  let preparation = previous.preparation ?? null, preparationError = null;
  try { preparation = await preparationCheck; } catch (e) { preparationError = e.message; }
  const machines = await machineChecks;
  const problems = [
    {source:'observer', label:'Observer', message:null},
    {source:'preparation', label:'Preparation report', message:preparationError},
    ...machines.map(m => ({source:'machine:'+m.id, label:m.label ?? m.id, message:m.error ?? null})),
  ];
  return {schemaVersion:1, checkedAt:now, preparation, preparationError, machines,
    log:recordProblems(previous.log, problems, now)};
}

// One entry per continuous problem: a repeat of the open message only counts, a new message or a recovery
// resolves it. Sources absent from `problems` are left untouched.
export function recordProblems(log, problems, now) {
  const entries = Array.isArray(log) ? log.filter(e => e && typeof e === 'object').map(e => ({...e})) : [];
  for (const {source, label, message} of problems) {
    const open = entries.find(e => e.source === source && !e.resolvedAt);
    if (open && open.message === message) { open.lastAt = now; open.count = (open.count ?? 1) + 1; continue; }
    if (open) open.resolvedAt = now;
    if (message) entries.unshift({source, label, message, firstAt:now, lastAt:now, count:1, resolvedAt:null});
  }
  const resolved = entries.filter(e => e.resolvedAt);
  const overflow = new Set(resolved.slice(Math.max(0, LOG_LIMIT - (entries.length - resolved.length))));
  return entries.filter(e => !overflow.has(e));
}

const MINUTE = 60000;
const NOTE_URL = 'http://localhost:4321/e/t3-maintenance';

// Conditions worth interrupting the operator for. Each key names one occurrence (a candidate, an outage start),
// so a condition is announced once when it appears and never repeated while it persists.
export function attention(status, now = Date.now()) {
  const items = [], log = Array.isArray(status.log) ? status.log : [];
  const machines = Array.isArray(status.machines) ? status.machines : [];
  const openSince = source => log.find(e => e.source === source && !e.resolvedAt)?.firstAt;
  const lasting = (since, minutes) => !!since && now - Date.parse(since) >= minutes * MINUTE;
  const failing = log.find(e => e.source === 'observer' && !e.resolvedAt);
  if (failing) items.push({key:'observer:'+failing.firstAt, message:'The maintenance observer is failing: '+failing.message});
  const p = status.preparation;
  if (lasting(openSince('preparation'), 60)) items.push({key:'preparation-unreachable:'+openSince('preparation'), message:'The T3 preparation report has been unavailable for over an hour: '+status.preparationError});
  else if (p && lasting(p.checkedAt, 8 * 60)) items.push({key:'preparation-stale:'+p.checkedAt, message:'T3 preparation has not reported for over eight hours. Check the prepare workflow.'});
  else if (p?.status === 'failed' || p?.status === 'needs-review')
    items.push({key:`preparation:${p.status}:${p.checkedAt}`, message:`T3 preparation ${p.status === 'failed' ? 'failed' : 'needs review'} for ${p.upstreamTag ?? 'the current upstream release'}.`});
  else if (p?.status === 'ready') {
    // Same rule as the note: a verified source commit means only operations tooling differs.
    const pending = machines.filter(m => m.verifiedRelease !== p.releaseId && m.verifiedCommit !== p.sourceCommit);
    if (pending.length) items.push({key:'candidate:'+p.releaseId, message:`T3 candidate ${p.releaseId} is ready for review. Pending: ${pending.map(m => m.label ?? m.id).join(', ')}.`});
  }
  for (const m of machines) {
    const minutes = m.offlineAlertMinutes === undefined ? 60 : m.offlineAlertMinutes;
    const since = openSince('machine:'+m.id);
    if (minutes !== null && !m.reachable && lasting(since, minutes))
      items.push({key:`offline:${m.id}:${since}`, message:`T3 on ${m.label ?? m.id} has been unreachable since ${new Date(since).toLocaleString()}${m.error ? ': '+m.error : ''}.`});
  }
  return items;
}

export function notify({title, message, url}) {
  if (process.platform === 'win32') {
    const x = v => String(v).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
    const toast = `<toast activationType="protocol" launch="${x(url)}"><visual><binding template="ToastGeneric"><text>${x(title)}</text><text>${x(message)}</text></binding></visual></toast>`;
    // Windows PowerShell's registered app ID lets an unpackaged script raise a toast; clicking it opens the note.
    const script = "$ErrorActionPreference='Stop';[void][Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime];[void][Windows.Data.Xml.Dom.XmlDocument,Windows.Data.Xml.Dom,ContentType=WindowsRuntime];$x=[Windows.Data.Xml.Dom.XmlDocument]::new();$x.LoadXml($env:T3_MAINTENANCE_TOAST);[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show([Windows.UI.Notifications.ToastNotification]::new($x))";
    execFileSync('powershell.exe', ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',script],
      {env:{...process.env, T3_MAINTENANCE_TOAST:toast}, windowsHide:true, timeout:20000, stdio:'pipe'});
  } else if (process.platform === 'darwin') {
    execFileSync('/usr/bin/osascript', ['-e','on run argv','-e','display notification (item 2 of argv) with title (item 1 of argv) subtitle (item 3 of argv)','-e','end run',
      title, message, 'Details: KO note T3 maintenance'], {timeout:20000, stdio:'pipe'});
  } else throw Error('Desktop notifications are not supported on '+process.platform);
}

// Announces conditions that were not announced before and records them in `announced`, so a condition that
// disappears and returns is not repeated. `alerts` lists the current conditions; a failed delivery is logged and
// retried on the next run.
export function announce(status, previous, {notifier = notify, url = NOTE_URL, now = Date.now()} = {}) {
  const at = new Date(now).toISOString();
  const known = new Map((Array.isArray(previous.announced) ? previous.announced : []).filter(a => a?.key && a.at).map(a => [a.key, a.at]));
  let failure = null;
  const alerts = attention(status, now).map(a => {
    if (known.has(a.key)) return {...a, notifiedAt:known.get(a.key)};
    try { notifier({title:'T3 maintenance', message:a.message, url}); known.set(a.key, at); return {...a, notifiedAt:at}; }
    catch (e) { failure = e.stderr?.toString().trim() || e.message; return {...a, notifiedAt:null}; }
  });
  return {...status, alerts, announced:[...known].map(([key, at]) => ({key, at})).slice(-100),
    log:recordProblems(status.log, [{source:'notifications', label:'Notifications', message:failure}], at)};
}

function readPrevious(output) {
  try {return JSON.parse(fs.readFileSync(output,'utf8'));} catch {return {};}
}
function write(output, status) {
  fs.mkdirSync(path.dirname(output),{recursive:true});
  atomicJson(output,status);
  return status;
}
export async function observe(config, options = {}) {
  const previous=readPrevious(config.output);
  const result=await collect(config,previous,options.fetcher);
  return write(config.output,announce(result,previous,{url:config.noteUrl,...options}));
}
// Keeps the last observation and records why this run failed, so the KO note shows the failure on every platform.
export function recordFailure(output, error, options = {}) {
  const previous=readPrevious(output);
  const message=error?.message || String(error);
  const now=new Date(options.now ?? Date.now()).toISOString();
  const status={schemaVersion:1, ...previous, log:recordProblems(previous.log,[{source:'observer',label:'Observer',message}],now)};
  return write(output,announce(status,previous,{...options,now:Date.parse(now)}));
}
if (process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv[2] === '--test-notification') {
    notify({title:'T3 maintenance', message:'Test notification from the maintenance observer.', url:process.argv[3] ?? NOTE_URL});
    console.log('Test notification sent.');
  } else {
    let config;
    try {
      config=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
      await observe(config);
      console.log('Maintenance observation refreshed. No installation performed.');
    } catch (e) {
      console.error(e);
      // Without a readable config, fall back to the documented cache layout: status.json beside the config.
      const output=typeof config?.output==='string' ? config.output : path.join(path.dirname(path.resolve(process.argv[2] ?? '.')),'status.json');
      try {recordFailure(output,e,{url:config?.noteUrl});} catch (f) {console.error(f);}
      process.exitCode=1;
    }
  }
}
