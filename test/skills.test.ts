import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { findSkill } from '../src/skills.ts';

test('finds a plugin skill in the newest cached version, and a personal skill by name', () => {
  const home = mkdtempSync(join(tmpdir(), 'skills-'));
  for (const v of ['1.0.0', '1.2.0']) {
    mkdirSync(join(home, '.claude/plugins/cache/market/mobile', v, 'skills/conventions'), { recursive: true });
    writeFileSync(join(home, '.claude/plugins/cache/market/mobile', v, 'skills/conventions/SKILL.md'), v);
  }
  mkdirSync(join(home, '.claude/skills/house-style'), { recursive: true });
  writeFileSync(join(home, '.claude/skills/house-style/SKILL.md'), 'x');
  assert.equal(findSkill('mobile:conventions', home), join(home, '.claude/plugins/cache/market/mobile/1.2.0/skills/conventions/SKILL.md'));
  assert.equal(findSkill('house-style', home), join(home, '.claude/skills/house-style/SKILL.md'));
  assert.equal(findSkill('mobile:missing', home), null);
});
