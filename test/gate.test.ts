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

test('the gate follows a push during the wait and gates the new head', async () => {
  const { pollGate } = await import('../src/gate.ts');
  const heads = ['a', 'b'];
  const checksRead: string[] = [];
  const gh = async (args: string[]): Promise<string> => {
    const path = args.find((x) => x.startsWith('repos/')) ?? '';
    if (/^repos\/o\/r\/commits\/\w+$/.test(path)) return JSON.stringify({ commit: { committer: { date: new Date().toISOString() } } });
    if (path === 'repos/o/r/pulls/1') return JSON.stringify({ head: { sha: heads.length > 1 ? heads.shift() : heads[0] } });
    const check = /^repos\/o\/r\/commits\/(\w+)\/check-runs/.exec(path);
    if (check) {
      checksRead.push(check[1]!);
      return JSON.stringify({ check_runs: [{ name: 'CodeRabbit', status: check[1] === 'a' ? 'in_progress' : 'completed', conclusion: check[1] === 'a' ? null : 'success', started_at: '2026-01-01T00:00:00Z' }] });
    }
    if (path.startsWith('repos/o/r/issues/1/comments')) return '[]';
    throw new Error(`unexpected ${path}`);
  };
  const profile = { org: 'o', ghAccount: 'me', postingMode: 'post' as const, coderabbit: { login: 'coderabbitai[bot]', checkName: 'CodeRabbit' }, knowledgeGraph: null, ruleSources: [], postSuggestions: false, linkHosts: [], skills: [] };
  const r = await pollGate(gh, profile, 'o/r', 1, 'a', new Date(), { sleep: async () => undefined, budgetMs: 60 * 60_000 });
  assert.equal(r.head, 'b');
  assert.equal(r.action, 'review');
  assert.deepEqual(checksRead, ['a', 'b']);
});
