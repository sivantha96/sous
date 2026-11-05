export type Severity = 'major' | 'minor' | 'nit';

export interface Finding {
  severity: Severity;
  path: string;
  line: number;
  body: string;
  /** Only when the author needs a specific fix, or there is one solid solution. Otherwise name the issue and let them solve it. */
  fix?: string;
  /** A choice only the reviewer can make. Kept in eval drafts so it counts; never posted. */
  owner?: boolean;
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
  return BANNED.filter(([re]) => re.test(text)).map(([, what]) => what);
}

export function lintFinding(f: Finding): string[] {
  const problems = lintText(`${f.body}\n${f.fix ?? ''}`);
  if (/^#{1,6}\s/m.test(f.body)) problems.push('heading in an inline comment');
  if (!f.path || !Number.isInteger(f.line) || f.line < 1) problems.push('finding has no file and line');
  return problems;
}
