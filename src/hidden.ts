/**
 * Text a person reading the PR on GitHub can't see but a model reads: HTML comments, zero-width
 * characters and bidirectional controls. GitHub's own coding agent strips the same before reading
 * an issue. In code, bidi controls can make a line read differently from how it runs, so the diff's
 * are reported as findings rather than removed.
 */
const INVISIBLE = /[​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;
const BIDI = /[‪-‮⁦-⁩]/;
const HTML_COMMENT = /<!--(?! sous:[0-9a-f]+ -->)[\s\S]*?-->/g;

export function stripHidden(text: string): { text: string; removed: number } {
  let removed = 0;
  const out = text
    .replace(HTML_COMMENT, () => {
      removed++;
      return '';
    })
    .replace(INVISIBLE, () => {
      removed++;
      return '';
    });
  return { text: out, removed };
}

export interface HiddenChar {
  path: string;
  line: number;
  codepoints: string[];
  bidi: boolean;
}

/** Added lines in a unified diff (`git diff`) that carry invisible or bidi characters. */
export function hiddenInDiff(diff: string): HiddenChar[] {
  const out: HiddenChar[] = [];
  let path = '';
  let line = 0;
  for (const row of diff.split('\n')) {
    if (row.startsWith('+++ ')) {
      path = row.replace(/^\+\+\+ (b\/)?/, '');
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row);
    if (hunk) {
      line = Number(hunk[1]);
      continue;
    }
    if (row.startsWith('-') || row.startsWith('\\')) continue;
    if (row.startsWith('+')) {
      const found = row.match(INVISIBLE);
      // A byte-order mark on a file's first line is ordinary.
      const real = found?.filter((c) => !(c === '﻿' && line === 1));
      if (real?.length) out.push({ path, line, codepoints: [...new Set(real.map((c) => `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`))], bidi: real.some((c) => BIDI.test(c)) });
    }
    line++;
  }
  return out;
}
