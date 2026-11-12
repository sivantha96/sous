import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { emptyPr } from '../src/state.ts';
import { cli } from './cli-harness.ts';

const withPr = (c: ReturnType<typeof cli>, pr = emptyPr('a'.repeat(40))) => writeFileSync(join(c.orgDir, 'state.json'), JSON.stringify({ prs: { 'o/r#1': pr } }));

test('decisions names a lens file that is not valid JSON, and ids decided twice', () => {
  const c = cli();
  const good = join(c.home, 'good.json');
  const bad = join(c.home, 'bad.json');
  const verified = join(c.home, 'verified.json');
  writeFileSync(good, JSON.stringify({ candidates: [{ id: 'a' }, { id: 'b' }] }));
  writeFileSync(bad, '{"candidates": [{"id": "c", "evidence": "says "hi""}]}');
  writeFileSync(verified, JSON.stringify({ kept: [{ id: 'a', merged: ['b'], counterEvidence: [{}] }], dropped: [{ id: 'b' }] }));
  const r = c.run(['decisions', verified, good, bad]);
  assert.equal(r.code, 1);
  assert.deepEqual(r.json().invalidJson, [bad]);
  assert.deepEqual(r.json().decidedTwice, ['b']);
  assert.deepEqual(r.json().missing, ['b']);
});

test('seen takes reply ids comma- or space-separated, and refuses a non-number', () => {
  for (const ids of [['1', '2', '3'], ['1,2,3']]) {
    const c = cli();
    withPr(c);
    const r = c.run(['seen', 'o', 'o/r', '1', '--replies', ...ids], { 'repos/o/r/pulls/1/comments': [] });
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(c.events().at(-1).replies, [1, 2, 3]);
  }
  const c = cli();
  withPr(c);
  assert.notEqual(c.run(['seen', 'o', 'o/r', '1', '--replies', '1,x']).code, 0);
});

test("status shows the PR's current head and, apart, the head Sous last reviewed", () => {
  const c = cli();
  withPr(c, emptyPr('aaa'));
  const r = c.run(['status', 'o', 'o/r', '1'], {
    'repos/o/r/pulls/1': { head: { sha: 'bbb' } },
    'repos/o/r/pulls/1/reviews': [],
    'repos/o/r/pulls/1/comments': [],
    graphql: { data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } } },
  });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json().head, 'bbb');
  assert.equal(r.json().reviewedHead, 'aaa');
});

test('threads lists each thread with whether it is resolved or outdated', () => {
  const c = cli();
  const r = c.run(['threads', 'o', 'o/r', '1'], {
    graphql: { data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ id: 'T1', isResolved: true, isOutdated: false, comments: { nodes: [{ databaseId: 7 }] } }] } } } } },
  });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.json(), [{ id: 'T1', isResolved: true, isOutdated: false, firstCommentId: 7 }]);
});

test('facts --retire keeps a fact that is gone from main but holds at its pinned branch commit, and leaves the file alone', () => {
  const c = cli();
  mkdirSync(join(c.orgDir, 'system'));
  const file = join(c.orgDir, 'system', 'seed.md');
  const text = '- the seed lists every app (cite: o/r:apps.ts@abc1234def56)\n';
  writeFileSync(file, text);
  const before = statSync(file).mtimeMs;
  const r = c.run(['facts', 'o', '--retire'], { 'repos/o/r/commits': [], 'repos/o/r/contents/apps.ts?ref=abc1234def56': {} });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.json().notCurrent.map((x: { state: string }) => x.state), ['branch']);
  assert.equal(readFileSync(file, 'utf8'), text);
  assert.equal(statSync(file).mtimeMs, before, 'an unchanged file is not rewritten');
});
