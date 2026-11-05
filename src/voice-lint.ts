import { findSecrets } from './published.ts';

/** `suggestion` is the lowest tier: kept in eval drafts, posted only when the org turns it on. */
export type Severity = 'major' | 'minor' | 'nit' | 'suggestion';
export type Side = 'RIGHT' | 'LEFT';

/** Exact text at a cited line: checked against the head (RIGHT) or the base (LEFT) before posting. */
export interface Quote {
  path: string;
  line: number;
  quote: string;
  side?: Side;
}

export interface Finding {
  severity: Severity;
  path: string;
  line: number;
  /** First line when the issue spans a block ending at `line`, on the same side and in the same hunk. */
  startLine?: number;
  body: string;
  /** Only when the author needs a specific fix, or there is one solid solution. Otherwise name the issue and let them solve it. */
  fix?: string;
  /** A choice only the reviewer can make. Kept in eval drafts so it counts; never posted. */
  owner?: boolean;
  /** LEFT anchors on a removed line (a deleted guard); RIGHT, the default, on an added or kept one. */
  side?: Side;
  /** Exact text of the anchor line, so a miscounted line can be moved. */
  quote?: string;
  /** The code that shows the problem. */
  evidence?: Quote[];
  /** The guard, caller or test checked while trying to refute the finding. Required. */
  counterEvidence?: Quote[];
  /** Memory bullets (file:line) that drove this finding: the hit log rule pruning reads. */
  memory?: string[];
  /** The lens candidate id(s) this finding came from, for the verifier's one-decision-per-id check. */
  id?: string;
}

// Words Sivantha never uses, and phrases that read like a bot.
const BANNED: [RegExp, string][] = [
  [/[—–]/, 'em-dash or en-dash'],
  [/\p{Extended_Pictographic}/u, 'emoji'],
  [/\b(please|sorry|kindly)\b/i, 'please/sorry'],
  [/\bnit:/i, '"nit:" prefix'],
  [/\b(great job|nice work|lgtm|well done|good catch)\b/i, 'praise'],
  [/\b(as an ai|i think|it seems|it appears|you might want to|consider)\b/i, 'hedge or bot phrase'],
  [/\b(obviously|clearly|simply|just wrong|you forgot)\b/i, 'blame word'],
];

export function lintText(text: string): string[] {
  return [...BANNED.filter(([re]) => re.test(text)).map(([, what]) => what), ...findSecrets(text).map((s) => `${s} in text: cite where it is, never the value`)];
}

export function lintFinding(f: Finding): string[] {
  const problems = lintText(`${f.body}\n${f.fix ?? ''}`);
  if (/^#{1,6}\s/m.test(f.body)) problems.push('heading in an inline comment');
  if (!f.path || !Number.isInteger(f.line) || f.line < 1) problems.push('finding has no file and line');
  return problems;
}
