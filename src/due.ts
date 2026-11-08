import type { Profile } from './config.ts';
import { gate, readCodeRabbit, type GateResult } from './gate.ts';
import { get, getAll, type Gh } from './gh.ts';
import { hasMarker } from './post.ts';
import { prKey, type OrgState } from './state.ts';
import { threadSignals, type PrComment, type ThreadSignal } from './threads.ts';

/** REPLY: teammates replied or reacted on Sous's comments, with no new push to review. REREQUESTED: the author asked for your review again after Sous's last review, with no new push. */
export type Reason = 'NEW' | 'PUSHED' | 'REPLY' | 'REREQUESTED';

export interface DueItem {
  org: string;
  repo: string;
  number: number;
  title: string;
  head: string;
  base: string;
  reason: Reason;
  gate: GateResult;
  /** Replies and reactions on Sous's threads, for the reply judge. Empty when there are none. */
  threads: ThreadSignal[];
  /** `incremental`: the previous head is an ancestor and the merge base is unchanged, so only commits after `since` are new. */
  scope: 'full' | 'incremental';
  since?: string;
}

/**
 * A content id for a PR's change, independent of commits and line numbers: the same patch rebased
 * onto a new base gets the same id. Lines that only moved keep the id too.
 */
export function patchId(files: { filename: string; patch?: string }[]): string {
  const h = createHash('sha256');
  for (const f of [...files].sort((a, b) => a.filename.localeCompare(b.filename))) {
    h.update(`${f.filename}\n`);
    for (const row of (f.patch ?? '').split('\n')) if (/^[+-]/.test(row) && !/^(\+\+\+|---)/.test(row)) h.update(`${row.trimEnd()}\n`);
  }
  return h.digest('hex').slice(0, 16);
}

/** How a push relates to what Sous reviewed: review only the delta, skip it, or review in full. */
export function pushScope(seen: { head: string; mergeBase?: string; patchId?: string }, now: { compareStatus: string; mergeBase: string; patchId: string }): 'incremental' | 'skip' | 'full' {
  if (seen.patchId && seen.patchId === now.patchId) return 'skip';
  if (now.compareStatus === 'ahead' && seen.mergeBase && seen.mergeBase === now.mergeBase) return 'incremental';
  return 'full';
}

import { createHash } from 'node:crypto';
import { isNoiseOnly } from './noise.ts';
export { isNoiseOnly };

export function classify(state: OrgState, repo: string, n: number, head: string): Reason | null {
  const seen = state.prs[prKey(repo, n)];
  if (!seen) return 'NEW';
  return seen.head === head ? null : 'PUSHED';
}

/** Your own latest review, ignoring reviews Sous posted. A head you reviewed yourself is not due. */
export function yourLatestHead(reviews: { user: { login: string } | null; commit_id: string; body: string | null; submitted_at?: string }[], me: string): string | null {
  const yours = reviews.filter((r) => r.user?.login === me && !hasMarker(r.body) && r.submitted_at);
  return yours.sort((a, b) => b.submitted_at!.localeCompare(a.submitted_at!))[0]?.commit_id ?? null;
}

interface TimelineEvent {
  event: string;
  created_at?: string;
  actor?: { login: string } | null;
  requested_reviewer?: { login: string } | null;
}

/**
 * Whether someone other than you asked for your review after `since`. Sous gives back your review
 * request itself after posting (as you), so only a request by someone else counts.
 */
export function rerequestedAfter(events: TimelineEvent[], me: string, since: string): boolean {
  return events.some((e) => e.event === 'review_requested' && e.requested_reviewer?.login === me && e.actor?.login !== me && (e.created_at ?? '') > since);
}

/** Runs fn over items, at most `limit` at a time, keeping order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const RANK: Record<Reason, number> = { REPLY: 0, REREQUESTED: 1, PUSHED: 1, NEW: 2 };
/** Replies first (a push that answers Sous's threads too), then pushes, then new PRs: a waiting author is blocked on you. */
const rank = (d: DueItem): number => (d.threads?.length ? 0 : RANK[d.reason]);
export const byPriority = (a: DueItem, b: DueItem): number => rank(a) - rank(b);

interface SearchItem {
  number: number;
  repository_url: string;
}
interface Pull {
  number: number;
  title: string;
  draft: boolean;
  user: { login: string; type: string };
  head: { sha: string };
  base: { ref: string };
}

export async function findDue(gh: Gh, profile: Profile, state: OrgState, me: string, runStartedAt: Date): Promise<{ due: DueItem[]; skipped: { pr: string; why: string }[]; rebased: { pr: string; head: string }[] }> {
  // Teammates' PRs that asked for you or that you reviewed, and your own PRs: Sous reviews those too.
  const queries = [`-author:${me} review-requested:${me}`, `-author:${me} reviewed-by:${me}`, `author:${me}`].map((q) => `is:pr is:open draft:false org:${profile.org} ${q}`);
  const found = new Map<string, SearchItem>();
  const requested = new Set<string>();
  for (const [i, q] of queries.entries()) {
    for (const item of await getAll<SearchItem>(gh, `search/issues?per_page=100&q=${encodeURIComponent(q)}`)) {
      found.set(`${item.repository_url}#${item.number}`, item);
      if (i === 0) requested.add(`${item.repository_url}#${item.number}`);
    }
  }

  const due: DueItem[] = [];
  const skipped: { pr: string; why: string }[] = [];
  const rebased: { pr: string; head: string }[] = [];
  // One PR's failure is logged as skipped; it never stops the other PRs or the org.
  await mapLimit([...found.values()], 6, async (item) => {
    const repo = item.repository_url.split('/repos/')[1]!;
    try {
      await one(item, repo);
    } catch (e) {
      skipped.push({ pr: prKey(repo, item.number), why: `error: ${(e as Error).message.slice(0, 200)}` });
    }
  });
  return { due: due.sort(byPriority), skipped, rebased };

  async function one(item: SearchItem, repo: string): Promise<void> {
    const pull = await get<Pull>(gh, `repos/${repo}/pulls/${item.number}`);
    const key = prKey(repo, item.number);
    if (pull.draft) return;
    if (pull.user.type === 'Bot') return void skipped.push({ pr: key, why: 'bot author' });
    const seen = state.prs[key];
    const threads = seen?.commentIds.length ? threadSignals(await getAll<PrComment>(gh, `repos/${repo}/pulls/${item.number}/comments?per_page=100`), seen, me, pull.user.login === me) : [];
    const pushed = classify(state, repo, item.number, pull.head.sha);
    if (!pushed && seen?.reviewedAt && requested.has(`${item.repository_url}#${item.number}`)) {
      const events = await getAll<TimelineEvent>(gh, `repos/${repo}/issues/${item.number}/timeline?per_page=100`);
      if (rerequestedAfter(events, me, seen.reviewedAt)) {
        due.push({ org: profile.org, repo, number: item.number, title: pull.title, head: pull.head.sha, base: pull.base.ref, reason: 'REREQUESTED', gate: { action: 'review' }, threads, scope: 'full' });
        return;
      }
    }
    if (!pushed && threads.length === 0) return;
    if (!pushed) {
      due.push({ org: profile.org, repo, number: item.number, title: pull.title, head: pull.head.sha, base: pull.base.ref, reason: 'REPLY', gate: { action: 'review' }, threads, scope: 'full' });
      return;
    }
    const reason = pushed;
    const reviews = await getAll<Parameters<typeof yourLatestHead>[0][number]>(gh, `repos/${repo}/pulls/${item.number}/reviews?per_page=100`);
    if (yourLatestHead(reviews, me) === pull.head.sha) return;
    const fileList = await getAll<{ filename: string; patch?: string }>(gh, `repos/${repo}/pulls/${item.number}/files?per_page=100`);
    const files = fileList.map((f) => f.filename);
    if (isNoiseOnly(files)) return void skipped.push({ pr: key, why: 'only lockfiles or generated files' });
    let scope: DueItem['scope'] = 'full';
    if (reason === 'PUSHED' && seen) {
      const [delta, base] = await Promise.all([
        get<{ status: string }>(gh, `repos/${repo}/compare/${seen.head}...${pull.head.sha}`).catch(() => ({ status: 'unknown' })),
        get<{ merge_base_commit: { sha: string } }>(gh, `repos/${repo}/compare/${encodeURIComponent(pull.base.ref)}...${pull.head.sha}`).catch(() => null),
      ]);
      const s = pushScope(seen, { compareStatus: delta.status, mergeBase: base?.merge_base_commit.sha ?? '', patchId: patchId(fileList) });
      if (s === 'skip') return void rebased.push({ pr: key, head: pull.head.sha });
      scope = s;
    }
    const commit = await get<{ commit: { committer: { date: string } } }>(gh, `repos/${repo}/commits/${pull.head.sha}`);
    const pushedAt = new Date(commit.commit.committer.date);
    const signal = await readCodeRabbit(gh, profile, repo, item.number, pull.head.sha, pushedAt);
    due.push({
      org: profile.org,
      repo,
      number: item.number,
      title: pull.title,
      head: pull.head.sha,
      base: pull.base.ref,
      reason,
      gate: gate({ enabled: profile.coderabbit !== null, signal, pushedAt, runStartedAt, now: new Date() }),
      threads,
      scope,
      ...(scope === 'incremental' && seen ? { since: seen.head } : {}),
    });
  }
}
