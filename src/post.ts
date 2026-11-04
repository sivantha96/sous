import { get, send, type Gh } from './gh.ts';
import { lintFinding, lintText, type Finding } from './voice-lint.ts';

/** APPROVE is deliberately not in this type: Sous never approves. */
export type ReviewEvent = 'COMMENT' | 'REQUEST_CHANGES';

/** What the writer subagent hands to `sous post`. */
export interface Draft {
  org: string;
  repo: string;
  number: number;
  head: string;
  /** The review body in the "AI review" format. */
  summary: string;
  findings: Finding[];
}

export interface ReviewPayload {
  commit_id: string;
  body: string;
  /** Omitted for a pending review that only you can see. */
  event?: ReviewEvent;
  comments: { path: string; line: number; side: 'RIGHT'; body: string }[];
}

/** Hidden in every Sous comment, so Sous can tell its own comments from yours. */
export const marker = (head: string): string => `<!-- sous:${head.slice(0, 12)} -->`;
export const hasMarker = (body: string | null | undefined): boolean => /<!-- sous:[0-9a-f]+ -->/.test(body ?? '');

const render = (f: Finding): string => (f.fix ? `${f.body}\n\nFix: ${f.fix}` : f.body);

export class LintError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`refusing to post:\n- ${problems.join('\n- ')}`);
    this.problems = problems;
  }
}

export function buildReview(d: Draft, opts: { pending: boolean }): ReviewPayload {
  const problems = [
    ...lintText(d.summary).map((p) => `summary: ${p}`),
    ...d.findings.flatMap((f) => lintFinding(f).map((p) => `${f.path}:${f.line}: ${p}`)),
  ];
  if (!/^[0-9a-f]{40}$/.test(d.head)) problems.push('head is not a full commit sha');
  if (problems.length) throw new LintError(problems);

  const payload: ReviewPayload = {
    commit_id: d.head,
    body: `${d.summary.trim()}\n\n${marker(d.head)}`,
    comments: d.findings.map((f) => ({ path: f.path, line: f.line, side: 'RIGHT', body: `${render(f)}\n\n${marker(d.head)}` })),
  };
  if (!opts.pending) payload.event = d.findings.some((f) => f.severity === 'major') ? 'REQUEST_CHANGES' : 'COMMENT';
  return payload;
}

interface PostedReview {
  id: number;
}
interface ReviewComment {
  id: number;
  pull_request_review_id: number;
}

export async function postReview(gh: Gh, d: Draft, payload: ReviewPayload): Promise<{ reviewId: number; commentIds: number[] }> {
  if ((payload as { event?: string }).event === 'APPROVE') throw new Error('Sous never approves');
  const review = await send<PostedReview>(gh, 'POST', `repos/${d.repo}/pulls/${d.number}/reviews`, payload);
  const comments = await get<ReviewComment[]>(gh, `repos/${d.repo}/pulls/${d.number}/reviews/${review.id}/comments?per_page=100`);
  return { reviewId: review.id, commentIds: comments.map((c) => c.id) };
}

interface Review {
  id: number;
  user: { login: string } | null;
  state: string;
  body: string | null;
}

/**
 * Dismisses a request-changes review once its Majors are fixed. Only a review Sous wrote:
 * posted by this account, carrying the marker, and recorded in state.
 */
export async function dismissOwn(gh: Gh, repo: string, n: number, reviewId: number, me: string, ownIds: number[], message: string): Promise<void> {
  const r = await get<Review>(gh, `repos/${repo}/pulls/${n}/reviews/${reviewId}`);
  if (!ownIds.includes(reviewId) || r.user?.login !== me || !hasMarker(r.body)) throw new Error(`review ${reviewId} is not a Sous review; not dismissing`);
  if (r.state !== 'CHANGES_REQUESTED') throw new Error(`review ${reviewId} is ${r.state}, nothing to dismiss`);
  const problems = lintText(message);
  if (problems.length) throw new LintError(problems);
  await send(gh, 'PUT', `repos/${repo}/pulls/${n}/reviews/${reviewId}/dismissals`, { message, event: 'DISMISS' });
}
