/** Files with no reviewable intent: lockfiles, snapshots, generated output. Shared by `sous due` and the gatherer (`sous noise`). */
export const NOISE: RegExp[] = [
  /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|uv\.lock|poetry\.lock|Cargo\.lock|go\.sum|Podfile\.lock|Gemfile\.lock|composer\.lock)$/,
  /\.snap$/,
  /(^|\/)(dist|build|generated|__generated__|\.next|coverage)\//,
  /\.min\.(js|css)$/,
  /\.(map|pb\.go)$/,
];

export const isNoise = (path: string): boolean => NOISE.some((re) => re.test(path));
export const isNoiseOnly = (files: string[]): boolean => files.length > 0 && files.every(isNoise);

/** Tool-config folders a PR head must never put in front of an agent. Read only from the base, as data. */
export const AI_CONFIG = ['.claude', '.mcp.json', '.cursor', '.cursorrules', '.agents', '.codex', '.windsurf', '.github/copilot-instructions.md', 'CLAUDE.md', 'CLAUDE.local.md'];

/** Sparse-checkout patterns: everything except the AI-config paths, at any depth. */
export const sparsePatterns = (): string[] => ['/*', ...AI_CONFIG.flatMap((p) => [`!/${p}`, `!/**/${p}`])];

/** Convention files read from the base branch by default, beside the org's ruleSources. */
export const CONVENTION_FILES = ['REVIEW.md', 'AGENTS.md', 'CONVENTIONS.md', 'CONTRIBUTING.md', 'CLAUDE.md', '.cursorrules'];
