import type { Profile } from './config.ts';
import { gate, readCodeRabbit, type GateResult } from './gate.ts';
import { get, getAll, type Gh } from './gh.ts';
import { hasMarker } from './post.ts';
import { prKey, type OrgState } from './state.ts';

export type Reason = 'NEW' | 'PUSHED';

export interface DueItem {
  org: string;
  repo: string;
  number: number;
  title: string;
  head: string;
  base: string;
  reason: Reason;
  gate: GateResult;
}

// Lockfiles and generated output carry no reviewable intent.
const NOISE = [/(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|uv\.lock|poetry\.lock|Cargo\.lock|go\.sum|Podfile\.lock)$/, /\.snap$/, /(^|\/)(dist|generated|__generated__)\//];
export const isNoiseOnly = (files: string[]): boolean => files.length > 0 && files.every((f) => NOISE.some((re) => re.test(f)));

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

/** Pushes before new PRs: an author waiting on a re-review is blocked on you. */
export const byPriority = (a: DueItem, b: DueItem): number => (a.reason === b.reason ? 0 : a.reason === 'PUSHED' ? -1 : 1);

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

export async function findDue(gh: Gh, profile: Profile, state: OrgState, me: string, runStartedAt: Date): Promise<{ due: DueItem[]; skipped: { pr: string; why: string }[] }> {
  const queries = [`review-requested:${me}`, `reviewed-by:${me}`].map((q) => `is:pr is:open draft:false org:${profile.org} -author:${me} ${q}`);
  const found = new Map<string, SearchItem>();
  for (const q of queries) {
    for (const item of await getAll<SearchItem>(gh, `search/issues?per_page=100&q=${encodeURIComponent(q)}`)) {
      found.set(`${item.repository_url}#${item.number}`, item);
    }
  }

  const due: DueItem[] = [];
  const skipped: { pr: string; why: string }[] = [];
  await mapLimit([...found.values()], 6, async (item) => {
    const repo = item.repository_url.split('/repos/')[1]!;
    const pull = await get<Pull>(gh, `repos/${repo}/pulls/${item.number}`);
    const key = prKey(repo, item.number);
    if (pull.draft) return;
    if (pull.user.type === 'Bot') return void skipped.push({ pr: key, why: 'bot author' });
    const reason = classify(state, repo, item.number, pull.head.sha);
    if (!reason) return;
    const reviews = await getAll<Parameters<typeof yourLatestHead>[0][number]>(gh, `repos/${repo}/pulls/${item.number}/reviews?per_page=100`);
    if (yourLatestHead(reviews, me) === pull.head.sha) return;
    const files = (await getAll<{ filename: string }>(gh, `repos/${repo}/pulls/${item.number}/files?per_page=100`)).map((f) => f.filename);
    if (isNoiseOnly(files)) return void skipped.push({ pr: key, why: 'only lockfiles or generated files' });
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
    });
  });
  return { due: due.sort(byPriority), skipped };
}
