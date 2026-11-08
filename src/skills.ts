import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { claudeHome } from './home.ts';

/**
 * Where an installed skill's SKILL.md is: `plugin:skill` in the plugin cache
 * (`<config>/plugins/cache/<marketplace>/<plugin>/<version>/skills/<skill>/`), a bare name in
 * `<config>/skills/`, where `<config>` is Claude Code's config dir (`claudeHome()`). Null when it
 * isn't installed on this machine.
 */
export function findSkill(name: string, root = claudeHome()): string | null {
  const [plugin, skill] = name.includes(':') ? name.split(':', 2) : [null, name];
  if (!plugin) {
    const file = join(root, 'skills', skill!, 'SKILL.md');
    return existsSync(file) ? file : null;
  }
  const cache = join(root, 'plugins', 'cache');
  const ls = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir) : []);
  for (const market of ls(cache)) {
    for (const version of ls(join(cache, market, plugin)).sort().reverse()) {
      const file = join(cache, market, plugin, version, 'skills', skill!, 'SKILL.md');
      if (existsSync(file)) return file;
    }
  }
  return null;
}
