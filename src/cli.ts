import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { isPaused, loadConfig, loadProfile, saveConfig, saveProfile, type Config } from './config.ts';
import { findDue } from './due.ts';
import { gate, POLL_SECONDS, readCodeRabbit } from './gate.ts';
import { get, getAll, ghFor, whoami } from './gh.ts';
import { meDir, orgDir, readJson, sousHome, writeJson } from './home.ts';
import { buildDenylist, findLeaks } from './leak.ts';
import { buildReview, dismissOwn, LintError, postReview, type Draft } from './post.ts';
import { loadState, logEvent, prKey, saveState } from './state.ts';

const run = promisify(execFile);
const print = (v: unknown): void => console.log(JSON.stringify(v, null, 2));
const sleep = (s: number) => new Promise((r) => setTimeout(r, s * 1000));

async function gitInit(dir: string): Promise<void> {
  if (existsSync(join(dir, '.git'))) return;
  await run('git', ['init', '-q'], { cwd: dir });
}

async function commitMemory(dir: string, message: string): Promise<void> {
  await run('git', ['add', '-A'], { cwd: dir });
  const { stdout } = await run('git', ['status', '--porcelain'], { cwd: dir });
  if (stdout.trim()) await run('git', ['-c', 'commit.gpgsign=false', 'commit', '-qm', message], { cwd: dir });
}

/** Repo names and member logins never leave local memory; keep the list current. */
async function refreshDenylist(org: string, account: string): Promise<void> {
  const gh = await ghFor(account);
  const repos = await getAll<{ name: string }>(gh, `orgs/${org}/repos?per_page=100`);
  const members = await getAll<{ login: string }>(gh, `orgs/${org}/members?per_page=100`).catch(() => []);
  const path = join(orgDir(org), 'denylist.json');
  const kept = readJson<string[]>(path, []);
  writeJson(path, [...new Set([...kept, ...repos.map((r) => r.name), ...members.map((m) => m.login)])].sort());
}

/**
 * Marks open PRs you already reviewed or commented on as seen at their current head,
 * so adding an org never floods the backlog. They come back on their next push.
 */
async function baseline(org: string, account: string): Promise<number> {
  const gh = await ghFor(account);
  const me = await whoami(gh);
  const state = loadState(org);
  let marked = 0;
  for (const q of [`reviewed-by:${me}`, `commenter:${me}`]) {
    const items = await getAll<{ number: number; repository_url: string }>(gh, `search/issues?per_page=100&q=${encodeURIComponent(`is:pr is:open org:${org} -author:${me} ${q}`)}`);
    for (const item of items) {
      const repo = item.repository_url.split('/repos/')[1]!;
      const key = prKey(repo, item.number);
      if (state.prs[key]) continue;
      const pull = await get<{ head: { sha: string } }>(gh, `repos/${repo}/pulls/${item.number}`);
      state.prs[key] = { head: pull.head.sha, reviewedAt: '', reviewIds: [], commentIds: [] };
      marked++;
    }
  }
  saveState(org, state);
  return marked;
}

const commands: Record<string, (args: string[]) => Promise<number>> = {
  async init() {
    mkdirSync(meDir(), { recursive: true });
    const path = join(sousHome(), 'config.json');
    if (!existsSync(path)) saveConfig({ orgs: [], paused: false, maxReviewsPerRun: 3 });
    await gitInit(meDir());
    print({ home: sousHome() });
    return 0;
  },

  async org(args) {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { account: { type: 'string' }, draft: { type: 'boolean' } } });
    const [sub, org] = positionals;
    if (sub !== 'add' || !org) throw new Error('usage: sous org add <org> [--account <gh login>] [--draft]');
    const account = values.account ?? (await run('gh', ['api', 'user', '--jq', '.login'])).stdout.trim();
    const gh = await ghFor(account);
    // Detect CodeRabbit from the check runs on the org's most recent PRs.
    const recent = await get<{ items: { number: number; repository_url: string }[] }>(gh, `search/issues?per_page=5&q=${encodeURIComponent(`is:pr org:${org}`)}`);
    let coderabbit = false;
    for (const pr of recent.items) {
      const repo = pr.repository_url.split('/repos/')[1]!;
      const pull = await get<{ head: { sha: string } }>(gh, `repos/${repo}/pulls/${pr.number}`);
      const runs = await get<{ total_count: number }>(gh, `repos/${repo}/commits/${pull.head.sha}/check-runs?check_name=CodeRabbit`);
      if (runs.total_count > 0) coderabbit = true;
    }
    const dir = orgDir(org);
    for (const sub of ['rules', 'candidates', 'system', 'examples', 'replay', 'drafts']) mkdirSync(join(dir, sub), { recursive: true });
    const existing = existsSync(join(dir, 'profile.json')) ? loadProfile(org) : null;
    saveProfile({
      org,
      ghAccount: account,
      postingMode: values.draft ? 'draft' : (existing?.postingMode ?? 'post'),
      coderabbit: coderabbit ? { login: 'coderabbitai[bot]', checkName: 'CodeRabbit' } : null,
      knowledgeGraph: existing?.knowledgeGraph ?? null,
      ruleSources: existing?.ruleSources ?? [],
    });
    await refreshDenylist(org, account);
    await baseline(org, account);
    const config = loadConfig();
    if (!config.orgs.includes(org)) saveConfig({ ...config, orgs: [...config.orgs, org] });
    await gitInit(dir);
    await commitMemory(dir, `org add ${org}`);
    print(loadProfile(org));
    return 0;
  },

  async due(args) {
    const { values } = parseArgs({ args, options: { org: { type: 'string' } } });
    const config = loadConfig();
    const started = new Date();
    const out = [];
    for (const org of values.org ? [values.org] : config.orgs) {
      const profile = loadProfile(org);
      const gh = await ghFor(profile.ghAccount);
      const me = await whoami(gh);
      const { due, skipped } = await findDue(gh, profile, loadState(org), me, started);
      for (const s of skipped) logEvent(org, 'skipped', s);
      for (const d of due.filter((d) => d.gate.action === 'defer')) logEvent(org, 'deferred', { pr: prKey(d.repo, d.number), head: d.head });
      out.push({ org, paused: isPaused(config, org), postingMode: profile.postingMode, due, skipped });
    }
    // Pick this run's reviews in code, so the cap holds whatever the prompt says.
    let budget = config.maxReviewsPerRun;
    const take = out.flatMap((o) => o.due.filter((d) => d.gate.action !== 'defer')).filter(() => budget-- > 0);
    print({ take: take.map((d) => ({ ...d, paused: isPaused(config, d.org) })), orgs: out });
    return 0;
  },

  /** Polls CodeRabbit for one PR until it can be reviewed. One call stays under 7 minutes. */
  async gate(args) {
    const [org, repo, n, head, startedAt] = args;
    if (!org || !repo || !n || !head) throw new Error('usage: sous gate <org> <owner/repo> <number> <head> [run-started-at]');
    const profile = loadProfile(org);
    const gh = await ghFor(profile.ghAccount);
    const commit = await get<{ commit: { committer: { date: string } } }>(gh, `repos/${repo}/commits/${head}`);
    const pushedAt = new Date(commit.commit.committer.date);
    const runStartedAt = startedAt ? new Date(startedAt) : new Date();
    const callStarted = Date.now();
    for (;;) {
      const signal = await readCodeRabbit(gh, profile, repo, Number(n), head, pushedAt);
      const result = gate({ enabled: profile.coderabbit !== null, signal, pushedAt, runStartedAt, now: new Date() });
      if (result.action !== 'wait' || Date.now() - callStarted + POLL_SECONDS * 1000 > 7 * 60_000) {
        print(result);
        return 0;
      }
      await sleep(result.recheckSeconds);
    }
  },

  /** Read-only checkout of the PR head. Nothing in it is ever run. */
  async checkout(args) {
    const [org, repo, n, head, base] = args;
    if (!org || !repo || !n || !head || !base) throw new Error('usage: sous checkout <org> <owner/repo> <number> <head> <base>');
    const profile = loadProfile(org);
    const { stdout: token } = await run('gh', ['auth', 'token', '--user', profile.ghAccount]);
    const env = { ...process.env, GH_TOKEN: token.trim() };
    const clone = join(sousHome(), 'cache', repo);
    if (!existsSync(clone)) {
      mkdirSync(join(clone, '..'), { recursive: true });
      await run('gh', ['repo', 'clone', repo, clone, '--', '--filter=blob:none', '--no-checkout', '-q'], { env });
    }
    await run('git', ['fetch', '-q', 'origin', `pull/${n}/head`, `+refs/heads/${base}:refs/remotes/origin/${base}`], { cwd: clone, env });
    const tree = join(clone, '.worktrees', `${n}-${head.slice(0, 12)}`);
    if (!existsSync(tree)) await run('git', ['worktree', 'add', '-q', '--detach', tree, head], { cwd: clone, env });
    print({ tree, baseRef: `origin/${base}`, readInstructionsWith: `git -C ${clone} show origin/${base}:<path>` });
    return 0;
  },

  async post(args) {
    const [file] = args;
    if (!file) throw new Error('usage: sous post <draft.json>');
    const draft = JSON.parse(readFileSync(file, 'utf8')) as Draft;
    const config = loadConfig();
    const profile = loadProfile(draft.org);
    const pending = isPaused(config, draft.org) || profile.postingMode === 'draft';
    let payload;
    try {
      payload = buildReview(draft, { pending });
    } catch (e) {
      if (e instanceof LintError) logEvent(draft.org, 'lint-refused', { pr: prKey(draft.repo, draft.number), problems: e.problems });
      throw e;
    }
    const gh = await ghFor(profile.ghAccount);
    const { reviewId, commentIds } = await postReview(gh, draft, payload);
    const state = loadState(draft.org);
    const key = prKey(draft.repo, draft.number);
    const prev = state.prs[key];
    state.prs[key] = {
      head: draft.head,
      reviewedAt: new Date().toISOString(),
      reviewIds: [...(prev?.reviewIds ?? []), reviewId],
      commentIds: [...(prev?.commentIds ?? []), ...commentIds],
    };
    saveState(draft.org, state);
    logEvent(draft.org, 'reviewed', { pr: key, head: draft.head, event: payload.event ?? 'PENDING', reviewId, findings: draft.findings.map((f) => ({ severity: f.severity, path: f.path, line: f.line })) });
    print({ pr: key, reviewId, event: payload.event ?? 'PENDING', comments: commentIds.length });
    return 0;
  },

  /** Records a head as reviewed when nothing survived verification, so it is not reviewed again. */
  async mark(args) {
    const [org, repo, n, head] = args;
    if (!org || !repo || !n || !head || !/^[0-9a-f]{40}$/.test(head)) throw new Error('usage: sous mark <org> <owner/repo> <number> <40-char head>');
    const state = loadState(org);
    const key = prKey(repo, Number(n));
    const prev = state.prs[key];
    state.prs[key] = { head, reviewedAt: new Date().toISOString(), reviewIds: prev?.reviewIds ?? [], commentIds: prev?.commentIds ?? [] };
    saveState(org, state);
    logEvent(org, 'reviewed', { pr: key, head, event: 'NONE', findings: [] });
    print({ pr: key, head, event: 'NONE' });
    return 0;
  },

  async dismiss(args) {
    const [org, repo, n, id, ...message] = args;
    if (!org || !repo || !n || !id || message.length === 0) throw new Error('usage: sous dismiss <org> <owner/repo> <number> <review-id> <message>');
    const profile = loadProfile(org);
    const gh = await ghFor(profile.ghAccount);
    const own = loadState(org).prs[prKey(repo, Number(n))]?.reviewIds ?? [];
    await dismissOwn(gh, repo, Number(n), Number(id), await whoami(gh), own, message.join(' '));
    logEvent(org, 'dismissed', { pr: prKey(repo, Number(n)), reviewId: Number(id) });
    print({ dismissed: Number(id) });
    return 0;
  },

  /** Fails when text bound for git (an engine diff, or me/) names anything from local org memory. */
  async 'leak-check'(args) {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { me: { type: 'boolean' }, diff: { type: 'string' } } });
    const denylist = buildDenylist();
    const sources: [string, string][] = positionals.map((f) => [f, readFileSync(f, 'utf8')]);
    if (values.diff) {
      const { stdout } = await run('git', ['diff', values.diff, '--', '.']);
      sources.push(['git diff', stdout.split('\n').filter((l) => l.startsWith('+')).join('\n')]);
    }
    if (values.me) {
      const { stdout } = await run('git', ['ls-files'], { cwd: meDir() });
      for (const f of stdout.split('\n').filter(Boolean)) sources.push([join(meDir(), f), readFileSync(join(meDir(), f), 'utf8')]);
    }
    const leaks = sources.flatMap(([name, text]) => findLeaks(text, denylist).map((l) => ({ file: name, ...l })));
    for (const l of leaks) console.error(`${l.file}:${l.line}: "${l.term}" in: ${l.text}`);
    console.error(leaks.length ? `${leaks.length} leak(s)` : 'no leaks');
    return leaks.length ? 1 : 0;
  },

  async pause(args) {
    return setPaused(args[0], true);
  },
  async resume(args) {
    return setPaused(args[0], false);
  },
};

function setPaused(org: string | undefined, on: boolean): number {
  const c = loadConfig();
  let paused: Config['paused'];
  if (!org) paused = on;
  else {
    const list = Array.isArray(c.paused) ? c.paused : c.paused === true ? [...c.orgs] : [];
    paused = on ? [...new Set([...list, org])] : list.filter((o) => o !== org);
  }
  saveConfig({ ...c, paused });
  print({ paused });
  return 0;
}

const [cmd, ...rest] = process.argv.slice(2);
const handler = cmd ? commands[cmd] : undefined;
if (!handler) {
  console.error(`usage: sous <${Object.keys(commands).join('|')}>`);
  process.exit(64);
}
handler(rest).then(
  (code) => process.exit(code),
  (err: Error) => {
    console.error(err.message);
    process.exit(err instanceof LintError ? 2 : 1);
  },
);
