import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const dir = new URL('../.claude/agents/', import.meta.url);
const agents = readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => [f, readFileSync(new URL(f, dir), 'utf8')] as const);
const tools = (body: string) => /^tools: (.*)$/m.exec(body)![1]!.split(', ');

test('an agent told to use Edit or Write has that tool', () => {
  for (const [name, body] of agents) {
    if (/with Edit\b/.test(body)) assert.ok(tools(body).includes('Edit'), `${name} needs Edit`);
    if (/with (the )?Write\b/.test(body)) assert.ok(tools(body).includes('Write'), `${name} needs Write`);
  }
});

test('lenses get file lines and repo paths, not context-file copies', () => {
  const body = (f: string) => agents.find(([n]) => n === f)![1];
  assert.match(body('gatherer.md'), /never retype code/);
  assert.match(body('gatherer.md'), /hunk header/);
  assert.match(body('gatherer.md'), /never from an earlier context file/);
  assert.match(body('lens.md'), /never a line of the context file/);
  assert.match(body('lens.md'), /never the context file/);
  assert.match(body('verifier.md'), /never a file in `~\/\.sous\/`/);
});
