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
