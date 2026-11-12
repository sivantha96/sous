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
