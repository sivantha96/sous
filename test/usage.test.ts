import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeUsage, usageByModel } from '../src/usage.ts';

test('usage sums per model and counts a streamed reply once', () => {
  const line = (id: string, model: string, out: number) => JSON.stringify({ message: { id, model, usage: { input_tokens: 2, output_tokens: out, cache_read_input_tokens: 100, cache_creation_input_tokens: 10 } } });
  const u = usageByModel([line('m1', 'claude-haiku-5-5', 5), line('m1', 'claude-haiku-5-5', 5), line('m2', 'claude-opus-5-5', 50), '{"type":"user"}', 'not json'].join('\n'));
  assert.deepEqual(u['claude-haiku-5-5'], { input: 2, output: 5, cacheRead: 100, cacheWrite: 10, calls: 1 });
  assert.equal(u['claude-opus-5-5']!.output, 50);
  assert.equal(mergeUsage({}, u)['claude-opus-5-5']!.calls, 1);
});

test('an agent ran from its first to its last timestamp; lines without one are skipped', async () => {
  const { spanSeconds } = await import('../src/usage.ts');
  const at = (t: string) => JSON.stringify({ type: 'assistant', timestamp: t });
  assert.equal(spanSeconds([at('2026-11-05T10:00:00Z'), '{"type":"session-owner"}', 'not json', at('2026-11-05T10:02:30Z')].join('\n')), 150);
  assert.equal(spanSeconds(at('2026-11-05T10:00:00Z')), 0);
});
