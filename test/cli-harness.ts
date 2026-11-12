import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A `gh` on PATH that answers `api` calls from a routes file (by path, then path without query) and logs each call. */
const FAKE_GH = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'auth') { process.stdout.write('token\\n'); process.exit(0); }
const routes = JSON.parse(fs.readFileSync(process.env.FAKE_GH_ROUTES, 'utf8'));
const path = args.includes('graphql') ? 'graphql' : args.find((a) => /^(repos|search|user)/.test(a)) ?? '';
const key = (args.includes('-X') ? args[args.indexOf('-X') + 1] + ' ' : '') + path;
const hit = key in routes ? routes[key] : routes[key.split('?')[0]];
if (hit === undefined) { process.stderr.write('HTTP 404: ' + key); process.exit(1); }
process.stdout.write(JSON.stringify(args.includes('--slurp') ? [hit] : hit));
`;

/** Runs the real CLI in a temp SOUS_HOME with one org and a fake gh. */
export function cli(org = 'o') {
  const home = mkdtempSync(join(tmpdir(), 'sous-cli-'));
  const orgDir = join(home, 'orgs', org);
  const bin = join(home, 'bin');
  mkdirSync(orgDir, { recursive: true });
  mkdirSync(bin);
  writeFileSync(join(orgDir, 'profile.json'), JSON.stringify({ org, ghAccount: 'me', postingMode: 'post' }));
  writeFileSync(join(bin, 'gh'), FAKE_GH);
  chmodSync(join(bin, 'gh'), 0o755);
  const log = join(home, 'gh.log');
  return {
    home,
    orgDir,
    run(args: string[], routes: Record<string, unknown> = {}) {
      writeFileSync(join(home, 'routes.json'), JSON.stringify(routes));
      writeFileSync(log, '');
      const r = spawnSync(process.execPath, [new URL('../bin/sous', import.meta.url).pathname, ...args], {
        encoding: 'utf8',
        env: { ...process.env, SOUS_HOME: home, PATH: `${bin}:${process.env.PATH}`, FAKE_GH_ROUTES: join(home, 'routes.json'), FAKE_GH_LOG: log },
      });
      const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as string[]);
      return { code: r.status, out: r.stdout, err: r.stderr, json: () => JSON.parse(r.stdout), calls };
    },
    events: () => (existsSync(join(orgDir, 'events.jsonl')) ? readFileSync(join(orgDir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []),
  };
}
