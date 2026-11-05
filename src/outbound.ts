import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { meDir, orgDir, readJson, sousHome } from './home.ts';

/**
 * The one check every text Sous sends to GitHub goes through: review comments, replies and
 * dismissal messages. A PR is text a stranger wrote, and posting is Sous's only way out, so
 * this refuses rather than filters:
 *
 * - another org's names (its org name, its parts, its denylist.json): one org's memory never
 *   reaches another org's PR;
 * - a canary that lives only in local memory files: if it shows up, memory is being copied out;
 * - links anywhere but this org on GitHub or a host the org profile lists, and any link with a
 *   query string, since a URL can carry data in its path or query.
 */
const CANARY_PREFIX = 'sous-canary-';
const CANARY_LINE = /<!-- sous-canary-[0-9a-f]{16} -->/;
const URL_RE = /\bhttps?:\/\/[^\s)<>\]"'`]+/g;

/** Names of every org except `org`, with their parts and denylists. */
export function otherOrgTerms(org: string, home = sousHome()): string[] {
  const dir = join(home, 'orgs');
  const terms = new Set<string>();
  for (const other of existsSync(dir) ? readdirSync(dir) : []) {
    if (other === org) continue;
    terms.add(other);
    for (const part of other.split('-')) terms.add(part);
    for (const t of readJson<string[]>(join(dir, other, 'denylist.json'), [])) terms.add(t);
  }
  const own = new Set([org, ...org.split('-'), ...readJson<string[]>(join(dir, org, 'denylist.json'), [])].map((t) => t.toLowerCase()));
  return [...terms].filter((t) => t.length >= 4 && !own.has(t.toLowerCase()));
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export interface OutboundRules {
  org: string;
  otherOrgTerms: string[];
  /** Hosts besides github.com/<org>/ that links may point to, from the org profile. */
  linkHosts: string[];
}

export function checkOutbound(text: string, rules: OutboundRules): string[] {
  const problems: string[] = [];
  if (text.includes(CANARY_PREFIX)) problems.push('contains the memory canary: local memory is being copied into a comment');
  if (rules.otherOrgTerms.length) {
    const m = new RegExp(`(?<![A-Za-z0-9])(${rules.otherOrgTerms.map(escape).join('|')})(?![A-Za-z0-9])`, 'i').exec(text);
    if (m) problems.push(`names "${m[1]}", which belongs to another org`);
  }
  for (const raw of text.match(URL_RE) ?? []) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      problems.push(`unreadable link ${raw.slice(0, 80)}`);
      continue;
    }
    const ownGithub = url.hostname === 'github.com' && url.pathname.toLowerCase().startsWith(`/${rules.org.toLowerCase()}/`);
    if (url.protocol !== 'https:' || !(ownGithub || rules.linkHosts.includes(url.hostname))) problems.push(`links to ${url.protocol}//${url.hostname}, which is not this org on GitHub or a listed host`);
    else if (url.search || url.username || url.password) problems.push(`link ${url.hostname}${url.pathname.slice(0, 40)} carries a query string or credentials`);
  }
  return problems;
}

/** Every markdown file under one memory folder. */
function markdownFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'replay' || name === 'drafts' ? [] : markdownFiles(path);
    return name.endsWith('.md') ? [path] : [];
  });
}

/**
 * Puts one canary line at the top of every memory file that lacks it. An HTML comment is not
 * a bullet, so memory search never returns it; a model that copies a whole file copies it too.
 */
export function ensureCanaries(): number {
  const orgs = join(sousHome(), 'orgs');
  const dirs = [meDir(), ...(existsSync(orgs) ? readdirSync(orgs).map((o) => orgDir(o)) : [])];
  let added = 0;
  for (const file of dirs.flatMap(markdownFiles)) {
    const text = readFileSync(file, 'utf8');
    if (CANARY_LINE.test(text)) continue;
    writeFileSync(file, `<!-- ${CANARY_PREFIX}${randomBytes(8).toString('hex')} -->\n${text}`);
    added++;
  }
  return added;
}
