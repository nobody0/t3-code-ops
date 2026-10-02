import {execFileSync} from 'node:child_process';
export async function github(path, options = {}) {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const r = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {'User-Agent': 't3-code-ops', Accept: 'application/vnd.github+json',
      ...(token ? {Authorization: `Bearer ${token}`} : {}), ...options.headers},
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) throw Error(`GitHub ${r.status} for ${path}`);
  return r.status === 204 ? null : r.json();
}
export function git(args, cwd) {
  return execFileSync('git', args, {cwd, encoding: 'utf8', windowsHide: true}).trim();
}
