import { realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sousHome } from './home.ts';
import { parseCommandLine, validateStage } from './vendor/shell-policy.ts';

/**
 * The PreToolUse guard for every Sous session and subagent. Claude Code passes `agent_type`
 * (the subagent's name) for calls made inside a subagent, and none for the main session.
 */
export type Role = 'reader' | 'writer' | 'reply-judge' | 'reflector' | 'main';

const ROLES: Record<string, Role> = {
  gatherer: 'reader',
  lens: 'reader',
  verifier: 'reader',
  'match-judge': 'reader',
  'signal-collector': 'reader',
  writer: 'writer',
  'reply-judge': 'reply-judge',
  reflector: 'reflector',
};

/** An unknown subagent is treated as a reader: the safe default. */
export const roleOf = (agentType: string | undefined): Role => (agentType ? (ROLES[agentType] ?? 'reader') : 'main');

/** `sous` subcommands each role may run. Everything else in sous writes to GitHub or memory. */
const SOUS: Record<Role, string[]> = {
  reader: ['status', 'noise', 'checkout', 'gate', 'memory', 'facts', 'decisions', 'plan', 'links', 'stagekey', 'stats', 'prtext', 'owners', 'skills'],
  writer: ['status', 'noise', 'post', 'mark', 'memory', 'decisions'],
  'reply-judge': ['status', 'checkout', 'reply', 'resolve', 'seen', 'memory', 'facts'],
  reflector: ['status', 'leak-check', 'score', 'facts', 'memory', 'stats', 'tokens', 'stagekey', 'evalrun'],
  main: [],
};

/** Never reachable by any role, the main session included: they move data off the machine. */
const NETWORK = new Set(['curl', 'wget', 'nc', 'ncat', 'netcat', 'ssh', 'scp', 'sftp', 'rsync', 'telnet', 'ftp', 'socat']);

/** Paths no agent may read: credentials and env files. Matched on the path and on where a symlink points. */
const SENSITIVE = /(^|\/)(\.ssh|\.aws|\.gnupg|\.docker|\.kube|\.netrc|\.npmrc|\.pypirc|\.config\/gh|\.config\/doppler|\.doppler|Library\/Keychains)(\/|$)|(^|\/)\.env(\.(?!example$)[\w.-]+)?$/;

/** Commands that print a credential. Refused for every role, the main session included. */
const CREDENTIAL_PRINTERS: ((argv: string[]) => boolean)[] = [
  (a) => a[0] === 'printenv' || (['env', 'export', 'set', 'declare'].includes(a[0]!) && a.length === 1),
  (a) => a[0] === 'gh' && a[1] === 'auth' && (a[2] === 'token' || a.some((x) => x === '-t' || x === '--show-token')),
  (a) => a[0] === 'security' && /^find-.*password$/.test(a[1] ?? ''),
  (a) => a[0] === 'doppler' && ['secrets', 'run', 'configs'].includes(a[1] ?? ''),
];
const CREDENTIAL_RE = /(^|[\s;&|(`$])(printenv|(env|export|set|declare)\s*($|[;&|])|gh\s+auth\s+token|security\s+find-\S*password|doppler\s+(secrets|run))\b|--show-token\b/;

/** The engine's own guard rails: no agent edits them, so no PR text can talk one into loosening them. */
const ENGINE_ROOT = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const PROTECTED = /^(src\/(guard|outbound|published|post)\.ts|src\/vendor\/.*|bin\/sous-guard|\.claude\/settings(\.local)?\.json)$/;

const GIT_READ = new Set(['show', 'diff', 'log', 'ls-files', 'ls-tree', 'merge-base', 'rev-parse', 'cat-file', 'grep', 'blame', 'status', 'rev-list', 'patch-id', 'describe', 'shortlog', 'name-rev']);
/** Git options that run programs or write files even under a read subcommand. */
const GIT_UNSAFE = /^(-c|--config-env|--exec-path|--output|-o|--ext-diff|--textconv|--upload-pack|--receive-pack|--open-files-in-pager|-O)(=|$)/;

const GH_READ: Record<string, string[] | true> = {
  api: true,
  pr: ['view', 'diff', 'list', 'checks', 'status'],
  issue: ['view', 'list'],
  repo: ['view'],
  run: ['view', 'list'],
  search: true,
  release: ['view', 'list'],
};

type Verdict = { ok: true } | { ok: false; reason: string };
const no = (reason: string): Verdict => ({ ok: false, reason });

/** Where a path really points: the nearest existing parent resolved, with the rest appended. */
function realOf(abs: string): string {
  let dir = abs;
  for (;;) {
    try {
      const real = realpathSync(dir);
      return resolve(real, relative(dir, abs));
    } catch {
      const up = dirname(dir);
      if (up === dir) return abs;
      dir = up;
    }
  }
}

function checkPathToken(token: string, cwd: string): Verdict {
  if (!/[/.~]/.test(token)) return { ok: true };
  const expanded = token.startsWith('~') ? `${homedir()}${token.slice(1)}` : token;
  const abs = resolve(cwd, expanded);
  if (SENSITIVE.test(abs)) return no(`reading credentials or env files is not allowed: ${token}`);
  const real = realOf(abs);
  if (SENSITIVE.test(real)) return no(`${token} links to credentials or env files`);
  // A committed symlink in a PR checkout must not lead outside that checkout.
  const cache = resolve(homedir(), '.sous', 'cache');
  if (abs.startsWith(`${cache}/`) && !real.startsWith(`${cache}/`)) return no(`${token} is a symlink that leaves the checkout`);
  return { ok: true };
}

function checkGit(argv: string[], role: Role): Verdict {
  let i = 1;
  while (argv[i] === '-C' || argv[i] === '--no-pager' || argv[i] === '-P') i += argv[i] === '-C' ? 2 : 1;
  const sub = argv[i];
  const flags = argv.slice(1);
  if (flags.some((a) => GIT_UNSAFE.test(a))) return no('git options that run programs or write files are not allowed');
  if (sub && GIT_READ.has(sub)) return { ok: true };
  if (role === 'reflector' && sub && ['switch', 'add', 'commit', 'push', 'revert', 'fetch', 'checkout', 'restore', 'branch', 'stash'].includes(sub)) {
    return flags.some((a) => /^(--force|-f|--force-with-lease)/.test(a)) ? no('force pushes and forced switches are not allowed') : { ok: true };
  }
  return no(`git ${sub ?? ''} is not allowed for this agent`);
}

function checkGh(argv: string[], role: Role): Verdict {
  const [, group, sub] = argv;
  const allowed = group ? GH_READ[group] : undefined;
  if (argv.some((a) => a.includes('://') || /^--hostname(=|$)/.test(a))) return no('gh may only talk to github.com');
  if (group === 'api') {
    const writes = argv.some((a, i) => /^(-f|-F|--field|--raw-field|--input)(=|$)/.test(a) || ((a === '-X' || a === '--method') && argv[i + 1]?.toUpperCase() !== 'GET') || /^--method=(?!GET$)/i.test(a));
    if (writes) return no('gh api may only read (GET); Sous writes to GitHub only through sous commands');
    if (argv.some((a) => a === 'graphql')) return no('gh api graphql is not allowed for agents');
    return { ok: true };
  }
  if (allowed === true || (Array.isArray(allowed) && sub && allowed.includes(sub))) return { ok: true };
  if (role === 'reflector' && group === 'pr' && sub === 'create') return { ok: true };
  return no(`gh ${group ?? ''} ${sub ?? ''} is not allowed for this agent`);
}

function checkSous(argv: string[], role: Role): Verdict {
  const sub = argv[1];
  return sub && SOUS[role].includes(sub) ? { ok: true } : no(`sous ${sub ?? ''} is not allowed for this agent`);
}

/** Decides one Bash command for one role. */
export function checkCommand(command: string, role: Role, cwd: string): Verdict {
  const parsed = parseCommandLine(command);
  if (!parsed.ok) {
    // The main session may use full shell syntax; it only loses network tools.
    if (role === 'main') {
      if (NETWORK_RE.test(command)) return no('network tools are not allowed');
      return CREDENTIAL_RE.test(command) ? no('commands that print credentials are not allowed') : { ok: true };
    }
    return no(parsed.reason);
  }
  for (const argv of parsed.parsed.stages) {
    const name = argv[0]!.split('/').pop()!;
    if (NETWORK.has(name)) return no(`${name} is not allowed: Sous agents never send data off the machine`);
    if (CREDENTIAL_PRINTERS.some((f) => f([name, ...argv.slice(1)]))) return no('commands that print credentials are not allowed; only sous itself holds the token');
    if (role === 'main') continue;
    for (const token of argv.slice(1)) {
      const v = checkPathToken(token, cwd);
      if (!v.ok) return v;
    }
    let v: Verdict;
    if (name === 'git') v = checkGit(argv, role);
    else if (name === 'gh') v = checkGh(argv, role);
    else if (name === 'sous' || argv[0] === './bin/sous' || argv[0]!.endsWith('/bin/sous')) v = checkSous(argv, role);
    else if (role === 'reflector' && name === 'pnpm' && ['check', 'test', 'typecheck'].includes(argv[1] ?? '')) v = { ok: true };
    else if (role === 'reflector' && name === 'mkdir') v = { ok: true };
    else v = validateStage(argv);
    if (!v.ok) return v;
  }
  return { ok: true };
}

const NETWORK_RE = new RegExp(`(^|[\\s;&|(\`$])(${[...NETWORK].join('|')})(\\s|$)`);

/** Read, Grep and Glob: only the credential check applies. */
export function checkPath(path: string | undefined, role: Role, cwd: string): Verdict {
  if (!path || role === 'main') return { ok: true };
  return checkPathToken(path, cwd);
}

const inside = (path: string, dir: string): boolean => path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep);

/**
 * Write, Edit and NotebookEdit. Every role: no credentials or env files, nothing inside a `.git`
 * folder (hooks there run outside any check), and none of the engine's guard files; the main
 * session may edit those only when the person started it with SOUS_ENGINE_EDIT=1. Subagents
 * write only under ~/.sous and the temp folder; the reflector also in this repo.
 */
export function checkWrite(path: string | undefined, role: Role, cwd: string, env: NodeJS.ProcessEnv = process.env): Verdict {
  if (!path) return no('no path to write');
  const abs = realOf(resolve(cwd, path.startsWith('~') ? `${homedir()}${path.slice(1)}` : path));
  const v = checkPathToken(abs, cwd);
  if (!v.ok) return v;
  if (abs.split(sep).includes('.git')) return no('writing inside a .git folder is not allowed');
  if (inside(abs, ENGINE_ROOT) && PROTECTED.test(relative(ENGINE_ROOT, abs).split(sep).join('/')) && !(role === 'main' && env.SOUS_ENGINE_EDIT === '1')) {
    return no(`${relative(ENGINE_ROOT, abs)} is one of Sous's own guard rails; edit it in a session started with SOUS_ENGINE_EDIT=1`);
  }
  if (role === 'main') return { ok: true };
  const allowed = [realOf(sousHome()), realOf(tmpdir()), ...(role === 'reflector' ? [ENGINE_ROOT] : [])];
  return allowed.some((d) => inside(abs, d)) ? { ok: true } : no(`subagents write only under ~/.sous and the temp folder${role === 'reflector' ? ' and the Sous repo' : ''}`);
}

export interface HookInput {
  tool_name: string;
  tool_input: { command?: string; file_path?: string; notebook_path?: string; path?: string; pattern?: string };
  agent_type?: string;
  cwd?: string;
}

/**
 * The verifier and writer judge findings against the code, never the PR's own words: a judge that
 * reads the author's text can be addressed by it. They are refused the gatherer's PR-text file.
 */
const BLIND = new Set(['verifier', 'writer']);
const PR_TEXT = /\.pr-text\.md\b/;

export function decide(input: HookInput): Verdict {
  const role = roleOf(input.agent_type);
  const cwd = input.cwd ?? process.cwd();
  if (input.agent_type && BLIND.has(input.agent_type) && PR_TEXT.test(JSON.stringify(input.tool_input))) return no('the verifier and writer never read the PR text; judge from the code and the findings');
  if (input.tool_name === 'Bash') return checkCommand(input.tool_input.command ?? '', role, cwd);
  if (['Read', 'Grep', 'Glob'].includes(input.tool_name)) return checkPath(input.tool_input.file_path ?? input.tool_input.path, role, cwd);
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(input.tool_name)) return checkWrite(input.tool_input.file_path ?? input.tool_input.notebook_path, role, cwd);
  return { ok: true };
}
