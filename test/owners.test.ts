import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ownersOf, parseCodeowners, unownedChanges } from '../src/owners.ts';

const rules = parseCodeowners(`
# everything
*            @acme/devs
/infra/      @acme/reviewers   # human review for infra
*.md         @docs-person
docs/**/*.yml @acme/docs
apps/web     @web-person
`);

test('the last matching line wins, with gitignore-style patterns', () => {
  assert.deepEqual(ownersOf(rules, 'src/a.ts'), ['@acme/devs']);
  assert.deepEqual(ownersOf(rules, 'infra/projects/x.ts'), ['@acme/reviewers']);
  assert.deepEqual(ownersOf(rules, 'services/infra/x.ts'), ['@acme/devs'], 'a leading slash anchors to the root');
  assert.deepEqual(ownersOf(rules, 'infra/README.md'), ['@docs-person']);
  assert.deepEqual(ownersOf(rules, 'docs/a/b/c.yml'), ['@acme/docs']);
  assert.deepEqual(ownersOf(rules, 'apps/web/src/x.tsx'), ['@web-person'], 'a folder pattern covers its contents');
});

test('changed paths with no owner asked are reported', () => {
  const asked = { users: ['someone'], teams: ['devs'] };
  assert.deepEqual(unownedChanges(rules, ['src/a.ts', 'infra/x.ts'], asked), [{ path: 'infra/x.ts', owners: ['@acme/reviewers'] }]);
  assert.deepEqual(unownedChanges(rules, ['infra/x.ts'], { users: [], teams: ['reviewers'] }), []);
  assert.deepEqual(unownedChanges(rules, ['README.md'], { users: ['Docs-Person'], teams: [] }), []);
  assert.deepEqual(unownedChanges(parseCodeowners(''), ['x'], asked), []);
});
