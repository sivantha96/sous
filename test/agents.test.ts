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

test('the review judge scores posted findings once, and a correct nit by whether it is worth fixing', () => {
  const judge = agents.find(([n]) => n === 'review-judge.md')![1];
  assert.match(judge, /A correct nit/);
  assert.doesNotMatch(judge, /the author would catch/);
  assert.match(judge, /whose `id` is in that `reviewed` line/);
  assert.match(judge, /no `scored` line/);
});

test('the signal collector reads only what came after the last round, and a dismissal by what it dismissed', () => {
  const collector = agents.find(([n]) => n === 'signal-collector.md')![1];
  assert.match(collector, /last `learned` line's `run`/);
  assert.match(collector, /alreadyLearned/);
  assert.match(collector, /dismissed_review\.state/);
});

test('a failed decisions check goes back to the verifier, never a hand fix', () => {
  const review = readFileSync(new URL('../.claude/commands/review.md', import.meta.url), 'utf8');
  assert.match(review, /never edit the verified file yourself/);
  assert.match(review, /invalidJson/);
  assert.match(review, /decidedTwice/);
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
