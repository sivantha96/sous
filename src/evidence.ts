import type { Finding, Quote, Side } from './voice-lint.ts';

/** A model copies a quote exactly but often miscounts its line by a few. */
export const QUOTE_SLACK = 3;

/** Line numbers a review comment may anchor to on each side: lines a hunk keeps or adds (RIGHT), keeps or removes (LEFT). */
export function diffLines(patch: string | undefined): { RIGHT: Set<number>; LEFT: Set<number> } {
  const out = { RIGHT: new Set<number>(), LEFT: new Set<number>() };
  let left = 0;
  let right = 0;
  for (const row of (patch ?? '').split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row);
    if (hunk) {
      left = Number(hunk[1]);
      right = Number(hunk[2]);
      continue;
    }
    if (right === 0 || row.startsWith('\\')) continue;
    if (row.startsWith('-')) out.LEFT.add(left++);
    else if (row.startsWith('+')) out.RIGHT.add(right++);
    else {
      out.LEFT.add(left++);
      out.RIGHT.add(right++);
    }
  }
  return out;
}

/** Where `quote` sits: the given line if it holds it, else the one line within the slack that does. A tie, or none, fails. */
export function locate(lines: string[], line: number, quote: string): number | null {
  const q = quote.trim();
  if (!q) return null;
  if (lines[line - 1]?.includes(q)) return line;
  const near: number[] = [];
  for (let l = Math.max(1, line - QUOTE_SLACK); l <= Math.min(lines.length, line + QUOTE_SLACK); l++) if (l !== line && lines[l - 1]?.includes(q)) near.push(l);
  return near.length === 1 ? near[0]! : null;
}

/** A path written without its folders is completed only when exactly one file in the tree ends with it. */
export function completePath(path: string, tree: string[]): string | null {
  if (tree.includes(path)) return path;
  const hits = tree.filter((t) => t.endsWith(`/${path}`));
  return hits.length === 1 ? hits[0]! : null;
}

export interface EvidenceContext {
  files: { filename: string; patch?: string }[];
  /** Every path at the head. */
  tree: string[];
  /** File lines at the head (RIGHT) or at the base (LEFT); null when the file isn't there. */
  read: (side: Side, path: string) => string[] | null;
}

/**
 * Checks every finding mechanically before anything is posted: its path, its anchor quote,
 * its evidence and its counter-evidence must all be exact text at the cited lines (moved within
 * ±3 lines when the count is off), and its anchor must be a line of the diff on its side.
 * Returns corrected findings and, per finding index, what still fails.
 */
export function verifyEvidence(findings: Finding[], ctx: EvidenceContext): { findings: Finding[]; problems: { index: number; problem: string }[] } {
  const anchors = new Map(ctx.files.map((f) => [f.filename, diffLines(f.patch)]));
  const problems: { index: number; problem: string }[] = [];
  const fixQuote = (q: Quote, index: number, what: string): Quote => {
    const side = q.side ?? 'RIGHT';
    const path = completePath(q.path, ctx.tree) ?? q.path;
    const lines = ctx.read(side, path);
    if (!lines) {
      problems.push({ index, problem: `${what} ${q.path}: file not found at ${side === 'LEFT' ? 'the base' : 'the head'}` });
      return q;
    }
    const at = locate(lines, q.line, q.quote);
    if (at === null) {
      problems.push({ index, problem: `${what} ${path}:${q.line}: quote not found within ${QUOTE_SLACK} lines (or found twice)` });
      return { ...q, path };
    }
    return { ...q, path, line: at };
  };
  const out = findings.map((f, index) => {
    const side = f.side ?? 'RIGHT';
    let { path, line } = f;
    path = completePath(path, ctx.tree) ?? path;
    if (f.quote) {
      const fixed = fixQuote({ path, line, quote: f.quote, side }, index, 'anchor');
      ({ path, line } = fixed);
    } else problems.push({ index, problem: `${f.path}:${f.line}: no anchor quote` });
    if (!anchors.get(path)?.[side].has(line)) problems.push({ index, problem: `${path}:${line}: not a ${side === 'LEFT' ? 'removed or kept' : 'added or kept'} line of the diff; GitHub would reject the whole review` });
    const evidence = (f.evidence ?? []).map((q) => fixQuote(q, index, 'evidence'));
    if (!f.counterEvidence?.length) problems.push({ index, problem: `${path}:${line}: no counter-evidence (the guard, caller or test checked while trying to refute it)` });
    const counterEvidence = (f.counterEvidence ?? []).map((q) => fixQuote(q, index, 'counter-evidence'));
    return { ...f, path, line, evidence, counterEvidence };
  });
  return { findings: out, problems };
}

/** The only fields a repair may change. Anything else in a correction is ignored. */
export interface Correction {
  index: number;
  target: 'anchor' | 'evidence' | 'counterEvidence';
  item?: number;
  field: 'line' | 'side' | 'path' | 'quote';
  value: string | number;
}

export function applyCorrections(findings: Finding[], corrections: Correction[]): Finding[] {
  const out = findings.map((f) => ({ ...f, evidence: [...(f.evidence ?? [])], counterEvidence: [...(f.counterEvidence ?? [])] }));
  for (const c of corrections) {
    const f = out[c.index];
    // A correction that matches nothing would be dropped silently and use up the one repair.
    if (!f) throw new Error(`correction for finding #${c.index}: no such finding`);
    if (!['line', 'side', 'path', 'quote'].includes(c.field)) continue;
    const value = c.field === 'line' ? Number(c.value) : c.field === 'side' ? (c.value === 'LEFT' ? 'LEFT' : 'RIGHT') : String(c.value);
    if (c.target === 'anchor') Object.assign(f, { [c.field]: value });
    else {
      const q = f[c.target]?.[c.item ?? -1];
      if (!q) throw new Error(`correction for finding #${c.index}: no ${c.target} item ${c.item ?? '(none given)'}; a repair fixes an existing quote and can't add one`);
      Object.assign(q, { [c.field]: value });
    }
  }
  return out;
}

const words = (s: string): Set<string> => new Set(s.toLowerCase().replace(/<!--[\s\S]*?-->|`[^`]*`/g, ' ').split(/[^a-z0-9]+/).filter((w) => w.length > 2));
const firstSentence = (s: string): string => s.split(/\n|(?<=\.)\s/)[0] ?? s;

/** Same point already posted by Sous: same file, within 3 lines, and mostly the same words in the first sentence. */
export function isDuplicate(f: Pick<Finding, 'path' | 'line' | 'body'>, existing: { path: string; line: number | null; body: string }): boolean {
  if (existing.path !== f.path || existing.line === null || Math.abs(existing.line - f.line) > QUOTE_SLACK) return false;
  const a = words(firstSentence(f.body));
  const b = words(firstSentence(existing.body));
  if (a.size === 0 || b.size === 0) return false;
  const shared = [...a].filter((w) => b.has(w)).length;
  return shared / Math.min(a.size, b.size) >= 0.6;
}

/** Every lens candidate id has exactly one verifier decision: kept, merged into a kept one, or dropped. */
export function missingDecisions(candidateIds: string[], verified: { kept?: { id?: string; merged?: string[] }[]; dropped?: { id?: string }[] }): string[] {
  const decided = new Map<string, number>();
  const count = (id: string | undefined) => id && decided.set(id, (decided.get(id) ?? 0) + 1);
  for (const k of verified.kept ?? []) {
    count(k.id);
    for (const m of k.merged ?? []) count(m);
  }
  for (const d of verified.dropped ?? []) count(d.id);
  return candidateIds.filter((id) => decided.get(id) !== 1);
}
