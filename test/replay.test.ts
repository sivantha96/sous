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
