import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Runs `gh` with the given args and optional stdin; returns stdout. Tests pass a fake. */
export type Gh = (args: string[], stdin?: string) => Promise<string>;

/** A gh runner bound to one account's token, so each org can use its own login. */
export async function ghFor(account: string): Promise<Gh> {
  const { stdout } = await run('gh', ['auth', 'token', '--user', account]);
  const env = { ...process.env, GH_TOKEN: stdout.trim() };
  return (args, stdin) =>
    new Promise((resolve, reject) => {
      const child = execFile('gh', args, { env, maxBuffer: 64 * 1024 * 1024 }, (err, out, errOut) =>
        err ? reject(new Error(`gh ${args.slice(0, 3).join(' ')}: ${errOut || err.message}`)) : resolve(out),
      );
      if (stdin !== undefined) child.stdin?.end(stdin);
    });
}

/** GET a REST path, following every page (GitHub caps pages at 100 items). */
export async function getAll<T>(gh: Gh, path: string): Promise<T[]> {
  const out = await gh(['api', '--paginate', '--slurp', path]);
  const pages = JSON.parse(out) as unknown[];
  return pages.flatMap((p) => (Array.isArray(p) ? (p as T[]) : ((p as { items?: T[] }).items ?? [p as T])));
}

export async function get<T>(gh: Gh, path: string): Promise<T> {
  return JSON.parse(await gh(['api', path])) as T;
}

export async function send<T>(gh: Gh, method: 'POST' | 'PUT', path: string, body: unknown): Promise<T> {
  return JSON.parse(await gh(['api', '-X', method, path, '--input', '-'], JSON.stringify(body))) as T;
}

export async function whoami(gh: Gh): Promise<string> {
  return (await get<{ login: string }>(gh, 'user')).login;
}
