import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, relative, resolve } from 'node:path';
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
  reader: ['status', 'noise', 'checkout', 'gate', 'memory', 'facts', 'decisions'],
  writer: ['status', 'noise', 'post', 'mark', 'memory', 'decisions'],
  'reply-judge': ['status', 'checkout', 'reply', 'resolve', 'seen', 'memory', 'facts'],
  reflector: ['status', 'leak-check', 'score', 'facts', 'memory', 'stats'],
  main: [],
};

/** Never reachable by any role, the main session included: they move data off the machine. */
const NETWORK = new Set(['curl', 'wget', 'nc', 'ncat', 'netcat', 'ssh', 'scp', 'sftp', 'rsync', 'telnet', 'ftp', 'socat']);

/** Paths no agent may read: credentials and env files. Matched on the path and on where a symlink points. */
const SENSITIVE = /(^|\/)(\.ssh|\.aws|\.gnupg|\.docker|\.kube|\.netrc|\.npmrc|\.pypirc|\.config\/gh|\.config\/doppler|\.doppler|Library\/Keychains)(\/|$)|(^|\/)\.env(\.(?!example$)[\w.-]+)?$/;

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
    if (role === 'main') return NETWORK_RE.test(command) ? no('network tools are not allowed') : { ok: true };
    return no(parsed.reason);
  }
  for (const argv of parsed.parsed.stages) {
    const name = argv[0]!.split('/').pop()!;
    if (NETWORK.has(name)) return no(`${name} is not allowed: Sous agents never send data off the machine`);
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

export interface HookInput {
  tool_name: string;
  tool_input: { command?: string; file_path?: string; path?: string; pattern?: string };
  agent_type?: string;
  cwd?: string;
}

export function decide(input: HookInput): Verdict {
  const role = roleOf(input.agent_type);
  const cwd = input.cwd ?? process.cwd();
  if (input.tool_name === 'Bash') return checkCommand(input.tool_input.command ?? '', role, cwd);
  if (['Read', 'Grep', 'Glob'].includes(input.tool_name)) return checkPath(input.tool_input.file_path ?? input.tool_input.path, role, cwd);
  return { ok: true };
}
