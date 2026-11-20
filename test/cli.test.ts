import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { emptyPr } from '../src/state.ts';
import { cli } from './cli-harness.ts';

const withPr = (c: ReturnType<typeof cli>, pr = emptyPr('a'.repeat(40))) => writeFileSync(join(c.orgDir, 'state.json'), JSON.stringify({ prs: { 'o/r#1': pr } }));

test('candidates lists one line per candidate and names an empty lens; decisions refuses two files with one lens name', () => {
  const c = cli();
  const a = join(c.home, 'a.json');
  const b = join(c.home, 'b.json');
  const v = join(c.home, 'v.json');
  writeFileSync(a, JSON.stringify({ lens: 'breaker', candidates: [{ id: 'breaker-1', severity: 'major', path: 'x.ts', line: 3, claim: 'Throws on empty input. More.' }] }));
  writeFileSync(b, JSON.stringify({ lens: 'breaker', candidates: [] }));
  writeFileSync(v, JSON.stringify({ kept: [], dropped: [{ id: 'breaker-1' }] }));
  assert.deepEqual(c.run(['candidates', a, b]).out.trim().split('\n'), ['breaker breaker-1 major x.ts:3 Throws on empty input.', 'breaker: none']);
  const r = c.run(['decisions', v, a, b]);
  assert.equal(r.code, 1);
  assert.deepEqual(r.json().duplicateLens, ['breaker']);
});

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

test('decisions lists kept evidence that cites a file outside the repo, such as the context file', () => {
  const c = cli();
  const lens = join(c.home, 'lens.json');
  const verified = join(c.home, 'verified.json');
  writeFileSync(lens, JSON.stringify({ candidates: [{ id: 'a' }] }));
  writeFileSync(verified, JSON.stringify({ kept: [{ id: 'a', evidence: [{ path: '/x/.sous/orgs/o/drafts/r-1-abc.context.md' }], counterEvidence: [{ path: 'src/a.ts' }] }], dropped: [] }));
  const r = c.run(['decisions', verified, lens]);
  assert.equal(r.code, 1);
  assert.deepEqual(r.json().outsideRepo, ['a /x/.sous/orgs/o/drafts/r-1-abc.context.md']);
  assert.deepEqual(r.json().missing, ['a']);
});

test('memory commit commits the folder unsigned even when signing is on, and makes no empty commit', () => {
  const c = cli();
  const git = (...a: string[]) => spawnSync('git', a, { cwd: c.orgDir, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'commit.gpgsign', 'true');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  writeFileSync(join(c.orgDir, 'rules.md'), '- a rule\n');
  assert.equal(c.run(['memory', 'commit', 'o', 'learned x']).code, 0);
  assert.equal(git('log', '--format=%s').stdout.trim(), 'learned x');
  assert.equal(c.run(['memory', 'commit', 'o', 'nothing']).code, 0);
  assert.equal(git('rev-list', '--count', 'HEAD').stdout.trim(), '1');
});

test("plan moves an earlier review's drafts of the same PR aside, and leaves other PRs and folders alone", () => {
  const c = cli();
  const drafts = join(c.orgDir, 'drafts');
  mkdirSync(join(drafts, 'r-1-links'), { recursive: true });
  for (const f of ['r-1-abc.verified.json', 'r-1-abc.lens-correctness.json', 'r-10-abc.json']) writeFileSync(join(drafts, f), '{}');
  const r = c.run(['plan', 'o', 'o/r', '1'], { 'repos/o/r/pulls/1': { body: '', base: { ref: 'main' }, head: { repo: { default_branch: 'main' } } }, 'repos/o/r/pulls/1/files': [] });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json().staleDraftsMoved, 2);
  assert.deepEqual(readdirSync(drafts).filter((f) => !f.startsWith('stale-')).sort(), ['r-1-links', 'r-10-abc.json']);
});

test('prtext --json lists reviews with empty bodies and replies with their thread, hidden text removed', () => {
  const c = cli();
  const r = c.run(['prtext', 'o', 'o/r', '1', '--json'], {
    'repos/o/r/pulls/1': { title: 't', body: '', labels: [] },
    'repos/o/r/issues/1/comments': [],
    'repos/o/r/pulls/1/reviews': [{ id: 3, user: { login: 'me' }, state: 'DISMISSED', body: '' }],
    'repos/o/r/pulls/1/comments': [{ id: 5, in_reply_to_id: 4, user: { login: 'a' }, body: 'fi​xed', path: 'a.ts', line: 1 }],
  });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json().reviews[0].state, 'DISMISSED');
  assert.deepEqual([r.json().inline[0].inReplyTo, r.json().inline[0].body], [4, 'fixed']);
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

const HEAD = 'a'.repeat(40);
const withDraft = (c: ReturnType<typeof cli>) => {
  writeFileSync(join(c.home, 'config.json'), JSON.stringify({ orgs: ['o'] }));
  withPr(c);
  const file = join(c.home, 'draft.json');
  writeFileSync(file, JSON.stringify({ org: 'o', repo: 'o/r', number: 1, head: HEAD, event: 'COMMENT', summary: '', findings: [] }));
  return file;
};

test("post never adopts GitHub's wrapper review around a Sous thread reply as a lost post", () => {
  const c = cli();
  const r = c.run(['post', withDraft(c)], {
    'repos/o/r/pulls/1/reviews': [{ id: 5, user: { login: 'me' }, commit_id: HEAD, state: 'COMMENTED' }],
    'repos/o/r/pulls/1/reviews/5/comments': [{ id: 50, in_reply_to_id: 4, body: `ok <!-- sous:${HEAD.slice(0, 12)} -->` }],
    user: { login: 'me' },
  });
  assert.notEqual(r.code, 0);
  assert.equal(c.events().filter((e) => e.type === 'adopted').length, 0);
});

test('post refuses at once when your own pending review blocks posting', () => {
  const c = cli();
  const r = c.run(['post', withDraft(c)], { 'repos/o/r/pulls/1/reviews': [{ id: 7, user: { login: 'me' }, commit_id: 'b'.repeat(40), state: 'PENDING' }], user: { login: 'me' } });
  assert.notEqual(r.code, 0);
  assert.match(r.err, /pending review 7/);
});

test('headcheck exits 0 on the same head, and 4 with a moved event on a new one', () => {
  const c = cli();
  const same = c.run(['headcheck', 'o', 'o/r', '1', 'aaa', 'verifier'], { 'repos/o/r/pulls/1': { state: 'open', head: { sha: 'aaa' } } });
  assert.equal(same.code, 0, same.err);
  assert.equal(c.events().length, 0);
  const moved = c.run(['headcheck', 'o', 'o/r', '1', 'aaa', 'verifier'], { 'repos/o/r/pulls/1': { state: 'open', head: { sha: 'bbb' } } });
  assert.equal(moved.code, 4);
  assert.deepEqual([c.events().at(-1).type, c.events().at(-1).now, c.events().at(-1).stage], ['moved', 'bbb', 'verifier']);
});

test('reply refuses when Sous already has the last word in the thread', () => {
  const c = cli();
  writeFileSync(join(c.home, 'config.json'), JSON.stringify({ orgs: ['o'] }));
  withPr(c, { ...emptyPr(HEAD), commentIds: [1], replyIds: [2] });
  const text = join(c.home, 'r.txt');
  writeFileSync(text, 'fixed in abc, thanks');
  const r = c.run(['reply', 'o', 'o/r', '1', '1', text], {
    'repos/o/r/pulls/1': { head: { sha: HEAD } },
    'repos/o/r/pulls/1/comments': [{ id: 1, body: 'x', path: 'a', line: 1, user: null }, { id: 2, in_reply_to_id: 1, body: 'y', path: 'a', line: 1, user: null }],
  });
  assert.notEqual(r.code, 0);
  assert.match(r.err, /last word/);
  assert.ok(!r.calls.some((a) => a.includes('POST')));
});
