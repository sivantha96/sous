import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, sousHome } from './home.ts';

// Repo names that are also everyday words or tools Sous integrates with; flagging them would block every PR.
const COMMON = new Set(['coderabbit', 'core', 'shared', 'docs', 'common', 'utils', 'config', 'tools', 'infra', 'scripts', 'tests', 'test', 'apps', 'site', 'website', 'mobile', 'backend', 'frontend', 'github', 'api', 'web', 'app']);

/**
 * Every name that must never leave local memory: watched orgs, their repos, PR authors
 * and anything listed in an org's denylist.json. Built from ~/.sous, so it grows as Sous learns.
 */
export function buildDenylist(home = sousHome()): string[] {
  const terms = new Set<string>();
  const orgsDir = join(home, 'orgs');
  const orgs = existsSync(orgsDir) ? readdirSync(orgsDir) : [];
  for (const org of orgs) {
    terms.add(org);
    for (const part of org.split('-')) terms.add(part);
    for (const t of readJson<string[]>(join(orgsDir, org, 'denylist.json'), [])) terms.add(t);
  }
  return [...terms].filter((t) => t.length >= 4 && !COMMON.has(t.toLowerCase()));
}

export interface Leak {
  term: string;
  line: number;
  text: string;
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function findLeaks(text: string, denylist: string[]): Leak[] {
  if (denylist.length === 0) return [];
  const re = new RegExp(`(?<![A-Za-z0-9])(${denylist.map(escape).join('|')})(?![A-Za-z0-9])`, 'i');
  return text.split('\n').flatMap((line, i) => {
    const m = re.exec(line);
    return m ? [{ term: m[1]!, line: i + 1, text: line.trim().slice(0, 120) }] : [];
  });
}
