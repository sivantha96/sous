import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkScores, cycleTimes, qualityAverages, retro, runSummary } from '../src/retro.ts';
import type { LoggedEvent } from '../src/state.ts';

const u = (input: number, cacheRead = 0) => ({ m: { input, output: 0, cacheRead, cacheWrite: 0, calls: 1 } });
const usage = (at: string, paid: number, seconds: number, label = 'run'): LoggedEvent => ({ at, type: 'usage', label, totals: u(paid, 5), byAgent: { lens: u(paid) }, seconds: { main: seconds, lens: seconds / 2 } });

test('the retro covers only this run, lists its problems and compares its cost with earlier runs', () => {
  const events: LoggedEvent[] = [
    usage('2026-11-01T00:00:00Z', 100, 60),
    usage('2026-11-02T00:00:00Z', 300, 180),
    usage('2026-11-02T01:00:00Z', 9999, 9999, 'stats'),
    { at: '2026-11-02T02:00:00Z', type: 'lint-refused', pr: 'o/r#1' },
    { at: '2026-11-05T00:00:01Z', type: 'reviewed', pr: 'o/r#2', event: 'COMMENT', findings: [{}, {}] },
    { at: '2026-11-05T00:00:02Z', type: 'outbound-refused', pr: 'o/r#2' },
    { at: '2026-11-05T00:00:03Z', type: 'seen', pr: 'o/r#2' },
    { at: '2026-11-05T00:00:04Z', type: 'adopted', pr: 'o/r#3', comments: 4 },
    usage('2026-11-05T00:01:00Z', 500, 240),
  ];
  const r = retro(events, '2026-11-05T00:00:00Z');
  assert.deepEqual(r.reviews, [{ pr: 'o/r#2', event: 'COMMENT', findings: 2 }, { pr: 'o/r#3', event: 'ADOPTED', findings: 4 }]);
  assert.deepEqual(r.problems.map((e) => e.type), ['outbound-refused']);
  assert.deepEqual(r.cost, { paidTokens: 500, cacheReadTokens: 5, seconds: 240, byAgent: { lens: { paidTokens: 500, seconds: 120 }, main: { paidTokens: 0, seconds: 240 } } });
  assert.deepEqual(r.recent, { runs: 2, medianPaidTokens: 200, medianSeconds: 120 });
});

test('a run that logged no usage says so instead of reporting zero', () => {
  assert.equal(retro([], '2026-11-05T00:00:00Z').cost, null);
  assert.deepEqual(retro([], '2026-11-05T00:00:00Z').recent, { runs: 0, medianPaidTokens: null, medianSeconds: null });
});

test('the run summary has one linked row per PR with its comments, replies and resolved threads', () => {
  const events: LoggedEvent[] = [
    { at: '2026-11-04T00:00:00Z', type: 'replied', pr: 'o/r#9' },
    { at: '2026-11-05T00:00:01Z', type: 'replied', pr: 'o/r#2' },
    { at: '2026-11-05T00:00:02Z', type: 'resolved', pr: 'o/r#2' },
    { at: '2026-11-05T00:00:03Z', type: 'reviewed', pr: 'o/r#2', event: 'COMMENT', findings: [{}, {}] },
    { at: '2026-11-05T00:00:04Z', type: 'deferred', pr: 'o/r#3' },
    { at: '2026-11-05T00:00:05Z', type: 'seen', pr: 'o/r#4' },
  ];
  assert.equal(
    runSummary(events, '2026-11-05T00:00:00Z'),
    ['| PR | Comments | Replies | Resolved | Note |', '|---|---|---|---|---|', '| [o/r#2](https://github.com/o/r/pull/2) | 2 | 1 | 1 |  |', '| [o/r#3](https://github.com/o/r/pull/3) | 0 | 0 | 0 | deferred |'].join('\n'),
  );
  assert.equal(runSummary([], '2026-11-05T00:00:00Z'), 'No PRs reviewed and nothing posted.');
});

const good = { grounded: 5, clear: 4, actionable: 4, worthIt: 5 };

test('the judge file needs every score from 1 to 5, and a reason for each low one', () => {
  assert.deepEqual(checkScores({ reviews: [{ pr: 'o/r#2', scores: good }] }), [{ pr: 'o/r#2', scores: good, low: [] }]);
  assert.throws(() => checkScores({}), /reviews/);
  assert.throws(() => checkScores({ reviews: [{ pr: 'r#2', scores: good }] }), /owner\/repo#12/);
  assert.throws(() => checkScores({ reviews: [{ pr: 'o/r#2', scores: { ...good, clear: 6 } }] }), /clear/);
  assert.throws(() => checkScores({ reviews: [{ pr: 'o/r#2', scores: { ...good, worthIt: 2 } }] }), /needs a "low" entry/);
  assert.equal(checkScores({ reviews: [{ pr: 'o/r#2', scores: { ...good, worthIt: 2 }, low: [{ id: 'nit-1', why: 'a nit nobody needs' }] }] })[0]!.low.length, 1);
});

test('the retro lists low scores; stats average them', () => {
  const events: LoggedEvent[] = [
    { at: '2026-11-05T00:00:01Z', type: 'scored', pr: 'o/r#2', scores: good },
    { at: '2026-11-05T00:00:02Z', type: 'scored', pr: 'o/r#3', scores: { ...good, worthIt: 1 } },
  ];
  assert.deepEqual(retro(events, '2026-11-05T00:00:00Z').lowScores.map((e) => e.pr), ['o/r#3']);
  assert.deepEqual(qualityAverages(events), { reviews: 2, grounded: 5, clear: 4, actionable: 4, worthIt: 3 });
  assert.equal(qualityAverages([]), null);
});

test('cycle time runs from opening to the first Sous review, and from that review to the merge', () => {
  const events: LoggedEvent[] = [
    { at: '2026-11-05T02:00:00Z', type: 'reviewed', pr: 'o/r#2' },
    { at: '2026-11-05T09:00:00Z', type: 'reviewed', pr: 'o/r#2' },
    { at: '2026-11-05T04:00:00Z', type: 'reviewed', pr: 'o/r#3' },
  ];
  const prs = { 'o/r#2': { createdAt: '2026-11-05T00:00:00Z', mergedAt: '2026-11-05T12:00:00Z' }, 'o/r#3': { createdAt: '2026-11-05T00:00:00Z', mergedAt: null } };
  assert.deepEqual(cycleTimes(events, prs), { prs: 2, merged: 1, medianHoursToFirstReview: 3, medianHoursFromReviewToMerge: 10 });
});

test('a scoped retro counts only its own session cost and its own PRs', () => {
  const events: LoggedEvent[] = [
    { at: '2026-11-05T00:00:01Z', type: 'reviewed', pr: 'o/r#1', event: 'COMMENT', findings: [{}] },
    { at: '2026-11-05T00:00:02Z', type: 'reviewed', pr: 'o/r#2', event: 'COMMENT', findings: [{}] },
    { at: '2026-11-05T00:00:03Z', type: 'lint-refused', pr: 'o/r#2' },
    { ...usage('2026-11-05T00:01:00Z', 100, 60, 'review'), session: 'a' },
    { ...usage('2026-11-05T00:01:01Z', 900, 60, 'review'), session: 'b' },
  ];
  const r = retro(events, '2026-11-05T00:00:00Z', 10, { session: 'a', prs: ['o/r#1'] });
  assert.deepEqual(r.reviews.map((x) => x.pr), ['o/r#1']);
  assert.equal(r.problems.length, 0);
  assert.equal(r.cost?.paidTokens, 100);
});

test('a review already scored since its last post is not scored again', async () => {
  const { unscored } = await import('../src/retro.ts');
  const s = { pr: 'o/r#1', scores: good, low: [] };
  const posted: LoggedEvent = { at: '2026-11-05T00:00:01Z', type: 'reviewed', pr: 'o/r#1' };
  assert.equal(unscored([posted], [s]).length, 1);
  assert.equal(unscored([posted, { at: '2026-11-05T00:00:02Z', type: 'scored', pr: 'o/r#1' }], [s]).length, 0);
  assert.equal(unscored([posted, { at: '2026-11-05T00:00:02Z', type: 'scored', pr: 'o/r#1' }, { at: '2026-11-05T00:00:03Z', type: 'reviewed', pr: 'o/r#1' }], [s]).length, 1, 'a new review is scored');
});

test('skips that are policy and rebase skips are not problems; a skip on an error is', () => {
  const events: LoggedEvent[] = [
    { at: '2026-11-05T00:00:01Z', type: 'skipped', pr: 'o/r#1', why: 'bot author' },
    { at: '2026-11-05T00:00:02Z', type: 'skipped', pr: 'o/r#2', why: 'error: gh: HTTP 503' },
    { at: '2026-11-05T00:00:03Z', type: 'rebase-skip', pr: 'o/r#3' },
  ];
  assert.deepEqual(retro(events, '2026-11-05T00:00:00Z').problems.map((e) => e.pr), ['o/r#2']);
});
