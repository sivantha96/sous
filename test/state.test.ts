import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.SOUS_HOME = mkdtempSync(join(tmpdir(), 'sous-state-'));
const { emptyPr, loadState, saveState } = await import('../src/state.ts');

test('two copies saved in turn keep both changes: a stale copy never wipes a newer save', () => {
  const seed = loadState('o');
  seed.prs['o/r#1'] = { ...emptyPr('h1'), commentIds: [10] };
  seed.prs['o/r#2'] = emptyPr('h2');
  saveState('o', seed);

  const posting = loadState('o');
  const seeing = loadState('o');
  seeing.prs['o/r#1']!.handled.push(20);
  saveState('o', seeing);
  posting.prs['o/r#1'] = { ...posting.prs['o/r#1']!, head: 'h1b', commentIds: [10, 11] };
  posting.prs['o/r#2']!.head = 'h2b';
  saveState('o', posting);

  const now = loadState('o');
  assert.deepEqual(now.prs['o/r#1']!.handled, [20], 'the earlier save survives');
  assert.deepEqual(now.prs['o/r#1']!.commentIds, [10, 11]);
  assert.equal(now.prs['o/r#1']!.head, 'h1b');
  assert.equal(now.prs['o/r#2']!.head, 'h2b');
});

test('a copy that left a PR alone does not write it back', () => {
  const a = loadState('p');
  a.prs['p/r#1'] = emptyPr('x');
  saveState('p', a);
  const stale = loadState('p');
  const fresh = loadState('p');
  fresh.prs['p/r#1']!.head = 'y';
  saveState('p', fresh);
  stale.prs['p/r#9'] = emptyPr('z');
  saveState('p', stale);
  assert.equal(loadState('p').prs['p/r#1']!.head, 'y');
});
