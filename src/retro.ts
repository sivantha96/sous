import type { LoggedEvent } from './state.ts';
import type { Usage } from './usage.ts';

/**
 * The last run, for the learning round: what went wrong, what it cost and how long it took, next
 * to the median of the runs before it. A run is every event from its start time on; its cost is the
 * `usage` event `/run` logs with the label `run`, or `/review` with `review`.
 */
const PROBLEMS = new Set(['lint-refused', 'outbound-refused', 'blocked', 'skipped', 'deferred', 'dropped', 'rebase-skip', 'request-not-restored']);

/** Tokens a run pays for in full: cache reads cost a tenth and are reported apart. */
const paid = (totals: Record<string, Usage> = {}): number => Object.values(totals).reduce((s, u) => s + u.input + u.output + u.cacheWrite, 0);
const cacheRead = (totals: Record<string, Usage> = {}): number => Object.values(totals).reduce((s, u) => s + u.cacheRead, 0);

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

interface RunUsage {
  totals?: Record<string, Usage>;
  byAgent?: Record<string, Record<string, Usage>>;
  seconds?: Record<string, number>;
}

export function retro(events: LoggedEvent[], since: string, history = 10) {
  const run = events.filter((e) => e.at >= since);
  // A hand review (`/review`) logs `review`; both are runs here, so its cost is reviewed too.
  const isRunUsage = (e: LoggedEvent) => e.type === 'usage' && (e.label === 'run' || e.label === 'review');
  const usage = run.filter(isRunUsage) as (LoggedEvent & RunUsage)[];
  const past = (events.filter((e) => isRunUsage(e) && e.at < since) as (LoggedEvent & RunUsage)[]).slice(-history);
  const byAgent: Record<string, { paidTokens: number; seconds: number }> = {};
  for (const u of usage) {
    for (const [agent, totals] of Object.entries(u.byAgent ?? {})) (byAgent[agent] ??= { paidTokens: 0, seconds: 0 }).paidTokens += paid(totals);
    for (const [agent, s] of Object.entries(u.seconds ?? {})) (byAgent[agent] ??= { paidTokens: 0, seconds: 0 }).seconds += s;
  }
  return {
    since,
    // An adopted review is one whose post response was lost: it is on the PR all the same.
    reviews: run
      .filter((e) => e.type === 'reviewed' || e.type === 'adopted')
      .map((e) => (e.type === 'adopted' ? { pr: e.pr, event: 'ADOPTED', findings: typeof e.comments === 'number' ? e.comments : 0 } : { pr: e.pr, event: e.event, findings: Array.isArray(e.findings) ? e.findings.length : 0 })),
    problems: run.filter((e) => PROBLEMS.has(e.type)),
    // What the review-judge scored 2 or lower this run: the reflector looks for the cause.
    lowScores: run.filter((e) => e.type === 'scored' && Object.values((e.scores ?? {}) as Record<string, number>).some((v) => v <= LOW)),
    cost: usage.length
      ? { paidTokens: usage.reduce((s, u) => s + paid(u.totals), 0), cacheReadTokens: usage.reduce((s, u) => s + cacheRead(u.totals), 0), seconds: usage.reduce((s, u) => s + (u.seconds?.main ?? 0), 0), byAgent }
      : null,
    recent: { runs: past.length, medianPaidTokens: median(past.map((u) => paid(u.totals))), medianSeconds: median(past.map((u) => u.seconds?.main ?? 0).filter(Boolean)) },
  };
}

/**
 * The run's last message: one row per PR this run touched, with its link and what Sous posted on it.
 * `pr` is `owner/repo#n`, as every event logs it.
 */
export function runSummary(events: LoggedEvent[], since: string): string {
  const rows = new Map<string, { comments: number; replies: number; resolved: number; notes: string[] }>();
  for (const e of events) {
    if (e.at < since || typeof e.pr !== 'string') continue;
    const counted = e.type === 'reviewed' || e.type === 'adopted' || e.type === 'replied' || e.type === 'resolved' || PROBLEMS.has(e.type);
    if (!counted) continue;
    const r = rows.get(e.pr) ?? { comments: 0, replies: 0, resolved: 0, notes: [] };
    rows.set(e.pr, r);
    if (e.type === 'reviewed') r.comments += Array.isArray(e.findings) ? e.findings.length : 0;
    else if (e.type === 'adopted') r.comments += typeof e.comments === 'number' ? e.comments : 0;
    else if (e.type === 'replied') r.replies++;
    else if (e.type === 'resolved') r.resolved++;
    else if (!r.notes.includes(e.type)) r.notes.push(e.type);
  }
  if (!rows.size) return 'No PRs reviewed and nothing posted.';
  const link = (pr: string) => {
    const [repo, n] = pr.split('#');
    return `[${pr}](https://github.com/${repo}/pull/${n})`;
  };
  return [
    '| PR | Comments | Replies | Resolved | Note |',
    '|---|---|---|---|---|',
    ...[...rows].map(([pr, r]) => `| ${link(pr)} | ${r.comments} | ${r.replies} | ${r.resolved} | ${r.notes.join(', ')} |`),
  ].join('\n');
}

/** What the review-judge scores each posted review on, 1 (bad) to 5 (good). */
export const QUALITY = ['grounded', 'clear', 'actionable', 'worthIt'] as const;
const LOW = 2;

export interface ScoredReview {
  pr: string;
  scores: Record<(typeof QUALITY)[number], number>;
  low: { id: string; why: string }[];
}

/** Checks the judge's file before it reaches the event log: every review, every metric, 1 to 5, and a reason for each low score. */
export function checkScores(v: unknown): ScoredReview[] {
  const reviews = (v as { reviews?: unknown })?.reviews;
  if (!Array.isArray(reviews)) throw new Error('scores file needs a "reviews" list');
  return reviews.map((r: Partial<ScoredReview>, i) => {
    if (typeof r.pr !== 'string' || !/^[\w.-]+\/[\w.-]+#\d+$/.test(r.pr)) throw new Error(`review ${i}: "pr" must look like owner/repo#12`);
    for (const k of QUALITY) {
      const n = r.scores?.[k];
      if (!Number.isInteger(n) || n! < 1 || n! > 5) throw new Error(`${r.pr}: score "${k}" must be a whole number from 1 to 5`);
    }
    const low = Array.isArray(r.low) ? r.low : [];
    if (QUALITY.some((k) => r.scores![k] <= LOW) && !low.some((l) => typeof l?.why === 'string' && l.why.trim())) throw new Error(`${r.pr}: a score of ${LOW} or lower needs a "low" entry saying why`);
    return { pr: r.pr, scores: r.scores!, low };
  });
}

const hours = (from: string, to: string): number => Math.round(((Date.parse(to) - Date.parse(from)) / 3_600_000) * 10) / 10;

/**
 * How fast PRs move with Sous in the loop, in hours: from opening to Sous's first review, and from
 * that review to the merge. `prs` has GitHub's times for each PR Sous reviewed.
 */
export function cycleTimes(events: LoggedEvent[], prs: Record<string, { createdAt: string; mergedAt: string | null }>) {
  const first = new Map<string, string>();
  for (const e of events) if (e.type === 'reviewed' && typeof e.pr === 'string' && !first.has(e.pr)) first.set(e.pr, e.at);
  const toReview: number[] = [];
  const toMerge: number[] = [];
  for (const [pr, at] of first) {
    const p = prs[pr];
    if (!p) continue;
    toReview.push(hours(p.createdAt, at));
    if (p.mergedAt) toMerge.push(hours(at, p.mergedAt));
  }
  return { prs: toReview.length, merged: toMerge.length, medianHoursToFirstReview: median(toReview), medianHoursFromReviewToMerge: median(toMerge) };
}

/** The average of each quality score the review-judge gave, over the scored events given. */
export function qualityAverages(events: LoggedEvent[]) {
  const scored = events.filter((e) => e.type === 'scored');
  if (!scored.length) return null;
  const avg = (k: string) => Math.round((scored.reduce((s, e) => s + Number((e.scores as Record<string, number>)[k] ?? 0), 0) / scored.length) * 10) / 10;
  return { reviews: scored.length, ...Object.fromEntries(QUALITY.map((k) => [k, avg(k)])) };
}
