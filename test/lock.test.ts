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

test('a PR asks for your review by name or through a team you are in, in its own org only', async () => {
  const { askedYou, askByHand, askedByHand } = await import('../src/state.ts');
  const teams = [{ slug: 'engineering', organization: { login: 'acme' } }, { slug: 'dev', organization: { login: 'other' } }];
  assert.ok(askedYou({ users: [{ login: 'Me' }], teams: [] }, 'me', 'acme', []));
  assert.ok(askedYou({ users: [], teams: [{ slug: 'Engineering' }] }, 'me', 'acme', teams));
  assert.equal(askedYou({ users: [], teams: [{ slug: 'dev' }] }, 'me', 'acme', teams), false, "another org's team of the same name");
  assert.equal(askedYou({ users: [{ login: 'you' }], teams: [{ slug: 'design' }] }, 'me', 'acme', teams), false);
  assert.equal(askedByHand('acme', 'acme/r#1'), false);
  askByHand('acme', 'acme/r#1');
  askByHand('acme', 'acme/r#1');
  assert.ok(askedByHand('acme', 'acme/r#1'));
});

test('one review per PR: a second session is refused until the first releases or its lock expires', async () => {
  const { takePrLock, releasePrLock } = await import('../src/state.ts');
  const t0 = new Date('2026-11-05T10:00:00Z');
  assert.ok(takePrLock('o', 'o/r#1', 'a', t0).ok);
  assert.ok(takePrLock('o', 'o/r#1', 'a', t0).ok, 'the holder may take it again');
  const refused = takePrLock('o', 'o/r#1', 'b', t0);
  assert.equal(refused.ok, false);
  assert.ok(takePrLock('o', 'o/r#2', 'b', t0).ok, 'other PRs lock apart');
  assert.equal(releasePrLock('o', 'o/r#1', 'b'), false, 'only the holder releases');
  assert.ok(releasePrLock('o', 'o/r#1', 'a'));
  assert.ok(takePrLock('o', 'o/r#1', 'b', t0).ok);
  assert.ok(takePrLock('o', 'o/r#1', 'c', new Date(t0.getTime() + LOCK_MINUTES * 60_000)).ok, 'a dead session frees the PR');
});
