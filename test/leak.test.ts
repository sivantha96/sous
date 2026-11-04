import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildDenylist, findLeaks } from '../src/leak.ts';
import { lintText } from '../src/voice-lint.ts';

test('denylist comes from local org folders and skips common words', () => {
  const home = mkdtempSync(join(tmpdir(), 'sous-'));
  mkdirSync(join(home, 'orgs', 'acme-labs'), { recursive: true });
  writeFileSync(join(home, 'orgs', 'acme-labs', 'denylist.json'), JSON.stringify(['billing-service', 'core']));
  const list = buildDenylist(home);
  assert.ok(list.includes('acme-labs') && list.includes('billing-service') && list.includes('labs'));
  assert.ok(!list.includes('core'));
});

test('finds org names as whole words only', () => {
  const leaks = findLeaks('use the shared helper\nsee billing-service for this\nrebilling-services is fine', ['billing-service']);
  assert.deepEqual(leaks.map((l) => l.line), [2]);
});

test('voice lint catches em-dash, emoji, please and hedges', () => {
  assert.deepEqual(lintText('remove this, looks unused'), []);
  assert.equal(lintText('please remove — unused \u{1F44D} I think').length, 4);
});
