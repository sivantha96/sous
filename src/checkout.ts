import { CONVENTION_FILES } from './noise.ts';

type Run = (file: string, args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv; maxBuffer?: number }) => Promise<{ stdout: string }>;

/** Every branch, not only the PR and its base: agents read stacked parents and siblings, which go stale otherwise. */
export const fetchArgs = (n: string | number, prune = true): string[] => ['fetch', '-q', ...(prune ? ['--prune'] : []), 'origin', `pull/${n}/head`, '+refs/heads/*:refs/remotes/origin/*'];

/**
 * Downloads the base copies agents read with `git show`: the clone is partial, and an agent's sandbox
 * can't reach gh's token, so a blob fetched on demand from there fails.
 */
export async function prefetchBase(run: Run, clone: string, base: string, paths: string[], env: NodeJS.ProcessEnv): Promise<void> {
  const { stdout } = await run('git', ['ls-tree', '-r', '--name-only', `origin/${base}`, '--', ...paths], { cwd: clone });
  for (const f of stdout.split('\n').filter(Boolean)) await run('git', ['cat-file', '-p', `origin/${base}:${f}`], { cwd: clone, env, maxBuffer: 64 * 1024 * 1024 });
}

/** Each file's own patch in a `git diff` output, without index lines and hunk headers, so a base merge that only moves lines leaves it equal. */
export function patchesByFile(diff: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of diff.split(/^(?=diff --git )/m)) {
    const name = /^diff --git a\/.+? b\/(.+)$/m.exec(part)?.[1];
    if (!name) continue;
    // A binary file's patch is only `Binary files ... differ`: keep its index line, or every change reads as none.
    const binary = /^Binary files /m.test(part);
    out.set(name, part.split('\n').filter((l) => (binary || !l.startsWith('index ')) && !l.startsWith('@@')).join('\n'));
  }
  return out;
}

/** Files whose own patch against the base differs between two heads: what an incremental review reads. */
export function changedPatches(before: string, after: string): { changed: string[]; unchanged: string[] } {
  const a = patchesByFile(before);
  const b = patchesByFile(after);
  const changed = [...b.keys()].filter((f) => a.get(f) !== b.get(f));
  return { changed, unchanged: [...b.keys()].filter((f) => !changed.includes(f)) };
}

/** Root convention files, plus each nested one whose folder holds a changed path: a nested AGENTS.md rules only its own subtree. */
export function conventionsFor(baseFiles: string[], changed: string[]): string[] {
  return baseFiles.filter((f) => {
    const slash = f.lastIndexOf('/');
    if (!CONVENTION_FILES.includes(f.slice(slash + 1))) return false;
    const dir = slash < 0 ? '' : f.slice(0, slash + 1);
    return dir === '' || changed.some((p) => p.startsWith(dir));
  });
}

/**
 * Globs a repo itself declares generated, read at the base: `linguist-generated` in .gitattributes and
 * negated `path_filters` in .coderabbit.yaml. Never from the PR head, which could hide its own changes.
 * shortcut: a line-based read of the YAML list, not a YAML parser; upgrade if a repo nests filters elsewhere.
 */
export function generatedGlobs(gitattributes: string, coderabbit: string): string[] {
  const attrs = gitattributes.split('\n').filter((l) => /\slinguist-generated(=true)?(\s|$)/.test(l)).map((l) => l.trim().split(/\s+/)[0]!);
  const filters = [...coderabbit.matchAll(/^\s*-\s*["']?!([^"'\s]+)["']?\s*$/gm)].map((m) => m[1]!);
  return [...attrs, ...filters].map((g) => (g.startsWith('/') ? g.slice(1) : g.includes('/') ? g : `**/${g}`));
}
