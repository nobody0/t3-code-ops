import { execFile } from "node:child_process";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { digest } from "./ko-release.mjs";
import { promisify } from "node:util";
import { validateTarget } from "./fleet-inventory.mjs";
const exec = promisify(execFile);
export const shellQuote = (text, platform) =>
  platform === "win32"
    ? "'" + text.replaceAll("'", "''") + "'"
    : "'" + text.replaceAll("'", "'\\''") + "'";

// No shell, host discovery, arbitrary error output or configuration guessing on the client.
// The only remote shell input is a quoted executable and a base64-encoded fixed dispatcher.
export async function remoteJob(
  target,
  job,
  { timeout = 120_000, ssh = process.env.T3_FLEET_SSH ?? "ssh" } = {},
) {
  validateTarget(target);
  if (!/^[0-9a-f]{40}$/.test(job.toolingCommit ?? ""))
    throw Error("An exact tooling commit is required.");
  if (!/^[0-9a-f]{64}$/.test(job.plan?.id ?? "")) throw Error("A frozen plan is required.");
  const { plan, ...request } = job;
  const input = JSON.stringify({
    root: target.root,
    environmentId: target.environmentId,
    platform: target.platform,
    arch: target.arch,
    job: request,
  });
  const source = `(async()=>{const fs=require('node:fs'),path=require('node:path'),url=require('node:url'),crypto=require('node:crypto');const input=${input};if(process.platform!==input.platform||process.arch!==input.arch)throw Error('Target platform mismatch');const p=JSON.parse(fs.readFileSync(path.join(input.root,'incoming',${JSON.stringify(plan.id + ".json")}),'utf8'));const {id,...body}=p;if(id!==${JSON.stringify(plan.id)}||crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex')!==id||p.toolingCommit!==input.job.toolingCommit)throw Error('Plan mismatch');const chain=path.join(input.root,'toolchains',p.toolingCommit);for(const [name,sha]of Object.entries(p.toolingFiles)){if(name.split('/').includes('..')||path.isAbsolute(name)||crypto.createHash('sha256').update(fs.readFileSync(path.join(chain,name))).digest('hex')!==sha)throw Error('Toolchain mismatch');}input.job.plan=p;const worker=await import(url.pathToFileURL(path.join(chain,'scripts/lib/fleet-worker.mjs')));console.log(JSON.stringify(await worker.dispatch(input)));})().catch(()=>{console.error('Fleet worker failed; inspect the private target receipt.');process.exitCode=1})`;
  return executeSource(target, source, { timeout, ssh });
}

export async function upload(
  target,
  relative,
  source,
  sha,
  { ssh = process.env.T3_FLEET_SSH ?? "ssh" } = {},
) {
  validateTarget(target);
  if (!/^incoming\/[0-9a-f-]+\.(tar|json)$/.test(relative) || digest(source) !== sha)
    throw Error("Invalid upload or digest.");
  if (!target.ssh) {
    const file = path.join(target.root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    if (fs.existsSync(file)) {
      if (digest(file) !== sha) throw Error("Incoming bytes differ.");
      return;
    }
    fs.copyFileSync(source, file, fs.constants.COPYFILE_EXCL);
    return;
  }
  const program = `const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');const file=path.join(${JSON.stringify(target.root)},${JSON.stringify(relative)}),sha=${JSON.stringify(sha)};fs.mkdirSync(path.dirname(file),{recursive:true,mode:448});const temporary=file+'.'+crypto.randomUUID()+'.part',hash=crypto.createHash('sha256'),out=fs.createWriteStream(temporary,{flags:'wx',mode:384});process.stdin.on('data',b=>hash.update(b));process.stdin.pipe(out);out.on('finish',()=>{if(hash.digest('hex')!==sha){fs.unlinkSync(temporary);process.exitCode=1;return;}if(fs.existsSync(file)){if(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')!==sha){fs.unlinkSync(temporary);process.exitCode=1;return;}fs.unlinkSync(temporary);}else fs.renameSync(temporary,file);});`;
  const expression = "eval(Buffer.from(process.argv[1],'base64').toString('utf8'))";
  const command = `${target.platform === "win32" ? "& " : ""}${shellQuote(target.node, target.platform)} -e ${shellQuote(expression, target.platform)} ${shellQuote(Buffer.from(program).toString("base64"), target.platform)}`;
  const child = spawn(
    ssh,
    ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", target.ssh, command],
    { stdio: ["pipe", "ignore", "ignore"], windowsHide: true },
  );
  const exited = new Promise((resolve, reject) => {
    child.once("error", () => reject(Error("Upload transport unavailable.")));
    child.once("exit", (code) => (code === 0 ? resolve() : reject(Error("Upload failed."))));
  });
  const timer = setTimeout(() => child.kill(), 15 * 60_000);
  try {
    await Promise.all([pipeline(fs.createReadStream(source), child.stdin), exited]);
  } finally {
    clearTimeout(timer);
  }
}

export async function stageBundles(target, p, directory) {
  await executeSource(
    target,
    `try{const fs=require('node:fs'),path=require('node:path');const root=${JSON.stringify(target.root)},c=JSON.parse(fs.readFileSync(path.join(root,'config.json'),'utf8'));if(process.platform!==${JSON.stringify(target.platform)}||process.arch!==${JSON.stringify(target.arch)}||path.resolve(c.root)!==path.resolve(root)||fs.readFileSync(path.join(c.baseDir,'userdata/environment-id'),'utf8').trim()!==${JSON.stringify(target.environmentId)})throw Error();console.log(JSON.stringify({identity:'verified'}));}catch{process.exitCode=1;}`,
  );
  for (const [name, sha] of Object.entries(p.bundles))
    await upload(target, `incoming/${sha}.tar`, path.join(directory, `${name}.tar`), sha);
  const file = path.join(directory, "plan.json");
  await upload(target, `incoming/${p.id}.json`, file, digest(file));
  const source = `(async()=>{const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto'),url=require('node:url');const root=${JSON.stringify(target.root)},bytes=fs.readFileSync(path.join(root,'incoming',${JSON.stringify(p.id + ".json")}));if(crypto.createHash('sha256').update(bytes).digest('hex')!==${JSON.stringify(digest(file))})throw Error('Plan checksum mismatch');const p=JSON.parse(bytes);if(process.platform!==${JSON.stringify(target.platform)}||process.arch!==${JSON.stringify(target.arch)})throw Error('Platform mismatch');const toolchain=path.join(root,'toolchains',p.toolingCommit);const tar=path.join(root,'incoming',p.bundles.tooling+'.tar');if(crypto.createHash('sha256').update(fs.readFileSync(tar)).digest('hex')!==p.bundles.tooling)throw Error('Digest mismatch');if(!fs.existsSync(toolchain)){const part=toolchain+'.staging';fs.mkdirSync(part,{recursive:true,mode:448});const r=cp.spawnSync('tar',['-xf',tar,'-C',part],{windowsHide:true});if(r.status!==0)throw Error('Extraction failed');fs.renameSync(part,toolchain);}for(const [name,sha]of Object.entries(p.toolingFiles)){if(name.split('/').includes('..')||path.isAbsolute(name)||crypto.createHash('sha256').update(fs.readFileSync(path.join(toolchain,name))).digest('hex')!==sha)throw Error('Toolchain mismatch');}const worker=await import(url.pathToFileURL(path.join(toolchain,'scripts/lib/fleet-worker.mjs')));console.log(JSON.stringify(await worker.dispatch({root,environmentId:${JSON.stringify(target.environmentId)},platform:${JSON.stringify(target.platform)},arch:${JSON.stringify(target.arch)},job:{action:'stage',plan:p,toolingCommit:p.toolingCommit}})));})().catch(()=>{console.error('Staging failed; inspect target state.');process.exitCode=1})`;
  return executeSource(target, source, { timeout: 45 * 60_000 });
}
export async function executeSource(
  target,
  source,
  { timeout = 120_000, ssh = process.env.T3_FLEET_SSH ?? "ssh" } = {},
) {
  validateTarget(target);
  const program = Buffer.from(source, "utf8").toString("base64");
  const expression = "eval(Buffer.from(process.argv[1],'base64').toString('utf8'))";
  try {
    const result = target.ssh
      ? await exec(
          ssh,
          [
            "-T",
            "-n",
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=15",
            target.ssh,
            `${target.platform === "win32" ? "& " : ""}${shellQuote(target.node, target.platform)} -e ${shellQuote(expression, target.platform)} ${shellQuote(program, target.platform)}`,
          ],
          { timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
        )
      : await exec(target.node, ["-e", expression, program], {
          timeout,
          maxBuffer: 16 * 1024 * 1024,
          windowsHide: true,
        });
    return JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
  } catch (error) {
    // execFile errors include the full command (and can contain credentials/output). Never relay them.
    throw new Error(
      `Transport or worker failure for ${target.name} (${error.killed ? "deadline" : (error.code ?? "invalid-result")}).`,
    );
  }
}
