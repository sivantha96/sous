import assert from 'node:assert/strict';
import { test } from 'node:test';
import { byPriority, classify, isNoiseOnly, type DueItem } from '../src/due.ts';
import { emptyPr } from '../src/state.ts';

test('noise-only PRs are skipped, mixed PRs are not', () => {
  assert.equal(isNoiseOnly(['pnpm-lock.yaml', 'apps/web/__generated__/api.ts']), true);
  assert.equal(isNoiseOnly(['pnpm-lock.yaml', 'package.json']), false);
  assert.equal(isNoiseOnly([]), false);
});

test('classify: new, pushed, or already reviewed at this head', () => {
  const state = { prs: { 'o/r#1': emptyPr('aaa') } };
  assert.equal(classify(state, 'o/r', 2, 'x'), 'NEW');
  assert.equal(classify(state, 'o/r', 1, 'bbb'), 'PUSHED');
  assert.equal(classify(state, 'o/r', 1, 'aaa'), null);
});

test('replies first, then pushes, then new PRs', () => {
  const item = (reason: DueItem['reason'], number: number) => ({ reason, number }) as DueItem;
  assert.deepEqual([item('NEW', 1), item('PUSHED', 2), item('REPLY', 3)].sort(byPriority).map((i) => i.number), [3, 2, 1]);
});

test('a head you reviewed yourself is not due; Sous reviews do not count as yours', async () => {
  const { yourLatestHead } = await import('../src/due.ts');
  const r = (login: string, commit_id: string, at: string, body = 'looks fine') => ({ user: { login }, commit_id, body, submitted_at: at });
  assert.equal(yourLatestHead([r('me', 'a', '2026-11-01'), r('me', 'b', '2026-11-02'), r('them', 'c', '2026-11-03')], 'me'), 'b');
  assert.equal(yourLatestHead([r('me', 'a', '2026-11-01'), r('me', 'b', '2026-11-02', 'x <!-- sous:bbbbbbbbbbbb -->')], 'me'), 'a');
  assert.equal(yourLatestHead([], 'me'), null);
});

test('patch id ignores line numbers, so a rebase that moves nothing keeps it', async () => {
  const { patchId, pushScope } = await import('../src/due.ts');
  const a = patchId([{ filename: 'a.ts', patch: '@@ -1,2 +1,2 @@\n x\n-old\n+new' }]);
  const moved = patchId([{ filename: 'a.ts', patch: '@@ -40,2 +40,2 @@\n x\n-old\n+new' }]);
  const changed = patchId([{ filename: 'a.ts', patch: '@@ -1,2 +1,2 @@\n x\n-old\n+newer' }]);
  assert.equal(a, moved);
  assert.notEqual(a, changed);
  assert.equal(pushScope({ head: 'h1', patchId: a }, { compareStatus: 'diverged', mergeBase: 'm2', patchId: moved }), 'skip');
  assert.equal(pushScope({ head: 'h1', mergeBase: 'm1', patchId: a }, { compareStatus: 'ahead', mergeBase: 'm1', patchId: changed }), 'incremental');
  assert.equal(pushScope({ head: 'h1', mergeBase: 'm1', patchId: a }, { compareStatus: 'ahead', mergeBase: 'm2', patchId: changed }), 'full');
  assert.equal(pushScope({ head: 'h1', mergeBase: 'm1', patchId: a }, { compareStatus: 'diverged', mergeBase: 'm1', patchId: changed }), 'full');
});

test('a re-request counts only when someone else asked after the last review', async () => {
  const { rerequestedAfter } = await import('../src/due.ts');
  const since = '2026-11-01T10:00:00Z';
  const ev = (actor: string, at: string) => ({ event: 'review_requested', created_at: at, actor: { login: actor }, requested_reviewer: { login: 'me' } });
  assert.equal(rerequestedAfter([ev('author', '2026-11-02T00:00:00Z')], 'me', since), true);
  assert.equal(rerequestedAfter([ev('me', '2026-11-02T00:00:00Z')], 'me', since), false, 'Sous gives the request back as you');
  assert.equal(rerequestedAfter([ev('author', '2026-10-30T00:00:00Z')], 'me', since), false);
  assert.equal(rerequestedAfter([{ ...ev('author', '2026-11-02T00:00:00Z'), requested_reviewer: { login: 'other' } }], 'me', since), false);
});

test('one PR that fails is skipped with its error; the others still run', async () => {
  const { findDue } = await import('../src/due.ts');
  const gh = async (args: string[]): Promise<string> => {
    const path = args.find((a) => a.startsWith('search/') || a.startsWith('repos/')) ?? '';
    if (path.startsWith('search/')) return JSON.stringify([[{ number: 1, repository_url: 'https://api.github.com/repos/o/r' }, { number: 2, repository_url: 'https://api.github.com/repos/o/r' }]]);
    if (path === 'repos/o/r/pulls/1') throw new Error('HTTP 502');
    if (path === 'repos/o/r/pulls/2') return JSON.stringify({ number: 2, title: 't', draft: true, user: { login: 'a', type: 'User' }, head: { sha: 'h' }, base: { ref: 'main' } });
    throw new Error(`unexpected ${path}`);
  };
  const profile = { org: 'o', ghAccount: 'me', postingMode: 'post' as const, coderabbit: null, knowledgeGraph: null, ruleSources: [], postSuggestions: false, linkHosts: [], skills: [] };
  const r = await findDue(gh, profile, { prs: {} }, 'me', new Date());
  assert.deepEqual(r.skipped, [{ pr: 'o/r#1', why: 'error: HTTP 502' }]);
  assert.deepEqual(r.due, []);
});
