import type { Finding } from './voice-lint.ts';

/** One point you made on a PR: the answer a replay is scored against. */
export interface Gold {
  path: string;
  line: number;
  text: string;
  source: 'inline' | 'ai-review';
}

/** A past PR at the commit you reviewed, with what you said about it. */
export interface Case {
  id: string;
  org: string;
  repo: string;
  number: number;
  head: string;
  base: string;
  /** Your account: its comments are the answers, so the replay must never read them. */
  me: string;
  /** The replay may only see comments made before this time. */
  before: string;
  gold: Gold[];
}

const ITEM = /^\s*[-*]\s+\[[ xX]\]\s+(.*?)`([^`\s]+?):(\d+)(?:-\d+)?`(.*)$/;

/** The `path:line` checklist items of an "AI review" comment. */
export function parseAiReview(body: string): Omit<Gold, 'source'>[] {
  if (!/AI review/i.test(body)) return [];
  return body.split('\n').flatMap((row) => {
    const m = ITEM.exec(row);
    return m ? [{ path: m[2]!, line: Number(m[3]), text: `${m[1]}${m[4]}`.replace(/^[:\s*]+/, '').trim() }] : [];
  });
}

/** The newest commit made at or before `at`: the head an issue comment was written against. */
export function commitAt(commits: { sha: string; date: string }[], at: string): string | null {
  const before = commits.filter((c) => c.date <= at).sort((a, b) => b.date.localeCompare(a.date));
  return before[0]?.sha ?? null;
}

export interface CaseScore {
  id: string;
  gold: number;
  found: number;
  matched: number;
  nits: number;
}

/** Same file, allowing one side to be written without its folders (`a.md` and `docs/x/a.md`). */
export const samePath = (a: string, b: string): boolean => a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);

/**
 * Each gold point matches at most one finding. First the judge's pairs (gold index, finding index):
 * the same point made anywhere. Then a finding on the same file within `window` lines.
 */
export function scoreCase(id: string, gold: Gold[], findings: Finding[], window = 10, judged: [number, number][] = []): CaseScore {
  const free = gold.map((g) => ({ ...g, used: false }));
  const usedFindings = new Set<number>();
  let matched = 0;
  for (const [gi, fi] of judged) {
    const g = free[gi];
    if (!g || g.used || fi < 0 || fi >= findings.length || usedFindings.has(fi)) continue;
    g.used = true;
    usedFindings.add(fi);
    matched++;
  }
  for (const [fi, f] of findings.entries()) {
    if (usedFindings.has(fi)) continue;
    const hit = free
      .filter((g) => !g.used && samePath(g.path, f.path) && Math.abs(g.line - f.line) <= window)
      .sort((a, b) => Math.abs(a.line - f.line) - Math.abs(b.line - f.line))[0];
    if (hit) {
      hit.used = true;
      matched++;
    }
  }
  return { id, gold: gold.length, found: findings.length, matched, nits: findings.filter((f) => f.severity === 'nit').length };
}

export interface Totals {
  cases: number;
  recall: number;
  precision: number;
  nitShare: number;
}

export function totals(scores: CaseScore[]): Totals {
  const sum = (k: keyof Omit<CaseScore, 'id'>) => scores.reduce((n, s) => n + s[k], 0);
  const ratio = (a: number, b: number) => (b === 0 ? 0 : Math.round((a / b) * 1000) / 1000);
  return { cases: scores.length, recall: ratio(sum('matched'), sum('gold')), precision: ratio(sum('matched'), sum('found')), nitShare: ratio(sum('nits'), sum('found')) };
}

/** How far a score may fall below the accepted baseline before a change is blocked. */
export const TOLERANCE = 0.05;

export function gateFails(now: Totals, baseline: Totals | null): string[] {
  if (!baseline) return [];
  const fails: string[] = [];
  if (now.recall < baseline.recall - TOLERANCE) fails.push(`recall ${now.recall} < baseline ${baseline.recall}`);
  if (now.precision < baseline.precision - TOLERANCE) fails.push(`precision ${now.precision} < baseline ${baseline.precision}`);
  return fails;
}
