import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { appendLine, orgDir, readJson, writeJson } from './home.ts';

export interface PrState {
  /** Head commit Sous last reviewed. */
  head: string;
  reviewedAt: string;
  /** Ids of reviews Sous posted, so it only ever dismisses its own. */
  reviewIds: number[];
  /** Ids of inline comments Sous posted, so it can tell its comments from yours. */
  commentIds: number[];
  /** Ids of replies Sous posted in its own threads. */
  replyIds: number[];
  /** Teammate replies already judged, so each is handled once. */
  handled: number[];
  /** Reaction count last seen on each Sous comment, by comment id. */
  reactions: Record<string, number>;
  /** The merge base and patch id when Sous last reviewed: a push that keeps both can be reviewed as a delta, a rebase that keeps the patch id needs no review. */
  mergeBase?: string;
  patchId?: string;
}

export const emptyPr = (head: string): PrState => ({ head, reviewedAt: '', reviewIds: [], commentIds: [], replyIds: [], handled: [], reactions: {} });

export interface OrgState {
  prs: Record<string, PrState>;
}

export const prKey = (repo: string, n: number): string => `${repo}#${n}`;

const statePath = (org: string): string => join(orgDir(org), 'state.json');

function readState(org: string): OrgState {
  const s = readJson<{ prs?: Record<string, Partial<PrState>> }>(statePath(org), {});
  // Fill fields added after a PR was first recorded.
  const prs = Object.fromEntries(Object.entries(s.prs ?? {}).map(([k, v]) => [k, { ...emptyPr(v.head ?? ''), ...v } as PrState]));
  return { prs };
}

/** Each PR as it was when this copy of the state was loaded, so a save writes back only what this process changed. */
const loaded = new WeakMap<OrgState, Record<string, string>>();

export function loadState(org: string): OrgState {
  const s = readState(org);
  loaded.set(s, Object.fromEntries(Object.entries(s.prs).map(([k, v]) => [k, JSON.stringify(v)])));
  return s;
}

const union = (a: number[], b: number[]): number[] => [...new Set([...a, ...b])];

/** Two processes' versions of one PR: ids from both, fields and reaction counts from the one saving now. */
export function mergePr(onDisk: PrState | undefined, mine: PrState): PrState {
  if (!onDisk) return mine;
  return {
    ...onDisk,
    ...mine,
    reviewIds: union(onDisk.reviewIds, mine.reviewIds),
    commentIds: union(onDisk.commentIds, mine.commentIds),
    replyIds: union(onDisk.replyIds, mine.replyIds),
    handled: union(onDisk.handled, mine.handled),
    reactions: { ...onDisk.reactions, ...mine.reactions },
  };
}

/**
 * Runs and subagents save state in parallel, each from a copy it loaded minutes earlier. Saving
 * that whole copy wiped what others had saved since (a reply marked handled came back as new and
 * was answered again every hour). So a save takes a lock, re-reads the file, and writes back only
 * the PRs this copy changed, merged into what is on disk.
 */
export function saveState(org: string, s: OrgState): void {
  const before = loaded.get(s) ?? {};
  withStateLock(org, () => {
    const fresh = readState(org);
    for (const [k, v] of Object.entries(s.prs)) if (JSON.stringify(v) !== before[k]) fresh.prs[k] = mergePr(fresh.prs[k], v);
    writeJson(statePath(org), fresh);
    loaded.set(s, Object.fromEntries(Object.entries(s.prs).map(([k, v]) => [k, JSON.stringify(v)])));
  });
}

/** A lock folder next to the state file; one left by a crashed process for over 30 seconds is taken over. */
function withStateLock(org: string, fn: () => void): void {
  const lock = `${statePath(org)}.lock`;
  mkdirSync(orgDir(org), { recursive: true });
  const wait = new Int32Array(new SharedArrayBuffer(4));
  // About 10 seconds of 50 ms waits; a lock older than 30 seconds belongs to a process that died.
  for (let i = 0; ; i++) {
    try {
      mkdirSync(lock);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const age = Date.now() - (statSync(lock, { throwIfNoEntry: false })?.mtimeMs ?? Date.now());
      if (age > 30_000 || i >= 200) rmSync(lock, { recursive: true, force: true });
      else Atomics.wait(wait, 0, 0, 50);
    }
  }
  try {
    fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

export type EventType = 'reviewed' | 'deferred' | 'dismissed' | 'skipped' | 'lint-refused' | 'replied' | 'resolved' | 'seen' | 'adopted' | 'dropped' | 'request-not-restored' | 'rebase-skip' | 'usage' | 'eval-started' | 'outbound-refused' | 'blocked' | 'scored';

/** One append-only log every metric reads from. */
export function logEvent(org: string, type: EventType, data: Record<string, unknown>): void {
  appendLine(join(orgDir(org), 'events.jsonl'), { at: new Date().toISOString(), type, ...data });
}

export interface LoggedEvent {
  at: string;
  type: EventType;
  [key: string]: unknown;
}

export function readEvents(org: string): LoggedEvent[] {
  const log = join(orgDir(org), 'events.jsonl');
  return existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as LoggedEvent) : [];
}

/**
 * One run per org at a time: each org runs on its own schedule, and a slow run must not overlap the
 * next one and review the same PRs twice. The lock names the Claude Code session holding it; a run
 * that dies leaves it behind, so it expires after LOCK_MINUTES.
 */
export const LOCK_MINUTES = 90;
const lockPath = (org: string): string => join(orgDir(org), 'run.lock');

export function takeLock(org: string, session: string, now = new Date()): { ok: true } | { ok: false; heldBy: string; since: string } {
  const held = readJson<{ session?: string; at?: string } | null>(lockPath(org), null);
  if (held?.session && held.session !== session && held.at && now.getTime() - Date.parse(held.at) < LOCK_MINUTES * 60_000) return { ok: false, heldBy: held.session, since: held.at };
  writeJson(lockPath(org), { session, at: now.toISOString() });
  return { ok: true };
}

export function releaseLock(org: string, session: string): boolean {
  const held = readJson<{ session?: string } | null>(lockPath(org), null);
  if (held?.session !== session) return false;
  rmSync(lockPath(org));
  return true;
}

/**
 * PRs Sivantha asked Sous to review by hand (`/review <link>`). `sous post` only posts where Sous
 * was asked, and a hand review counts. Only the main session can add one: no subagent may run `sous ask`.
 */
const askedPath = (org: string): string => join(orgDir(org), 'asked.json');
export const askedByHand = (org: string, key: string): boolean => readJson<string[]>(askedPath(org), []).includes(key);
export function askByHand(org: string, key: string): void {
  const keys = readJson<string[]>(askedPath(org), []);
  if (!keys.includes(key)) writeJson(askedPath(org), [...keys, key]);
}

/** Asked for your review: by name, or through a team you are in, in the PR's own org. */
export function askedYou(req: { users: { login: string }[]; teams: { slug: string }[] }, me: string, org: string, myTeams: { slug: string; organization: { login: string } }[]): boolean {
  const lower = (s: string) => s.toLowerCase();
  if (req.users.some((u) => lower(u.login) === lower(me))) return true;
  const mine = new Set(myTeams.filter((t) => lower(t.organization.login) === lower(org)).map((t) => lower(t.slug)));
  return req.teams.some((t) => mine.has(lower(t.slug)));
}
