import { cleanForPublishing } from './published.ts';
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

/** Every comment and reply Sous posts ends with the italic attribution, then the hidden marker. */
export const signed = (text: string, attribution: string, head: string): string => `${cleanForPublishing(text.trim())}\n\n_${attribution}_\n\n${marker(head)}`;

const render = (f: Finding): string => (f.fix?.trim() ? `${f.body}\n\nFix: ${f.fix}` : f.body);

/** RIGHT-side line numbers a review comment may anchor to: lines a hunk adds or keeps. */
export function rightLines(patch: string | undefined): Set<number> {
  const lines = new Set<number>();
  let line = 0;
  for (const row of (patch ?? '').split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row);
    if (hunk) {
      line = Number(hunk[1]);
      continue;
    }
    if (line === 0 || row.startsWith('-') || row.startsWith('\\')) continue;
    lines.add(line++);
  }
  return lines;
}

export class LintError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`refusing to post:\n- ${problems.join('\n- ')}`);
    this.problems = problems;
  }
}

export function buildReview(
  d: Draft,
  opts: { pending: boolean; attribution: string; files: { filename: string; patch?: string }[] },
): ReviewPayload {
  const problems = d.findings.flatMap((f) => lintFinding(f).map((p) => `${f.path}:${f.line}: ${p}`));
  for (const f of d.findings.filter((f) => f.owner)) problems.push(`${f.path}:${f.line}: owner decision; it goes to questions.md, never the PR`);
  if (d.findings.length === 0) problems.push('no findings; record the head with `sous mark` instead');
  if (!/^[0-9a-f]{40}$/.test(d.head)) problems.push('head is not a full commit sha');
  const anchors = new Map(opts.files.map((f) => [f.filename, rightLines(f.patch)]));
  for (const f of d.findings) {
    if (!anchors.get(f.path)?.has(f.line)) problems.push(`${f.path}:${f.line}: not a line in the diff; GitHub would reject the whole review`);
  }
  if (problems.length) throw new LintError(problems);

  // No review body: the inline comments are the whole review.
  const payload: ReviewPayload = {
    commit_id: d.head,
    body: '',
    comments: d.findings.map((f) => ({ path: f.path, line: f.line, side: 'RIGHT', body: signed(render(f), opts.attribution, d.head) })),
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
  const url = `repos/${d.repo}/pulls/${d.number}/reviews`;
  // If GitHub ever requires a body for this event, fall back to the attribution line alone.
  const review = await send<PostedReview>(gh, 'POST', url, payload).catch((e: Error) => {
    if (!/body/i.test(e.message) || payload.body) throw e;
    return send<PostedReview>(gh, 'POST', url, { ...payload, body: payload.comments[0]!.body.split('\n\n').slice(-2).join('\n\n') });
  });
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
 * recorded in state, posted by this account, and with the marker on its comments (the body is empty).
 */
export async function dismissOwn(gh: Gh, repo: string, n: number, reviewId: number, me: string, ownIds: number[], message: string): Promise<void> {
  const r = await get<Review>(gh, `repos/${repo}/pulls/${n}/reviews/${reviewId}`);
  const notOurs = (): never => {
    throw new Error(`review ${reviewId} is not a Sous review; not dismissing`);
  };
  if (!ownIds.includes(reviewId) || r.user?.login !== me) notOurs();
  if (r.body && !hasMarker(r.body)) notOurs();
  const comments = await get<{ body: string }[]>(gh, `repos/${repo}/pulls/${n}/reviews/${reviewId}/comments?per_page=100`);
  if (!comments.some((c) => hasMarker(c.body)) && !hasMarker(r.body)) notOurs();
  if (r.state !== 'CHANGES_REQUESTED') throw new Error(`review ${reviewId} is ${r.state}, nothing to dismiss`);
  const problems = lintText(message);
  if (problems.length) throw new LintError(problems);
  await send(gh, 'PUT', `repos/${repo}/pulls/${n}/reviews/${reviewId}/dismissals`, { message, event: 'DISMISS' });
}
