import type { PrState } from './state.ts';

export interface PrComment {
  id: number;
  in_reply_to_id?: number;
  user: { login: string } | null;
  body: string;
  path: string;
  line: number | null;
  reactions?: { total_count: number; '+1'?: number; '-1'?: number; confused?: number; heart?: number; laugh?: number; hooray?: number; rocket?: number; eyes?: number };
}

/** What happened in one Sous thread since Sous last looked. */
export interface ThreadSignal {
  /** The Sous comment that starts the thread. */
  commentId: number;
  path: string;
  line: number | null;
  /** Teammate replies not yet judged. Replies by your own account are learning signals, not for the reply judge. */
  replies: { id: number; user: string; body: string }[];
  /** Reactions on the Sous comment, when the count changed. */
  reactions: { total: number; seenBefore: number; up: number; down: number; confused: number } | null;
}

const hasSousMarker = (body: string | null | undefined): boolean => /<!-- sous:[0-9a-f]+ -->/.test(body ?? '');

/**
 * Teammate replies and reaction changes on Sous's threads. Sous posts as you, so your replies are
 * normally yours to act on, not a teammate's. On your own PR (`authoredByMe`) they are the author's
 * answers, and count like any author's; Sous's own replies carry its marker either way.
 */
export function threadSignals(comments: PrComment[], pr: PrState, me: string, authoredByMe = false): ThreadSignal[] {
  const own = new Set(pr.commentIds);
  const handled = new Set(pr.handled);
  const out: ThreadSignal[] = [];
  for (const c of comments.filter((c) => own.has(c.id))) {
    // A Sous reply in the thread after it means it was answered, even if state lost `handled`.
    const lastSous = Math.max(0, ...comments.filter((r) => r.in_reply_to_id === c.id && (pr.replyIds.includes(r.id) || hasSousMarker(r.body))).map((r) => r.id));
    const replies = comments
      .filter((r) => r.in_reply_to_id === c.id && (r.user?.login !== me || (authoredByMe && !pr.replyIds.includes(r.id) && !hasSousMarker(r.body))) && !handled.has(r.id) && r.id > lastSous)
      .map((r) => ({ id: r.id, user: r.user?.login ?? 'ghost', body: r.body }));
    const total = c.reactions?.total_count ?? 0;
    const seenBefore = pr.reactions[String(c.id)] ?? 0;
    const reactions = total !== seenBefore ? { total, seenBefore, up: c.reactions?.['+1'] ?? 0, down: c.reactions?.['-1'] ?? 0, confused: c.reactions?.confused ?? 0 } : null;
    if (replies.length || reactions) out.push({ commentId: c.id, path: c.path, line: c.line, replies, reactions });
  }
  return out;
}

/** Refuses to act on any thread Sous did not start: a thread you started is a conversation with you. */
export function assertOwnThread(pr: PrState | undefined, commentId: number): asserts pr is PrState {
  if (!pr?.commentIds.includes(commentId)) throw new Error(`comment ${commentId} does not start a Sous thread; not touching it`);
}

interface ThreadPage {
  data: {
    repository: {
      pullRequest: {
        reviewThreads: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          nodes: { id: string; isResolved: boolean; isOutdated: boolean; comments: { nodes: { databaseId: number }[] } }[];
        };
      };
    };
  };
}

export interface ReviewThread {
  id: string;
  isResolved: boolean;
  /** The lines it was left on changed since. */
  isOutdated: boolean;
  /** The id of the comment that starts the thread. */
  firstCommentId: number | undefined;
}

/** Every review thread on a PR, following GraphQL pages. */
export async function reviewThreads(gh: (args: string[]) => Promise<string>, repo: string, n: number): Promise<ReviewThread[]> {
  const [owner, name] = repo.split('/');
  const query = `query($owner:String!,$name:String!,$n:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$n){reviewThreads(first:100,after:$after){pageInfo{hasNextPage endCursor} nodes{id isResolved isOutdated comments(first:1){nodes{databaseId}}}}}}}`;
  const out: ReviewThread[] = [];
  let after: string | null = null;
  for (;;) {
    const args = ['api', 'graphql', '-f', `query=${query}`, '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `n=${n}`];
    if (after) args.push('-F', `after=${after}`);
    const threads = (JSON.parse(await gh(args)) as ThreadPage).data.repository.pullRequest.reviewThreads;
    out.push(...threads.nodes.map((t) => ({ id: t.id, isResolved: t.isResolved, isOutdated: t.isOutdated, firstCommentId: t.comments.nodes[0]?.databaseId })));
    if (!threads.pageInfo.hasNextPage) return out;
    after = threads.pageInfo.endCursor;
  }
}

/** Finds the GraphQL id of the review thread whose first comment is `commentId`. */
export async function threadIdFor(
  gh: (args: string[]) => Promise<string>,
  repo: string,
  n: number,
  commentId: number,
): Promise<{ id: string; isResolved: boolean } | null> {
  const hit = (await reviewThreads(gh, repo, n)).find((t) => t.firstCommentId === commentId);
  return hit ? { id: hit.id, isResolved: hit.isResolved } : null;
}

/** Whether Sous wrote the last comment in the thread its comment starts: a follow-up is said once, then it waits. */
export function sousHasLastWord(comments: PrComment[], pr: PrState, commentId: number): boolean {
  const last = comments.filter((c) => c.id === commentId || c.in_reply_to_id === commentId).reduce((a, c) => (c.id > a.id ? c : a));
  return pr.commentIds.includes(last.id) || pr.replyIds.includes(last.id) || hasSousMarker(last.body);
}
