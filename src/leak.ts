import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, sousHome } from './home.ts';

// Repo names that are also everyday words or tools Sous integrates with; flagging them would block every PR.
export const COMMON = new Set(['.github', 'coderabbit', 'global', 'core', 'shared', 'docs', 'common', 'utils', 'config', 'tools', 'infra', 'scripts', 'tests', 'test', 'apps', 'site', 'website', 'mobile', 'backend', 'frontend', 'github', 'api', 'web', 'app']);

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

// A home folder path names the person and the machine; config that needs one stays in a git-ignored file.
const HOME_PATH = /(?:\/Users|\/home)\/[A-Za-z0-9._-]+/;

export function findLeaks(text: string, denylist: string[]): Leak[] {
  const re = denylist.length ? new RegExp(`(?<![A-Za-z0-9])(${denylist.map(escape).join('|')})(?![A-Za-z0-9])`, 'i') : null;
  return text.split('\n').flatMap((line, i) => {
    const m = re?.exec(line) ?? HOME_PATH.exec(line);
    return m ? [{ term: m[1] ?? m[0], line: i + 1, text: line.trim().slice(0, 120) }] : [];
  });
}
