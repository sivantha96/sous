import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyPr } from '../src/state.ts';
import { threadSignals, type PrComment } from '../src/threads.ts';

const c = (id: number, user: string, extra: Partial<PrComment> = {}): PrComment => ({ id, user: { login: user }, body: `b${id}`, path: 'a.ts', line: 3, ...extra });

test('teammate replies on Sous threads are signals; your own replies and other threads are not', () => {
  const pr = { ...emptyPr('h'), commentIds: [1] };
  const comments = [c(1, 'me'), c(2, 'dev', { in_reply_to_id: 1 }), c(3, 'me', { in_reply_to_id: 1 }), c(4, 'dev'), c(5, 'dev', { in_reply_to_id: 4 })];
  const s = threadSignals(comments, pr, 'me');
  assert.equal(s.length, 1);
  assert.deepEqual(s[0]!.replies.map((r) => r.id), [2]);
});

test('handled replies and unchanged reactions are not signals again', () => {
  const pr = { ...emptyPr('h'), commentIds: [1], handled: [2], reactions: { '1': 1 } };
  const comments = [c(1, 'me', { reactions: { total_count: 1, '-1': 1 } }), c(2, 'dev', { in_reply_to_id: 1 })];
  assert.deepEqual(threadSignals(comments, pr, 'me'), []);
  const more = [c(1, 'me', { reactions: { total_count: 2, '-1': 2 } }), c(2, 'dev', { in_reply_to_id: 1 })];
  assert.deepEqual(threadSignals(more, pr, 'me')[0]!.reactions, { total: 2, seenBefore: 1, up: 0, down: 2, confused: 0 });
});
