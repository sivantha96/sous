import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyCorrections, completePath, decidedTwice, diffLines, isDuplicate, locate, missingDecisions, verifyEvidence } from '../src/evidence.ts';
import type { Finding } from '../src/voice-lint.ts';

const patch = '@@ -1,4 +1,4 @@\n a\n-if (!tenant) throw\n+run()\n c\n d';

test('diff lines per side: removed lines are LEFT anchors', () => {
  const d = diffLines(patch);
  assert.deepEqual([...d.RIGHT], [1, 2, 3, 4]);
  assert.deepEqual([...d.LEFT], [1, 2, 3, 4]);
  assert.ok(diffLines('@@ -10,2 +10,1 @@\n-gone\n kept').LEFT.has(10) && !diffLines('@@ -10,2 +10,1 @@\n-gone\n kept').RIGHT.has(11));
});

test('a quote moves to the one line within 3 that holds it; a tie or a miss fails', () => {
  const lines = ['a', 'b', 'x = 1', 'c', 'd', 'e', 'f', 'x = 1'];
  assert.equal(locate(lines, 3, 'x = 1'), 3);
  assert.equal(locate(lines, 4, 'x = 1'), 3);
  assert.equal(locate(lines, 5, 'x = 1'), null, 'lines 3 and 8 are both within 3: a tie');
  assert.equal(locate(lines, 1, 'zzz'), null);
  assert.equal(locate(['y', 'y', 'q', 'y'], 3, 'y'), null);
});

test('shortened paths complete only when one file matches', () => {
  assert.equal(completePath('a.ts', ['src/a.ts', 'src/b.ts']), 'src/a.ts');
  assert.equal(completePath('a.ts', ['src/a.ts', 'lib/a.ts']), null);
});

const files = { 'src/a.ts': ['a', 'run()', 'c', 'd'], 'src/g.ts': ['export function guard() {}'] };
const ctx = {
  files: [{ filename: 'src/a.ts', patch }],
  tree: Object.keys(files),
  read: (side: 'RIGHT' | 'LEFT', path: string) => (side === 'LEFT' ? ['a', 'if (!tenant) throw', 'c', 'd'] : (files as Record<string, string[]>)[path] ?? null),
};
const base: Finding = { severity: 'major', path: 'a.ts', line: 4, body: 'x', quote: 'run()', evidence: [{ path: 'src/a.ts', line: 2, quote: 'run()' }], counterEvidence: [{ path: 'g.ts', line: 1, quote: 'guard()' }] };

test('evidence is checked against real files; paths complete and lines move', () => {
  const r = verifyEvidence([base], ctx);
  assert.deepEqual(r.problems, []);
  assert.equal(r.findings[0]!.path, 'src/a.ts');
  assert.equal(r.findings[0]!.line, 2);
  assert.equal(r.findings[0]!.counterEvidence![0]!.path, 'src/g.ts');
});

test('missing counter-evidence, a wrong quote and a LEFT anchor on a removed line', () => {
  const r = verifyEvidence([{ ...base, counterEvidence: [] }, { ...base, quote: 'nope' }], ctx);
  assert.ok(r.problems.some((p) => p.index === 0 && /counter-evidence/.test(p.problem)));
  assert.ok(r.problems.some((p) => p.index === 1 && /quote not found/.test(p.problem)));
  const left = verifyEvidence([{ ...base, side: 'LEFT', line: 2, quote: 'if (!tenant)' }], ctx);
  assert.deepEqual(left.problems, []);
});

test('a repair changes only line, side, path or quote', () => {
  const [f] = applyCorrections([base], [{ index: 0, target: 'anchor', field: 'line', value: 2 }, { index: 0, target: 'anchor', field: 'body' as 'line', value: 'rewritten' }, { index: 0, target: 'evidence', item: 0, field: 'quote', value: 'a' }]);
  assert.equal(f!.line, 2);
  assert.equal(f!.body, 'x');
  assert.equal(f!.evidence![0]!.quote, 'a');
});

test('a repair aimed at a missing finding or item fails loudly instead of doing nothing', () => {
  assert.throws(() => applyCorrections([{ ...base, counterEvidence: [] }], [{ index: 0, target: 'counterEvidence', item: 0, field: 'quote', value: 'q' }]), /can't add one/);
  assert.throws(() => applyCorrections([base], [{ index: 3, target: 'anchor', field: 'line', value: 2 }]), /no such finding/);
});

test('the same point already posted is a duplicate; a different point on the same line is not', () => {
  const e = { path: 'src/a.ts', line: 10, body: 'this throws on an empty list. more' };
  assert.ok(isDuplicate({ path: 'src/a.ts', line: 12, body: 'this throws on an empty list' }, e));
  assert.ok(!isDuplicate({ path: 'src/a.ts', line: 10, body: 'the tenant check is missing here' }, e));
  assert.ok(!isDuplicate({ path: 'src/a.ts', line: 20, body: 'this throws on an empty list' }, e));
});

test('every candidate id needs exactly one verifier decision', () => {
  assert.deepEqual(missingDecisions(['c-1', 'c-2', 'c-3'], { kept: [{ id: 'c-1', merged: ['c-2'] }], dropped: [{ id: 'c-3' }] }), []);
  assert.deepEqual(missingDecisions(['c-1', 'c-2'], { kept: [{ id: 'c-1' }], dropped: [{ id: 'c-1' }] }), ['c-1', 'c-2']);
});

test('an id merged and also dropped is decided twice; an undecided one is only missing', () => {
  const v = { kept: [{ id: 'a', merged: ['b'] }], dropped: [{ id: 'b' }] };
  assert.deepEqual(decidedTwice(['a', 'b', 'c'], v), ['b']);
  assert.deepEqual(missingDecisions(['a', 'b', 'c'], v), ['b', 'c']);
});
