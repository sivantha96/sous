import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkOutbound, ensureCanaries, otherOrgTerms } from '../src/outbound.ts';

const rules = { org: 'acme', otherOrgTerms: ['globex', 'billing-service'], linkHosts: ['docs.aws.amazon.com'] };

test('a plain finding with links to this org passes', () => {
  assert.deepEqual(checkOutbound('This drops the retry. See https://github.com/acme/core/blob/abc/src/a.ts#L3 and https://docs.aws.amazon.com/iam/x.html', rules), []);
});

test('another org name, the canary and outside links are refused', () => {
  assert.equal(checkOutbound('same as globex does', rules).length, 1);
  assert.equal(checkOutbound('memory says sous-canary-0123456789abcdef', rules).length, 1);
  assert.equal(checkOutbound('see https://evil.example/x', rules).length, 1);
  assert.equal(checkOutbound('see https://github.com/someone-else/repo', rules).length, 1);
  assert.equal(checkOutbound('see http://github.com/acme/core', rules).length, 1);
  assert.equal(checkOutbound('see https://docs.aws.amazon.com/x?d=secret', rules).length, 1);
});

test('other orgs are denied, the posting org is not', () => {
  const home = mkdtempSync(join(tmpdir(), 'sous-'));
  for (const org of ['acme', 'globex-corp']) mkdirSync(join(home, 'orgs', org), { recursive: true });
  writeFileSync(join(home, 'orgs', 'globex-corp', 'denylist.json'), JSON.stringify(['ledger-api', 'core']));
  writeFileSync(join(home, 'orgs', 'acme', 'denylist.json'), JSON.stringify(['ledger-api']));
  const terms = otherOrgTerms('acme', home);
  assert.ok(terms.includes('globex-corp') && terms.includes('globex'));
  assert.ok(!terms.includes('acme') && !terms.includes('ledger-api'), 'a name both orgs use is not a leak');
});

test('every memory file gets one canary, once', () => {
  const home = mkdtempSync(join(tmpdir(), 'sous-'));
  process.env.SOUS_HOME = home;
  mkdirSync(join(home, 'me'), { recursive: true });
  mkdirSync(join(home, 'orgs', 'acme', 'rules'), { recursive: true });
  writeFileSync(join(home, 'me', 'voice.md'), '- short\n');
  writeFileSync(join(home, 'orgs', 'acme', 'rules', 'seed.md'), '- [scope: all] a rule\n');
  assert.equal(ensureCanaries(), 2);
  assert.equal(ensureCanaries(), 0);
  const text = readFileSync(join(home, 'me', 'voice.md'), 'utf8');
  assert.match(text, /^<!-- sous-canary-[0-9a-f]{16} -->\n- short\n$/);
  delete process.env.SOUS_HOME;
});
