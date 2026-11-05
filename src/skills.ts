import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Where an installed skill's SKILL.md is: `plugin:skill` in the plugin cache
 * (`~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/skills/<skill>/`), a bare name in
 * `~/.claude/skills/`. Null when it isn't installed on this machine.
 */
export function findSkill(name: string, home = homedir()): string | null {
  const [plugin, skill] = name.includes(':') ? name.split(':', 2) : [null, name];
  if (!plugin) {
    const file = join(home, '.claude', 'skills', skill!, 'SKILL.md');
    return existsSync(file) ? file : null;
  }
  const cache = join(home, '.claude', 'plugins', 'cache');
  const ls = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir) : []);
  for (const market of ls(cache)) {
    for (const version of ls(join(cache, market, plugin)).sort().reverse()) {
      const file = join(cache, market, plugin, version, 'skills', skill!, 'SKILL.md');
      if (existsSync(file)) return file;
    }
  }
  return null;
}
