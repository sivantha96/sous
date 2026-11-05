import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyPr } from '../src/state.ts';
import { assertOwnThread } from '../src/threads.ts';

test('reply and resolve act only on threads Sous started', () => {
  const pr = { ...emptyPr('h'), commentIds: [10] };
  assert.doesNotThrow(() => assertOwnThread(pr, 10));
  assert.throws(() => assertOwnThread(pr, 11), /not touching it/);
  assert.throws(() => assertOwnThread(undefined, 10), /not touching it/);
});
