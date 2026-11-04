import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gate, type CodeRabbitSignal } from '../src/gate.ts';

const t0 = new Date('2026-11-04T10:00:00Z');
const at = (min: number) => new Date(t0.getTime() + min * 60_000);
const run = (signal: CodeRabbitSignal, opts: { pushedMin?: number; runMin?: number; nowMin: number; enabled?: boolean }) =>
  gate({ enabled: opts.enabled ?? true, signal, pushedAt: at(opts.pushedMin ?? 0), runStartedAt: at(opts.runMin ?? opts.nowMin), now: at(opts.nowMin) });

const reviewing: CodeRabbitSignal = { check: { status: 'in_progress', conclusion: null }, rateLimited: false };
const none: CodeRabbitSignal = { check: null, rateLimited: false };

test('org without CodeRabbit reviews at once', () => {
  assert.deepEqual(run(none, { nowMin: 0, enabled: false }), { action: 'review' });
});

test('CodeRabbit still reviewing: wait, then defer after 15 minutes in one run', () => {
  assert.equal(run(reviewing, { nowMin: 5 }).action, 'wait');
  assert.equal(run(reviewing, { runMin: 5, nowMin: 14 }).action, 'wait');
  assert.equal(run(reviewing, { runMin: 5, nowMin: 18 }).action, 'defer');
});

test('CodeRabbit finished: review', () => {
  assert.deepEqual(run({ check: { status: 'completed', conclusion: 'success' }, rateLimited: false }, { nowMin: 6 }), { action: 'review' });
});

test('rate limited (completed neutral): review with a note', () => {
  const r = run({ check: { status: 'completed', conclusion: 'neutral' }, rateLimited: true }, { nowMin: 2 });
  assert.equal(r.action, 'review');
  assert.match((r as { note: string }).note, /rate limited/);
});

test('never started: wait inside the 30-minute grace, then review with a note', () => {
  assert.equal(run(none, { nowMin: 10 }).action, 'wait');
  const r = run(none, { nowMin: 31 });
  assert.equal(r.action, 'review');
  assert.match((r as { note: string }).note, /did not run/);
});
