import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { helpFor } from '../src/help.ts';

const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');

test("help reads a command's doc comment and usage from cli.ts", () => {
  const post = helpFor(cli, 'post')!;
  assert.match(post, /^\S/);
  assert.ok(helpFor(cli, 'leak-check')!.includes('text bound for git'));
  assert.equal(helpFor(cli, 'no-such-command'), null);
  assert.equal(helpFor(cli, '.*'), null);
});
