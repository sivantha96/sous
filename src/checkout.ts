type Run = (file: string, args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv; maxBuffer?: number }) => Promise<{ stdout: string }>;

/** Every branch, not only the PR and its base: agents read stacked parents and siblings, which go stale otherwise. */
export const fetchArgs = (n: string | number): string[] => ['fetch', '-q', '--prune', 'origin', `pull/${n}/head`, '+refs/heads/*:refs/remotes/origin/*'];

/**
 * Downloads the base copies agents read with `git show`: the clone is partial, and an agent's sandbox
 * can't reach gh's token, so a blob fetched on demand from there fails.
 */
export async function prefetchBase(run: Run, clone: string, base: string, paths: string[], env: NodeJS.ProcessEnv): Promise<void> {
  const { stdout } = await run('git', ['ls-tree', '-r', '--name-only', `origin/${base}`, '--', ...paths], { cwd: clone });
  for (const f of stdout.split('\n').filter(Boolean)) await run('git', ['cat-file', '-p', `origin/${base}:${f}`], { cwd: clone, env, maxBuffer: 64 * 1024 * 1024 });
}
