import { join } from 'node:path';
import { orgDir, readJson, sousHome, writeJson } from './home.ts';

export type PostingMode = 'post' | 'draft';

export interface Config {
  orgs: string[];
  /** true pauses posting everywhere; a list pauses only those orgs. Paused reviews become pending drafts. */
  paused: boolean | string[];
  /** Reviews posted per run, across all orgs, so a backlog never lands at once. */
  maxReviewsPerRun: number;
  /** Italic line that ends every comment and the review body, saying whose AI reviewer wrote it. */
  attribution: string;
  /** Eval case-runs allowed per day (cases × repeats), so the learning loop can't spend without limit. */
  evalBudgetPerDay: number;
}

export interface Profile {
  org: string;
  /** The gh account whose token Sous uses for this org (`gh auth token --user <account>`). */
  ghAccount: string;
  postingMode: PostingMode;
  /** null when the org has no CodeRabbit; the gate is then skipped. */
  coderabbit: { login: string; checkName: string } | null;
  knowledgeGraph: { mcp: string } | null;
  /** Paths (repo/path) whose base-branch copies hold the org's rules. */
  ruleSources: string[];
  /** Post the lowest tier too. Off until the replay shows Sivantha makes such points. */
  postSuggestions: boolean;
}

const configPath = (): string => join(sousHome(), 'config.json');
const profilePath = (org: string): string => join(orgDir(org), 'profile.json');

export function loadConfig(): Config {
  const c = readJson<Partial<Config> | null>(configPath(), null);
  if (!c) throw new Error(`no ${configPath()}; run \`sous init\``);
  if (!Array.isArray(c.orgs)) throw new Error('config.json: "orgs" must be a list');
  if (c.attribution !== undefined && !/^\S.*\S$/.test(c.attribution)) throw new Error('config.json: "attribution" must be one line of text');
  return { orgs: c.orgs, paused: c.paused ?? false, maxReviewsPerRun: c.maxReviewsPerRun ?? 3, attribution: c.attribution ?? 'From the AI reviewer', evalBudgetPerDay: c.evalBudgetPerDay ?? 15 };
}

export function saveConfig(c: Config): void {
  writeJson(configPath(), c);
}

export function loadProfile(org: string): Profile {
  const p = readJson<Partial<Profile> | null>(profilePath(org), null);
  if (!p) throw new Error(`no profile for ${org}; run \`sous org add ${org}\``);
  for (const key of ['org', 'ghAccount', 'postingMode'] as const) {
    if (!p[key]) throw new Error(`${profilePath(org)}: "${key}" is missing`);
  }
  if (p.org !== org) throw new Error(`${profilePath(org)}: "org" is ${p.org}, expected ${org}`);
  if (p.postingMode !== 'post' && p.postingMode !== 'draft') throw new Error(`${profilePath(org)}: "postingMode" must be post or draft`);
  return {
    org,
    ghAccount: p.ghAccount!,
    postingMode: p.postingMode,
    coderabbit: p.coderabbit ?? null,
    knowledgeGraph: p.knowledgeGraph ?? null,
    ruleSources: p.ruleSources ?? [],
    postSuggestions: p.postSuggestions ?? false,
  };
}

export function saveProfile(p: Profile): void {
  writeJson(profilePath(p.org), p);
}

export const isPaused = (c: Config, org: string): boolean =>
  c.paused === true || (Array.isArray(c.paused) && c.paused.includes(org));
