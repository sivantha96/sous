import { mkdirSync, readFileSync, renameSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// All learned memory lives here, never in this repo. SOUS_HOME overrides it (tests use a temp dir).
/** The org a session is reviewing, so the guard can keep every other org out of reach. */
export const focusPath = (session: string): string => join(sousHome(), 'sessions', `${session.replace(/[^\w-]/g, '')}.json`);

export const sousHome = (): string => process.env.SOUS_HOME ?? join(homedir(), '.sous');
/**
 * Claude Code's user config dir: transcripts, skills and the plugin cache. CLAUDE_CONFIG_DIR moves
 * all of it (a second install keeps it at ~/.claude-<name>); an empty value counts as unset.
 */
export const claudeHome = (env: NodeJS.ProcessEnv = process.env, home = homedir()): string => env.CLAUDE_CONFIG_DIR || join(home, '.claude');
export const meDir = (): string => join(sousHome(), 'me');
export const orgDir = (org: string): string => {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(org)) throw new Error(`not a GitHub org name: ${org}`);
  return join(sousHome(), 'orgs', org);
};

export function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

// Write to a temp file and rename, so a crash never leaves half a state file.
export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

export function appendLine(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(value)}\n`);
}
