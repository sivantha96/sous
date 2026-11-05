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

export function threadSignals(comments: PrComment[], pr: PrState, me: string): ThreadSignal[] {
  const own = new Set(pr.commentIds);
  const handled = new Set(pr.handled);
  const out: ThreadSignal[] = [];
  for (const c of comments.filter((c) => own.has(c.id))) {
    const replies = comments
      .filter((r) => r.in_reply_to_id === c.id && r.user?.login !== me && !handled.has(r.id))
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
          nodes: { id: string; isResolved: boolean; comments: { nodes: { databaseId: number }[] } }[];
        };
      };
    };
  };
}

/** Finds the GraphQL id of the review thread whose first comment is `commentId`. */
export async function threadIdFor(
  gh: (args: string[]) => Promise<string>,
  repo: string,
  n: number,
  commentId: number,
): Promise<{ id: string; isResolved: boolean } | null> {
  const [owner, name] = repo.split('/');
  const query = `query($owner:String!,$name:String!,$n:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$n){reviewThreads(first:100,after:$after){pageInfo{hasNextPage endCursor} nodes{id isResolved comments(first:1){nodes{databaseId}}}}}}}`;
  let after: string | null = null;
  for (;;) {
    const args = ['api', 'graphql', '-f', `query=${query}`, '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `n=${n}`];
    if (after) args.push('-F', `after=${after}`);
    const page = JSON.parse(await gh(args)) as ThreadPage;
    const threads = page.data.repository.pullRequest.reviewThreads;
    const hit = threads.nodes.find((t) => t.comments.nodes[0]?.databaseId === commentId);
    if (hit) return { id: hit.id, isResolved: hit.isResolved };
    if (!threads.pageInfo.hasNextPage) return null;
    after = threads.pageInfo.endCursor;
  }
}
