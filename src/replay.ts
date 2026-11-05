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

/** Code names in a text: backticked spans, and identifiers with a capital, digit or underscore inside. */
export const codeNames = (text: string): Set<string> =>
  new Set([...text.matchAll(/`([^`\n]{3,60})`/g)].map((m) => m[1]!.toLowerCase()).concat([...text.matchAll(/\b([a-z]+[A-Z_][\w]{2,}|[A-Z][a-z]+[A-Z]\w+|[A-Z0-9]+_[A-Z0-9_]+)\b/g)].map((m) => m[1]!.toLowerCase())));

/**
 * The fallback when the judge didn't pair a point: same file, and within 3 lines, or within the
 * window when the finding and the point share a code name. Line distance alone matched different points.
 */
export function lineMatch(g: Gold, f: Pick<Finding, 'path' | 'line' | 'body'>, window = 10): boolean {
  if (!samePath(g.path, f.path)) return false;
  const d = Math.abs(g.line - f.line);
  if (d <= 3) return true;
  if (d > window) return false;
  const a = codeNames(g.text);
  return [...codeNames(f.body)].some((n) => a.has(n));
}

/** How many gold points any lens candidate came near: recall before the verifier. Compared with the final recall, it shows where points are lost. */
export function lensRecall(gold: Gold[], candidates: Pick<Finding, 'path' | 'line' | 'body'>[]): number {
  return gold.filter((g) => candidates.some((c) => lineMatch(g, c))).length;
}

/** The mean of several runs of the same cases: one run per case is too noisy to gate on. */
export function meanTotals(runs: Totals[]): Totals {
  const avg = (k: keyof Totals) => Math.round((runs.reduce((n, r) => n + r[k], 0) / runs.length) * 1000) / 1000;
  return { cases: runs[0]?.cases ?? 0, recall: avg('recall'), precision: avg('precision'), nitShare: avg('nitShare') };
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
      .filter((g) => !g.used && lineMatch(g, f, window))
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
