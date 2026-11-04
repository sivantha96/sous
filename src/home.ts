import { mkdirSync, readFileSync, renameSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// All learned memory lives here, never in this repo. SOUS_HOME overrides it (tests use a temp dir).
export const sousHome = (): string => process.env.SOUS_HOME ?? join(homedir(), '.sous');
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
