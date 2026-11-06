import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withRetry, type Gh } from '../src/gh.ts';

const flaky = (fails: number, message = 'dial tcp 1.2.3.4:443: i/o timeout'): Gh & { calls: number } => {
  const gh = (async () => {
    gh.calls++;
    if (gh.calls <= fails) throw new Error(message);
    return 'ok';
  }) as Gh & { calls: number };
  gh.calls = 0;
  return gh;
};

test('a read that hits a network timeout is retried; a write or another error is not', async () => {
  const read = flaky(2);
  assert.equal(await withRetry(read, [0, 0])(['api', 'repos/o/r/pulls/1']), 'ok');
  assert.equal(read.calls, 3);

  const down = flaky(5);
  await assert.rejects(withRetry(down, [0, 0])(['api', 'x']), /i\/o timeout/);
  assert.equal(down.calls, 3);

  for (const [args, stdin] of [[['api', '-X', 'POST', 'x'], undefined], [['api', 'x', '--input', '-'], '{}'], [['api', 'graphql', '-f', 'query=mutation{x}'], undefined]] as const) {
    const write = flaky(1);
    await assert.rejects(withRetry(write, [0])([...args], stdin));
    assert.equal(write.calls, 1);
  }

  const notFound = flaky(1, 'HTTP 404');
  await assert.rejects(withRetry(notFound, [0])(['api', 'x']), /404/);
  assert.equal(notFound.calls, 1);
});
