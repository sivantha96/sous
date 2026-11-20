import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchArgs, prefetchBase } from '../src/checkout.ts';

test('checkout fetches every branch, pruned, so stacked parents and siblings are current', () => {
  assert.deepEqual(fetchArgs(7), ['fetch', '-q', '--prune', 'origin', 'pull/7/head', '+refs/heads/*:refs/remotes/origin/*']);
});

test('checkout downloads the base copies agents read, with the token', async () => {
  const calls: { args: string[]; token?: string }[] = [];
  const run = async (_: string, args: string[], opts: { env?: NodeJS.ProcessEnv }) => {
    calls.push({ args, token: opts.env?.GH_TOKEN });
    return { stdout: args[0] === 'ls-tree' ? 'AGENTS.md\n.claude/agents/x.md\n' : '' };
  };
  await prefetchBase(run, '/clone', 'main', ['AGENTS.md', '.claude'], { GH_TOKEN: 't' });
  assert.deepEqual(calls[0]!.args, ['ls-tree', '-r', '--name-only', 'origin/main', '--', 'AGENTS.md', '.claude']);
  assert.deepEqual(calls.slice(1).map((c) => [c.args.join(' '), c.token]), [
    ['cat-file -p origin/main:AGENTS.md', 't'],
    ['cat-file -p origin/main:.claude/agents/x.md', 't'],
  ]);
});

test("an incremental review reads only files whose own patch changed; a base merge that moves lines changes none", async () => {
  const { changedPatches } = await import('../src/checkout.ts');
  const d = (file: string, at: number, line: string) => `diff --git a/${file} b/${file}\nindex 111..222 100644\n--- a/${file}\n+++ b/${file}\n@@ -${at},1 +${at},1 @@\n-old\n+${line}\n`;
  const before = d('a.ts', 1, 'new') + d('b.ts', 5, 'x');
  const after = d('a.ts', 40, 'new') + d('b.ts', 5, 'y') + d('c.ts', 1, 'z');
  assert.deepEqual(changedPatches(before, after), { changed: ['b.ts', 'c.ts'], unchanged: ['a.ts'] });
});

test('nested convention files load only for the subtree a change touches', async () => {
  const { conventionsFor } = await import('../src/checkout.ts');
  assert.deepEqual(conventionsFor(['AGENTS.md', 'apps/web/AGENTS.md', 'infra/AGENTS.md', 'apps/web/lib/x/AGENTS.md', 'apps/web/lib/x/a.ts'], ['apps/web/lib/x/a.ts']), ['AGENTS.md', 'apps/web/AGENTS.md', 'apps/web/lib/x/AGENTS.md']);
  assert.deepEqual(conventionsFor(['AGENTS.md', 'apps/AGENTS.md'], ['appsx/b.ts']), ['AGENTS.md']);
});

test('generated globs come from linguist-generated and negated CodeRabbit path filters', async () => {
  const { generatedGlobs } = await import('../src/checkout.ts');
  const { matchesGlob } = await import('node:path');
  const globs = generatedGlobs('pnpm-lock.yaml linguist-generated=true\n*.ts text\n', 'reviews:\n  path_filters:\n    - "!infra/vendors/sdks/**"\n    - "src/**"\n');
  assert.deepEqual(globs, ['**/pnpm-lock.yaml', 'infra/vendors/sdks/**']);
  assert.ok(matchesGlob('infra/vendors/sdks/sentry/bin/a.js', globs[1]!));
});
