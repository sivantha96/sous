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
}

export const emptyPr = (head: string): PrState => ({ head, reviewedAt: '', reviewIds: [], commentIds: [], replyIds: [], handled: [], reactions: {} });

export interface OrgState {
  prs: Record<string, PrState>;
}

export const prKey = (repo: string, n: number): string => `${repo}#${n}`;

const statePath = (org: string): string => join(orgDir(org), 'state.json');

export function loadState(org: string): OrgState {
  const s = readJson<{ prs?: Record<string, Partial<PrState>> }>(statePath(org), {});
  // Fill fields added after a PR was first recorded.
  const prs = Object.fromEntries(Object.entries(s.prs ?? {}).map(([k, v]) => [k, { ...emptyPr(v.head ?? ''), ...v } as PrState]));
  return { prs };
}

export function saveState(org: string, s: OrgState): void {
  writeJson(statePath(org), s);
}

export type EventType = 'reviewed' | 'deferred' | 'dismissed' | 'skipped' | 'lint-refused' | 'replied' | 'resolved' | 'seen';

/** One append-only log every metric reads from. */
export function logEvent(org: string, type: EventType, data: Record<string, unknown>): void {
  appendLine(join(orgDir(org), 'events.jsonl'), { at: new Date().toISOString(), type, ...data });
}
