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
    cost: usage.length
      ? { paidTokens: usage.reduce((s, u) => s + paid(u.totals), 0), cacheReadTokens: usage.reduce((s, u) => s + cacheRead(u.totals), 0), seconds: usage.reduce((s, u) => s + (u.seconds?.main ?? 0), 0), byAgent }
      : null,
    recent: { runs: past.length, medianPaidTokens: median(past.map((u) => paid(u.totals))), medianSeconds: median(past.map((u) => u.seconds?.main ?? 0).filter(Boolean)) },
  };
}
