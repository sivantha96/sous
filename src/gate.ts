import type { Profile } from './config.ts';
import { get, type Gh } from './gh.ts';

/** What GitHub shows about CodeRabbit on one head commit. */
export interface CodeRabbitSignal {
  /** The "CodeRabbit" check run on the head commit, or null when it has none yet. */
  check: { status: 'queued' | 'in_progress' | 'completed'; conclusion: string | null } | null;
  /** CodeRabbit posted its "rate limited" comment. */
  rateLimited: boolean;
}

export type GateResult =
  | { action: 'review'; note?: string }
  | { action: 'wait'; recheckSeconds: number }
  | { action: 'defer'; reason: string };

export const POLL_SECONDS = 180;
/** How long one run keeps polling a PR before leaving it to the next run. */
export const MAX_WAIT_IN_RUN_SECONDS = 15 * 60;
/** How long after a push Sous waits for CodeRabbit to start at all. */
export const START_GRACE_SECONDS = 30 * 60;

export function gate(input: {
  enabled: boolean;
  signal: CodeRabbitSignal;
  pushedAt: Date;
  runStartedAt: Date;
  now: Date;
}): GateResult {
  if (!input.enabled) return { action: 'review' };
  const { check, rateLimited } = input.signal;
  const waitedInRun = (input.now.getTime() - input.runStartedAt.getTime()) / 1000;
  const wait = (reason: string): GateResult =>
    waitedInRun + POLL_SECONDS > MAX_WAIT_IN_RUN_SECONDS
      ? { action: 'defer', reason }
      : { action: 'wait', recheckSeconds: POLL_SECONDS };

  if (check && check.status !== 'completed') return wait('CodeRabbit is still reviewing');
  if (check) {
    if (check.conclusion === 'success') return { action: 'review' };
    // CodeRabbit completes as neutral when it is rate limited, paused or skips the PR.
    return { action: 'review', note: rateLimited ? 'CodeRabbit was rate limited on this commit' : `CodeRabbit finished as ${check.conclusion ?? 'unknown'} without a review` };
  }
  if (rateLimited) return { action: 'review', note: 'CodeRabbit was rate limited on this commit' };
  const sincePush = (input.now.getTime() - input.pushedAt.getTime()) / 1000;
  if (sincePush < START_GRACE_SECONDS) return wait('CodeRabbit has not started yet');
  return { action: 'review', note: 'CodeRabbit did not run on this commit' };
}

interface CheckRuns {
  check_runs: { name: string; status: 'queued' | 'in_progress' | 'completed'; conclusion: string | null; started_at: string }[];
}
interface IssueComment {
  user: { login: string } | null;
  body: string;
  created_at: string;
}

/** Reads CodeRabbit's check run and its rate-limit comment for one head commit. */
export async function readCodeRabbit(gh: Gh, profile: Profile, repo: string, n: number, head: string, pushedAt: Date): Promise<CodeRabbitSignal> {
  const cr = profile.coderabbit;
  if (!cr) return { check: null, rateLimited: false };
  const runs = await get<CheckRuns>(gh, `repos/${repo}/commits/${head}/check-runs?check_name=${encodeURIComponent(cr.checkName)}`);
  const latest = runs.check_runs.sort((a, b) => b.started_at.localeCompare(a.started_at))[0];
  const comments = await get<IssueComment[]>(gh, `repos/${repo}/issues/${n}/comments?per_page=100&since=${pushedAt.toISOString()}`);
  const rateLimited = comments.some((c) => c.user?.login === cr.login && /rate limited by coderabbit/i.test(c.body));
  return { check: latest ? { status: latest.status, conclusion: latest.conclusion } : null, rateLimited };
}
