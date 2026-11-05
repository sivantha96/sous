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
  writeFileSync(join(home, 'orgs', 'acme-labs', 'denylist.json'), JSON.stringify(['billing-service', 'core', '.github']));
  const list = buildDenylist(home);
  assert.ok(list.includes('acme-labs') && list.includes('billing-service') && list.includes('labs'));
  assert.ok(!list.includes('core'));
  assert.ok(!list.includes('.github'), "GitHub's own folder name is not an org secret");
});

test('finds org names as whole words only', () => {
  const leaks = findLeaks('use the shared helper\nsee billing-service for this\nrebilling-services is fine', ['billing-service']);
  assert.deepEqual(leaks.map((l) => l.line), [2]);
});

test('voice lint catches em-dash, emoji, please and hedges', () => {
  assert.deepEqual(lintText('remove this, looks unused'), []);
  assert.equal(lintText('please remove — unused \u{1F44D} I think').length, 4);
});

test('a home folder path is a leak even with an empty denylist', () => {
  // Joined at run time so this file passes its own leak check.
  const mac = ['', 'Users', 'someone'].join('/');
  assert.equal(findLeaks(`"'${mac}/.nvm/bin/node' x"`, [])[0]?.term, mac);
  assert.equal(findLeaks(`cd ${['', 'home', 'dev'].join('/')}/project`, []).length, 1);
  assert.equal(findLeaks('see ~/.sous and $HOME/.claude', []).length, 0);
});

test('no tracked file holds a home folder path', async () => {
  const { execFileSync } = await import('node:child_process');
  const { readFileSync } = await import('node:fs');
  const root = join(import.meta.dirname, '..');
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  const found = files.flatMap((f) => findLeaks(readFileSync(join(root, f), 'utf8'), []).map((l) => `${f}:${l.line}`));
  assert.deepEqual(found, []);
});
