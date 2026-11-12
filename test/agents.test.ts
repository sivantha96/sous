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

test('run, reply-judge, gatherer and lens text the orchestration relies on', () => {
  const body = (f: string) => agents.find(([n]) => n === f)![1];
  assert.match(readFileSync(new URL('../.claude/commands/run.md', import.meta.url), 'utf8'), /600000/);
  assert.match(body('reply-judge.md'), /reply-<repo-name>-<n>-<sous-comment-id>/);
  assert.match(body('reply-judge.md'), /by its code point/);
  assert.match(body('gatherer.md'), /An empty search proves nothing/);
  assert.match(body('gatherer.md'), /rev-parse HEAD/);
  assert.match(body('lens.md'), /rev-parse HEAD/);
});
