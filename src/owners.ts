/**
 * CODEOWNERS, as GitHub reads it: the first of `.github/CODEOWNERS`, `CODEOWNERS` and
 * `docs/CODEOWNERS` on the base branch, gitignore-style patterns, and the last matching line wins.
 * Used to report a PR whose owned paths have no owner asked to review it.
 */
export const CODEOWNERS_PATHS = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'];

export interface OwnerRule {
  pattern: string;
  owners: string[];
  re: RegExp;
}

function toRegExp(pattern: string): RegExp {
  const anchored = pattern.startsWith('/') || pattern.replace(/\/$/, '').includes('/');
  const body = pattern
    .replace(/^\//, '')
    .replace(/\/$/, '/**')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\/?/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\u0000/g, '(?:.*/)?')
    .replace(/\(\?:\.\*\/\)\?$/, '.*');
  // A pattern names a file or a folder: a folder match also matches everything inside it.
  return new RegExp(`${anchored ? '^' : '(^|/)'}${body}(/.*)?$`);
}

export function parseCodeowners(text: string): OwnerRule[] {
  return text.split('\n').flatMap((raw) => {
    const line = raw.replace(/(^|\s)#.*$/, '').trim();
    if (!line) return [];
    const [pattern, ...owners] = line.split(/\s+/);
    return [{ pattern: pattern!, owners, re: toRegExp(pattern!) }];
  });
}

export function ownersOf(rules: OwnerRule[], path: string): string[] {
  let owners: string[] = [];
  for (const r of rules) if (r.re.test(path)) owners = r.owners;
  return owners;
}

/**
 * Changed paths whose owners include nobody who is requested or has reviewed. A team owner
 * (`@org/team`) counts when that team is requested; a person, when they are requested or reviewed.
 */
export function unownedChanges(rules: OwnerRule[], paths: string[], asked: { users: string[]; teams: string[] }): { path: string; owners: string[] }[] {
  const users = new Set(asked.users.map((u) => `@${u.toLowerCase()}`));
  const teams = new Set(asked.teams.map((t) => t.toLowerCase()));
  return paths.flatMap((path) => {
    const owners = ownersOf(rules, path);
    if (owners.length === 0) return [];
    const covered = owners.some((o) => {
      const lower = o.toLowerCase();
      return users.has(lower) || (lower.includes('/') && teams.has(lower.split('/')[1]!));
    });
    return covered ? [] : [{ path, owners }];
  });
}
