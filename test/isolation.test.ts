import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'sous-iso-'));
process.env.SOUS_HOME = home;
const { checkOutbound, otherOrgTerms } = await import('../src/outbound.ts');
const { checkFocus, checkWrite } = await import('../src/guard.ts');
const { focusPath } = await import('../src/home.ts');

for (const org of ['acme', 'globex']) mkdirSync(join(home, 'orgs', org), { recursive: true });
writeFileSync(join(home, 'orgs', 'globex', 'denylist.json'), JSON.stringify(['core', 'ledgerly']));
writeFileSync(join(home, 'orgs', 'globex', 'state.json'), JSON.stringify({ prs: { 'globex/payments-hub#4': {} } }));
writeFileSync(join(home, 'orgs', 'globex', 'profile.json'), JSON.stringify({ linkHosts: ['wiki.globex.io'] }));
mkdirSync(join(home, 'cache', 'globex', 'billing-engine'), { recursive: true });

test("the other org's repos, clones, hosts and denylist are refused in a comment; everyday words are not", () => {
  const terms = otherOrgTerms('acme', home);
  for (const t of ['globex', 'payments-hub', 'billing-engine', 'wiki.globex.io', 'ledgerly']) assert.ok(terms.includes(t), t);
  assert.ok(!terms.includes('core'), '"core" is an everyday word, not a leak');
  const rules = { org: 'acme', otherOrgTerms: terms, linkHosts: [] };
  assert.equal(checkOutbound('the core loop retries forever', rules).length, 0);
  assert.equal(checkOutbound('same as payments-hub does it', rules).length, 1);
});

test('a session focused on one org cannot touch another org, its subagents included', () => {
  mkdirSync(join(home, 'sessions'), { recursive: true });
  writeFileSync(focusPath('s1'), JSON.stringify({ org: 'acme' }));
  const call = (tool_name: string, tool_input: Record<string, string>, agent_type?: string) => checkFocus({ tool_name, tool_input, session_id: 's1', agent_type }, home);
  assert.equal(call('Read', { file_path: join(home, 'orgs', 'globex', 'rules', 'seed.md') }, 'lens').ok, false);
  assert.equal(call('Read', { file_path: join(home, 'cache', 'globex', 'billing-engine', 'a.ts') }).ok, false);
  assert.equal(call('Bash', { command: 'gh api repos/globex/payments-hub/pulls/4' }, 'gatherer').ok, false);
  assert.equal(call('Bash', { command: '/usr/bin/grep -rn x /tmp/globex/' }, 'lens').ok, false);
  assert.equal(call('Read', { file_path: join(home, 'orgs', 'acme', 'rules', 'seed.md') }, 'lens').ok, true);
  assert.equal(call('Bash', { command: 'gh api repos/acme/site/pulls/1' }).ok, true);
  assert.equal(checkFocus({ tool_name: 'Read', tool_input: { file_path: join(home, 'orgs', 'globex', 'x.md') }, session_id: 'other' }, home).ok, true, 'a session with no focus is not fenced');
});

test('only the main session sets the focus', () => {
  assert.equal(checkWrite(focusPath('s1'), 'reflector', home).ok, false);
  assert.equal(checkWrite(focusPath('s1'), 'main', home).ok, true);
});
