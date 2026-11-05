import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildReview as build, dismissOwn, hasMarker, LintError, rightLines, signed, type Draft } from '../src/post.ts';
import type { Gh } from '../src/gh.ts';

const head = 'a'.repeat(40);
const draft = (findings: Draft['findings']): Draft => ({ org: 'o', repo: 'o/r', number: 1, head, findings });
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

test('no review body; every comment carries the Sous marker', () => {
  const p = buildReview(draft([major]), { pending: false });
  assert.equal(p.body, '');
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

test('every comment ends with the italic attribution', () => {
  const p = buildReview(draft([major, nit]), { pending: false });
  assert.ok(p.comments.every((c) => c.body.includes("_From Sam's AI reviewer_")));
});

test('a review with no findings is refused', () => {
  assert.throws(() => buildReview(draft([]), { pending: false }), /sous mark/);
});

test('a comment on a line outside the diff is refused', () => {
  assert.throws(() => buildReview(draft([{ ...major, line: 40 }]), { pending: false }), /not a line in the diff/);
  assert.deepEqual([...rightLines('@@ -10,3 +10,3 @@\n keep\n-old\n+new\n keep')], [10, 11, 12]);
});

test('dismissOwn refuses a review Sous did not write', async () => {
  const fake = (review: object, comments: object[]): Gh => async (args) => JSON.stringify(args[1]!.includes('/comments') ? comments : review);
  const sous = [{ body: 'x\n\n<!-- sous:aaaaaaaaaaaa -->' }];
  // A person's review: no marker anywhere.
  await assert.rejects(dismissOwn(fake({ user: { login: 'me' }, state: 'CHANGES_REQUESTED', body: '' }, [{ body: 'mine' }]), 'o/r', 1, 7, 'me', [7], 'fixed'), /not a Sous review/);
  // Not recorded in state.
  await assert.rejects(dismissOwn(fake({ user: { login: 'me' }, state: 'CHANGES_REQUESTED', body: '' }, sous), 'o/r', 1, 7, 'me', [], 'fixed'), /not a Sous review/);
  // Someone else's account.
  await assert.rejects(dismissOwn(fake({ user: { login: 'them' }, state: 'CHANGES_REQUESTED', body: '' }, sous), 'o/r', 1, 7, 'me', [7], 'fixed'), /not a Sous review/);
});

test('replies are signed the same way as review comments', () => {
  const body = signed('fixed in abc123, resolving', "Posted by Sam's AI review bot \u2014 not a human review.", head);
  assert.match(body, /\n\n_Posted by Sam's AI review bot \u2014 not a human review\._\n\n<!-- sous:/);
  assert.ok(hasMarker(body));
});

test('an owner decision is never posted', () => {
  assert.throws(() => buildReview(draft([{ ...major, owner: true }]), { pending: false }), /owner decision/);
});

test('a range posts with start_line inside one hunk, and a broken range is refused', () => {
  const p = buildReview(draft([{ ...major, startLine: 2, line: 4 }]), { pending: false });
  assert.deepEqual([p.comments[0]!.start_line, p.comments[0]!.start_side, p.comments[0]!.line], [2, 'RIGHT', 4]);
  assert.throws(() => buildReview(draft([{ ...major, startLine: 4, line: 2 }]), { pending: false }), LintError);
  assert.throws(() => buildReview(draft([{ ...major, startLine: 1, line: 12 }]), { pending: false }), LintError);
});
