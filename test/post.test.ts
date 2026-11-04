import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildReview as build, dismissOwn, hasMarker, LintError, rightLines, type Draft } from '../src/post.ts';
import type { Gh } from '../src/gh.ts';

const head = 'a'.repeat(40);
const draft = (findings: Draft['findings'], summary = 'two points inline.'): Draft => ({ org: 'o', repo: 'o/r', number: 1, head, summary, findings });
const files = [{ filename: 'src/a.ts', patch: '@@ -1,2 +1,10 @@\n a\n+b\n+c\n+d\n+e\n+f\n+g\n+h\n+i\n+j' }];
const buildReview = (d: Draft, o: { pending: boolean }) => build(d, { ...o, attribution: "From Sam's AI reviewer", files });
const major = { severity: 'major' as const, path: 'src/a.ts', line: 3, body: 'this throws on an empty list', fix: 'return early when the list is empty' };
const nit = { severity: 'nit' as const, path: 'src/a.ts', line: 9, body: 'rename to `count`' };

test('any major requests changes; minors and nits only comment', () => {
  assert.equal(buildReview(draft([major, nit]), { pending: false }).event, 'REQUEST_CHANGES');
  assert.equal(buildReview(draft([nit]), { pending: false }).event, 'COMMENT');
});

test('paused or draft mode leaves the review pending', () => {
  assert.equal(buildReview(draft([major]), { pending: true }).event, undefined);
});

test('every comment and the body carry the Sous marker', () => {
  const p = buildReview(draft([major]), { pending: false });
  assert.ok(hasMarker(p.body));
  assert.ok(p.comments.every((c) => hasMarker(c.body)));
  assert.match(p.comments[0]!.body, /Fix: return early/);
});

test('voice lint refuses to post', () => {
  assert.throws(() => buildReview(draft([{ ...major, body: 'please fix this — it breaks' }]), { pending: false }), LintError);
});

test('fix is optional; Fix: appears only when given', () => {
  const p = buildReview(draft([{ ...major, fix: undefined }]), { pending: false });
  assert.doesNotMatch(p.comments[0]!.body, /Fix:/);
});

test('every comment and the body end with the italic attribution', () => {
  const p = buildReview(draft([major, nit], ''), { pending: false });
  assert.ok([p.body, ...p.comments.map((c) => c.body)].every((b) => b.includes("_From Sam's AI reviewer_")));
});

test('a long or multi-line summary is refused', () => {
  assert.throws(() => buildReview(draft([major], '## AI review\n\n### Major\n- a'), { pending: false }), /summary/);
  assert.throws(() => buildReview(draft([major], 'x'.repeat(300)), { pending: false }), /characters/);
});

test('a comment on a line outside the diff is refused', () => {
  assert.throws(() => buildReview(draft([{ ...major, line: 40 }]), { pending: false }), /not a line in the diff/);
  assert.deepEqual([...rightLines('@@ -10,3 +10,3 @@\n keep\n-old\n+new\n keep')], [10, 11, 12]);
});

test('dismissOwn refuses a review Sous did not write', async () => {
  const gh: Gh = async () => JSON.stringify({ id: 7, user: { login: 'me' }, state: 'CHANGES_REQUESTED', body: 'written by a person' });
  await assert.rejects(dismissOwn(gh, 'o/r', 1, 7, 'me', [7], 'fixed in abc123'), /not a Sous review/);
  const own: Gh = async () => JSON.stringify({ id: 7, user: { login: 'me' }, state: 'CHANGES_REQUESTED', body: '<!-- sous:aaaaaaaaaaaa -->' });
  await assert.rejects(dismissOwn(own, 'o/r', 1, 7, 'me', [], 'fixed'), /not a Sous review/);
});
