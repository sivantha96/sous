import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commitAt, gateFails, parseAiReview, scoreCase, totals } from '../src/replay.ts';

test('parses path:line checklist items from an AI review comment', () => {
  const body = '## AI review\n\n### Major\n\n- [ ] `infra/a.ts:31`: docs conflict here\n- [x] **`src/b.ts:10-12`** off by one\nplain line `c.ts:5`';
  assert.deepEqual(parseAiReview(body), [
    { path: 'infra/a.ts', line: 31, text: 'docs conflict here' },
    { path: 'src/b.ts', line: 10, text: 'off by one' },
  ]);
  assert.deepEqual(parseAiReview('- [ ] `a.ts:1` a plain checklist'), []);
});

test('commitAt picks the newest commit at or before the comment', () => {
  const commits = [{ sha: 'a', date: '2026-11-01T00:00:00Z' }, { sha: 'b', date: '2026-11-02T00:00:00Z' }, { sha: 'c', date: '2026-11-03T00:00:00Z' }];
  assert.equal(commitAt(commits, '2026-11-02T12:00:00Z'), 'b');
  assert.equal(commitAt(commits, '2026-10-01T00:00:00Z'), null);
});

test('scoring matches within the line window, once per gold point', () => {
  const gold = [{ path: 'a.ts', line: 10, text: '', source: 'inline' as const }, { path: 'b.ts', line: 50, text: '', source: 'inline' as const }];
  const f = (path: string, line: number, severity: 'major' | 'nit' = 'major') => ({ severity, path, line, body: 'x' });
  const s = scoreCase('c', gold, [f('a.ts', 14), f('a.ts', 12), f('b.ts', 80), f('c.ts', 1, 'nit')]);
  assert.deepEqual(s, { id: 'c', gold: 2, found: 4, matched: 1, nits: 1 });
  assert.deepEqual(totals([s]), { cases: 1, recall: 0.5, precision: 0.25, nitShare: 0.25 });
});

test('the gate blocks a drop beyond tolerance, and passes with no baseline', () => {
  const base = { cases: 5, recall: 0.6, precision: 0.5, nitShare: 0.1 };
  assert.deepEqual(gateFails({ ...base, recall: 0.57 }, base), []);
  assert.equal(gateFails({ ...base, precision: 0.4 }, base).length, 1);
  assert.deepEqual(gateFails(base, null), []);
});

test('the judge pairs the same point made elsewhere; paths match without their folders', async () => {
  const { samePath } = await import('../src/replay.ts');
  assert.ok(samePath('docs/decisions/a.md', 'a.md') && !samePath('docs/a.md', 'xa.md'));
  const gold = [{ path: 'src/boot.ts', line: 45, text: '', source: 'inline' as const }, { path: 'a.md', line: 27, text: '', source: 'ai-review' as const }];
  const f = (path: string, line: number) => ({ severity: 'major' as const, path, line, body: 'x' });
  // Same point 44 lines away: only the judge can pair it. Folder-less gold path matches by suffix.
  assert.equal(scoreCase('c', gold, [f('src/boot.ts', 89), f('docs/decisions/a.md', 25)]).matched, 1);
  assert.equal(scoreCase('c', gold, [f('src/boot.ts', 89), f('docs/decisions/a.md', 25)], 10, [[0, 0]]).matched, 2);
  // A judge pair can't reuse a point or a finding.
  assert.equal(scoreCase('c', gold, [f('x.ts', 1)], 10, [[0, 0], [1, 0], [5, 0]]).matched, 1);
});

test('the fallback needs 3 lines, or a shared code name within 10', async () => {
  const { lineMatch, lensRecall, meanTotals } = await import('../src/replay.ts');
  const g = { path: 'a.ts', line: 20, text: '`chargeCard` retries twice', source: 'inline' as const };
  assert.ok(lineMatch(g, { path: 'a.ts', line: 22, body: 'anything' }));
  assert.ok(!lineMatch(g, { path: 'a.ts', line: 28, body: 'a different problem' }));
  assert.ok(lineMatch(g, { path: 'a.ts', line: 28, body: 'chargeCard has no idempotency key' }));
  assert.equal(lensRecall([g], [{ path: 'a.ts', line: 21, body: 'x' }]), 1);
  assert.deepEqual(meanTotals([{ cases: 5, recall: 0.4, precision: 0.5, nitShare: 0.1 }, { cases: 5, recall: 0.3, precision: 0.4, nitShare: 0.2 }]), { cases: 5, recall: 0.35, precision: 0.45, nitShare: 0.15 });
});
