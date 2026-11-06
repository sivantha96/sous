import assert from 'node:assert/strict';
import { test } from 'node:test';
import { retro, runSummary } from '../src/retro.ts';
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
