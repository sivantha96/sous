import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanForPublishing, findSecrets } from '../src/published.ts';
import { lintText } from '../src/voice-lint.ts';

test('credential shapes are redacted and refused by the lint', () => {
  const t = 'token ghp_abcdefghijklmnopqrstuvwxyz0123 and AKIAABCDEFGHIJKLMNOP';
  assert.equal(cleanForPublishing(t), 'token [redacted] and [redacted]');
  assert.deepEqual(findSecrets(t), ['GitHub token', 'AWS access key']);
  assert.ok(lintText(t).some((p) => /cite where it is/.test(p)));
  assert.deepEqual(findSecrets('see src/config.ts:12'), []);
});

test('images become links and @mentions are put in code, outside code spans', () => {
  assert.equal(cleanForPublishing('![x](https://t.example/p.png)'), '[image: x](https://t.example/p.png)');
  assert.equal(cleanForPublishing('ask @octocat or @dinetap/reviewers'), 'ask `@octocat` or `@dinetap/reviewers`');
  assert.equal(cleanForPublishing('mail a@b.com and `@types/node`'), 'mail a@b.com and `@types/node`');
});
