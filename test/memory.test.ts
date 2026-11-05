import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diffTerms, factState, parseBullets, pinBullet, scopeMatches, searchMemory } from '../src/memory.ts';

const md = [
  '# Rules',
  '- [scope: services/api/**] A retry must not run a money handler twice (source: core#136 comment)',
  '- [scope: infra/**] Never hand-write a hostname; use `globalHost` (source: AGENTS.md) (cite: o/r:infra/hostnames.ts@abc1234def56)',
  '- Org repos live in `repos`. Proof: `infra/projects/saas/github.ts`, `AGENTS.md`',
].join('\n');

test('bullets parse scope, source and cites in both forms', () => {
  const b = parseBullets('rules.md', md);
  assert.equal(b.length, 3);
  assert.deepEqual(b[0]!.scope, ['services/api/**']);
  assert.equal(b[0]!.source, 'core#136 comment');
  assert.deepEqual(b[1]!.cites, [{ repo: 'o/r', path: 'infra/hostnames.ts', sha: 'abc1234def56' }]);
  assert.deepEqual(b[2]!.cites.map((c) => c.path), ['infra/projects/saas/github.ts', 'AGENTS.md']);
});

test('search finds bullets by scope and by the diff names, ranked', () => {
  const b = parseBullets('rules.md', md);
  const hits = searchMemory(b, ['packages/web/src/site.ts'], ['globalHost', 'repos']);
  assert.deepEqual(hits.map((h) => h.bullet.line), [3, 4]);
  assert.ok(scopeMatches(['services/api/**'], ['services/api/src/x.ts']));
  assert.ok(!scopeMatches(['services/api/**'], ['services/web/x.ts']));
});

test('diff terms: exports, env vars, endpoints, packages, basenames', () => {
  const t = diffTerms([{ filename: 'src/money/charge.ts', patch: "@@ -1 +1 @@\n+export function chargeCard() {}\n+const k = process.env.STRIPE_API_KEY\n+fetch('/v1/orders/{id}')\n+import x from '@dinetap/flags'" }]);
  for (const x of ['charge', 'chargeCard', 'STRIPE_API_KEY', '/v1/orders/{id}', '@dinetap/flags']) assert.ok(t.includes(x), x);
});

test('fact state and pinning', () => {
  assert.equal(factState({ path: 'a', sha: 'abc123' }, 'abc123ff'), 'current');
  assert.equal(factState({ path: 'a', sha: 'abc123' }, 'def456'), 'stale');
  assert.equal(factState({ path: 'a', sha: 'abc123' }, 'deleted'), 'gone');
  assert.equal(factState({ path: 'a' }, 'def456'), 'unpinned');
  assert.equal(pinBullet('- fact. Proof: `a.ts`', [{ path: 'a.ts', sha: 'deadbeefcafe0000' }]), '- fact. (cite: a.ts@deadbeefcafe)');
});
