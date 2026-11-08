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

test('Sous has the last word when its comment or its own reply ends the thread', async () => {
  const { sousHasLastWord } = await import('../src/threads.ts');
  const pr = { ...emptyPr('h'), commentIds: [1], replyIds: [4] };
  assert.equal(sousHasLastWord([c(1, 'me')], pr, 1), true);
  assert.equal(sousHasLastWord([c(1, 'me'), c(2, 'dev', { in_reply_to_id: 1 })], pr, 1), false);
  assert.equal(sousHasLastWord([c(1, 'me'), c(2, 'dev', { in_reply_to_id: 1 }), c(4, 'me', { in_reply_to_id: 1 })], pr, 1), true);
  assert.equal(sousHasLastWord([c(1, 'me'), c(4, 'me', { in_reply_to_id: 1 }), c(5, 'dev', { in_reply_to_id: 1 }), c(9, 'dev')], pr, 1), false);
});

test('review threads are read across every page', async () => {
  const { reviewThreads } = await import('../src/threads.ts');
  const page = (ids: number[], next: string | null) => JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: next !== null, endCursor: next }, nodes: ids.map((id) => ({ id: `T${id}`, isResolved: id === 2, comments: { nodes: [{ databaseId: id }] } })) } } } } });
  const calls: string[][] = [];
  const gh = async (args: string[]) => (calls.push(args), args.includes('after=c1') ? page([2], null) : page([1], 'c1'));
  assert.deepEqual(await reviewThreads(gh, 'o/r', 3), [{ id: 'T1', isResolved: false, firstCommentId: 1 }, { id: 'T2', isResolved: true, firstCommentId: 2 }]);
  assert.equal(calls.length, 2);
});

test('a reply Sous already answered is not new again, even when state lost it from handled', () => {
  const pr = { ...emptyPr('h'), commentIds: [1] };
  const sous = c(3, 'me', { in_reply_to_id: 1, body: 'confirmed\n\n<!-- sous:abc123 -->' });
  assert.deepEqual(threadSignals([c(1, 'me'), c(2, 'dev', { in_reply_to_id: 1 }), sous], pr, 'me'), []);
  assert.deepEqual(threadSignals([c(1, 'me'), c(2, 'dev', { in_reply_to_id: 1 }), c(3, 'me', { in_reply_to_id: 1 })], { ...pr, replyIds: [3] }, 'me'), []);
  const later = threadSignals([c(1, 'me'), c(2, 'dev', { in_reply_to_id: 1 }), sous, c(4, 'dev', { in_reply_to_id: 1 })], pr, 'me');
  assert.deepEqual(later[0]!.replies.map((r) => r.id), [4], 'a newer reply still counts');
});

test('Sous has the last word when its marked reply is last, even if state lost the reply id', async () => {
  const { sousHasLastWord } = await import('../src/threads.ts');
  const pr = { ...emptyPr('h'), commentIds: [1] };
  assert.equal(sousHasLastWord([c(1, 'me'), c(2, 'dev', { in_reply_to_id: 1 }), c(3, 'me', { in_reply_to_id: 1, body: 'ok\n\n<!-- sous:abc123 -->' })], pr, 1), true);
});

test('on your own PR your replies are the author answers; elsewhere they are yours, not signals', () => {
  const pr = { ...emptyPr('h'), commentIds: [1], replyIds: [4] };
  const comments = [c(1, 'me'), c(2, 'me', { in_reply_to_id: 1 }), c(3, 'dev', { in_reply_to_id: 1 })];
  assert.deepEqual(threadSignals(comments, pr, 'me')[0]!.replies.map((r) => r.id), [3]);
  assert.deepEqual(threadSignals(comments, pr, 'me', true)[0]!.replies.map((r) => r.id), [2, 3]);
  const sousReply = [c(1, 'me'), c(2, 'me', { in_reply_to_id: 1 }), c(4, 'me', { in_reply_to_id: 1 })];
  assert.deepEqual(threadSignals(sousReply, pr, 'me', true), [], 'a Sous reply after it answers it, and is never a signal itself');
});
