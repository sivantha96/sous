import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { findSkill } from '../src/skills.ts';

test('finds a plugin skill in the newest cached version, and a personal skill by name', () => {
  const config = mkdtempSync(join(tmpdir(), 'skills-'));
  for (const v of ['1.0.0', '1.2.0']) {
    mkdirSync(join(config, 'plugins/cache/market/mobile', v, 'skills/conventions'), { recursive: true });
    writeFileSync(join(config, 'plugins/cache/market/mobile', v, 'skills/conventions/SKILL.md'), v);
  }
  mkdirSync(join(config, 'skills/house-style'), { recursive: true });
  writeFileSync(join(config, 'skills/house-style/SKILL.md'), 'x');
  assert.equal(findSkill('mobile:conventions', config), join(config, 'plugins/cache/market/mobile/1.2.0/skills/conventions/SKILL.md'));
  assert.equal(findSkill('house-style', config), join(config, 'skills/house-style/SKILL.md'));
  assert.equal(findSkill('mobile:missing', config), null);
});

test('Claude Code config dir: CLAUDE_CONFIG_DIR when set, else ~/.claude', async () => {
  const { claudeHome } = await import('../src/home.ts');
  assert.equal(claudeHome({}, '/h/me'), '/h/me/.claude');
  assert.equal(claudeHome({ CLAUDE_CONFIG_DIR: '/h/me/.claude-work' }, '/h/me'), '/h/me/.claude-work');
  assert.equal(claudeHome({ CLAUDE_CONFIG_DIR: '' }, '/h/me'), '/h/me/.claude');
});
