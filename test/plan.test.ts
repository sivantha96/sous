import assert from 'node:assert/strict';
import { test } from 'node:test';
import { codeLinks, plan } from '../src/plan.ts';

const f = (filename: string, additions = 10, deletions = 0) => ({ filename, additions, deletions });

test('small low-risk PRs run only the core lenses', () => {
  const p = plan([f('src/utils/format.ts', 5), f('src/utils/format.test.ts', 5)], { stacked: false, orgRules: false });
  assert.ok(p.risk < 15);
  assert.deepEqual(p.lenses.sort(), ['correctness', 'docs-and-decisions', 'pr-hygiene', 'tests-and-guards']);
  assert.equal(p.missedPass, false);
});

test('paths match on whole segments, not substrings', () => {
  const p = plan([f('src/tokenizer/threads.ts', 5), f('src/tokenizer/threads.test.ts')], { stacked: false, orgRules: false });
  assert.ok(!p.drivers.includes('auth, tenancy or money'));
});

test('migrations and money raise risk, add lenses and the missed pass', () => {
  const p = plan([f('services/api/src/db/migrations/0003.sql', 40), f('services/api/src/payments/charge.ts', 300)], { stacked: true, orgRules: true });
  assert.ok(p.risk >= 40, String(p.risk));
  for (const l of ['specs-and-safety', 'security', 'stack-consistency', 'org-rules']) assert.ok(p.lenses.includes(l), l);
  assert.equal(p.missedPass, true);
  assert.equal(p.order[0], 'services/api/src/payments/charge.ts');
});

test('code links are found with their lines', () => {
  const l = codeLinks('see https://github.com/o/r/blob/abc123/src/a.ts#L10-L20 and https://github.com/o/r/blob/main/README.md');
  assert.deepEqual(l[0], { owner: 'o', repo: 'r', ref: 'abc123', path: 'src/a.ts', lines: [10, 20] });
  assert.equal(l[1]!.path, 'README.md');
});

test('code comes before its tests in review order', () => {
  const p = plan([f('infra/packages/components/src/components.test.ts', 10), f('infra/packages/registry/src/hostnames.ts', 37)], { stacked: false, orgRules: false });
  assert.equal(p.order[0], 'infra/packages/registry/src/hostnames.ts');
});
