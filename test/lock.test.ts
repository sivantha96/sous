import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.SOUS_HOME = mkdtempSync(join(tmpdir(), 'sous-lock-'));
const { LOCK_MINUTES, releaseLock, takeLock } = await import('../src/state.ts');

test('one run per org: a second session waits until the first releases or its lock expires', () => {
  const t0 = new Date('2026-11-05T10:00:00Z');
  assert.ok(takeLock('o', 'a', t0).ok);
  assert.ok(takeLock('o', 'a', t0).ok, 'the holder may take it again');
  assert.equal(takeLock('o', 'b', new Date(t0.getTime() + 60_000)).ok, false);
  assert.ok(takeLock('other', 'b', t0).ok, 'orgs lock apart');
  assert.equal(releaseLock('o', 'b'), false, 'only the holder releases');
  assert.ok(releaseLock('o', 'a'));
  assert.ok(takeLock('o', 'b', t0).ok);
  assert.ok(takeLock('o', 'c', new Date(t0.getTime() + LOCK_MINUTES * 60_000)).ok, 'a dead run frees the org');
});
