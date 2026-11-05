import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { isPaused, loadConfig, loadProfile, saveConfig, saveProfile, type Config } from './config.ts';
import { findDue } from './due.ts';
import { gate, POLL_SECONDS, readCodeRabbit } from './gate.ts';
import { get, getAll, ghFor, whoami } from './gh.ts';
import { appendLine, meDir, orgDir, readJson, sousHome, writeJson } from './home.ts';
import { buildDenylist, findLeaks } from './leak.ts';
import { buildReview, dismissOwn, hasMarker, LintError, marker, postReview, type Draft } from './post.ts';
import { commitAt, gateFails, parseAiReview, scoreCase, totals, type Case, type Gold, type Totals } from './replay.ts';
import { assertOwnThread, threadIdFor, type PrComment } from './threads.ts';
import { lintText } from './voice-lint.ts';
import { emptyPr, loadState, logEvent, prKey, saveState } from './state.ts';

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
      state.prs[key] = emptyPr(pull.head.sha);
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
    if (!existsSync(path)) saveConfig({ orgs: [], paused: false, maxReviewsPerRun: 3, attribution: 'From the AI reviewer' });
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
    const gh = await ghFor(profile.ghAccount);
    const files = await getAll<{ filename: string; patch?: string }>(gh, `repos/${draft.repo}/pulls/${draft.number}/files?per_page=100`);
    let payload;
    try {
      payload = buildReview(draft, { pending, attribution: config.attribution, files });
    } catch (e) {
      if (e instanceof LintError) logEvent(draft.org, 'lint-refused', { pr: prKey(draft.repo, draft.number), problems: e.problems });
      throw e;
    }
    const { reviewId, commentIds } = await postReview(gh, draft, payload);
    const state = loadState(draft.org);
    const key = prKey(draft.repo, draft.number);
    const prev = state.prs[key] ?? emptyPr(draft.head);
    state.prs[key] = {
      ...prev,
      head: draft.head,
      reviewedAt: new Date().toISOString(),
      reviewIds: [...prev.reviewIds, reviewId],
      commentIds: [...prev.commentIds, ...commentIds],
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
    state.prs[key] = { ...(state.prs[key] ?? emptyPr(head)), head, reviewedAt: new Date().toISOString() };
    saveState(org, state);
    logEvent(org, 'reviewed', { pr: key, head, event: 'NONE', findings: [] });
    print({ pr: key, head, event: 'NONE' });
    return 0;
  },

  /** Replies in a thread Sous started. Never in a thread you or anyone else started. */
  async reply(args) {
    const [org, repo, n, id, file] = args;
    if (!org || !repo || !n || !id || !file) throw new Error('usage: sous reply <org> <owner/repo> <number> <sous-comment-id> <text-file>');
    const config = loadConfig();
    const profile = loadProfile(org);
    const state = loadState(org);
    const key = prKey(repo, Number(n));
    const pr = state.prs[key];
    assertOwnThread(pr, Number(id));
    const text = readFileSync(file, 'utf8').trim();
    const problems = lintText(text);
    if (problems.length) {
      logEvent(org, 'lint-refused', { pr: key, reply: Number(id), problems });
      throw new LintError(problems);
    }
    if (isPaused(config, org)) throw new Error(`${org} is paused; not replying`);
    const gh = await ghFor(profile.ghAccount);
    const body = `${text}\n\n_${config.attribution}_\n\n${marker(pr.head)}`;
    const posted = JSON.parse(await gh(['api', '-X', 'POST', `repos/${repo}/pulls/${n}/comments/${id}/replies`, '--input', '-'], JSON.stringify({ body }))) as { id: number };
    pr.replyIds.push(posted.id);
    saveState(org, state);
    logEvent(org, 'replied', { pr: key, thread: Number(id), reply: posted.id });
    print({ replied: posted.id });
    return 0;
  },

  /** Resolves a thread Sous started, once its point is fixed or withdrawn. */
  async resolve(args) {
    const [org, repo, n, id] = args;
    if (!org || !repo || !n || !id) throw new Error('usage: sous resolve <org> <owner/repo> <number> <sous-comment-id>');
    const profile = loadProfile(org);
    const key = prKey(repo, Number(n));
    assertOwnThread(loadState(org).prs[key], Number(id));
    const gh = await ghFor(profile.ghAccount);
    const thread = await threadIdFor(gh, repo, Number(n), Number(id));
    if (!thread) throw new Error(`no review thread starts with comment ${id}`);
    if (!thread.isResolved) {
      await gh(['api', 'graphql', '-f', 'query=mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}', '-F', `id=${thread.id}`]);
      logEvent(org, 'resolved', { pr: key, thread: Number(id) });
    }
    print({ resolved: Number(id) });
    return 0;
  },

  /** Marks replies and reactions as judged, so the next run does not judge them again. */
  async seen(args) {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { replies: { type: 'string' } } });
    const [org, repo, n] = positionals;
    if (!org || !repo || !n) throw new Error('usage: sous seen <org> <owner/repo> <number> [--replies id,id]');
    const profile = loadProfile(org);
    const state = loadState(org);
    const key = prKey(repo, Number(n));
    const pr = state.prs[key];
    if (!pr) throw new Error(`${key} is not in state`);
    const ids = (values.replies ?? '').split(',').filter(Boolean).map(Number);
    pr.handled = [...new Set([...pr.handled, ...ids])];
    // Reactions: record today's counts on every Sous comment.
    const gh = await ghFor(profile.ghAccount);
    for (const c of await getAll<PrComment>(gh, `repos/${repo}/pulls/${n}/comments?per_page=100`)) {
      if (pr.commentIds.includes(c.id)) pr.reactions[String(c.id)] = c.reactions?.total_count ?? 0;
    }
    saveState(org, state);
    logEvent(org, 'seen', { pr: key, replies: ids });
    print({ handled: pr.handled.length });
    return 0;
  },

  /** Sous's record for one PR, with the live state of its reviews and threads. */
  async status(args) {
    const [org, repo, n] = args;
    if (!org || !repo || !n) throw new Error('usage: sous status <org> <owner/repo> <number>');
    const profile = loadProfile(org);
    const pr = loadState(org).prs[prKey(repo, Number(n))];
    if (!pr) throw new Error('not in state');
    const gh = await ghFor(profile.ghAccount);
    const reviews = await getAll<{ id: number; state: string; commit_id: string }>(gh, `repos/${repo}/pulls/${n}/reviews?per_page=100`);
    const comments = await getAll<PrComment & { original_commit_id: string }>(gh, `repos/${repo}/pulls/${n}/comments?per_page=100`);
    print({
      head: pr.head,
      reviews: reviews.filter((r) => pr.reviewIds.includes(r.id)).map((r) => ({ id: r.id, state: r.state, commit: r.commit_id })),
      blocking: reviews.filter((r) => pr.reviewIds.includes(r.id) && r.state === 'CHANGES_REQUESTED').map((r) => r.id),
      findings: comments
        .filter((c) => pr.commentIds.includes(c.id))
        .map((c) => ({ id: c.id, path: c.path, line: c.line, outdated: c.line === null, body: c.body.split('\n\n')[0], sous: hasMarker(c.body) })),
    });
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

  /** Builds replay cases from your past reviews in an org: one per PR, at the commit with most of your points. */
  async replay(args) {
    const [sub, org] = args;
    if (sub !== 'build' || !org) throw new Error('usage: sous replay build <org>');
    const profile = loadProfile(org);
    const gh = await ghFor(profile.ghAccount);
    const me = await whoami(gh);
    const found = new Map<string, { number: number; repository_url: string }>();
    for (const q of [`commenter:${me}`, `reviewed-by:${me}`]) {
      for (const i of await getAll<{ number: number; repository_url: string }>(gh, `search/issues?per_page=100&q=${encodeURIComponent(`is:pr org:${org} -author:${me} ${q}`)}`)) {
        found.set(`${i.repository_url}#${i.number}`, i);
      }
    }
    const dir = join(orgDir(org), 'replay', 'cases');
    mkdirSync(dir, { recursive: true });
    let written = 0;
    for (const item of found.values()) {
      const repo = item.repository_url.split('/repos/')[1]!;
      const n = item.number;
      const pull = await get<{ base: { ref: string } }>(gh, `repos/${repo}/pulls/${n}`);
      const commits = (await getAll<{ sha: string; commit: { committer: { date: string } } }>(gh, `repos/${repo}/pulls/${n}/commits?per_page=100`)).map((c) => ({ sha: c.sha, date: c.commit.committer.date }));
      const byCommit = new Map<string, { gold: Gold[]; first: string }>();
      const add = (sha: string | null, g: Gold, at: string) => {
        if (!sha) return;
        const e = byCommit.get(sha) ?? { gold: [], first: at };
        e.gold.push(g);
        if (at < e.first) e.first = at;
        byCommit.set(sha, e);
      };
      const inline = await getAll<PrComment & { original_line: number | null; original_commit_id: string; created_at: string }>(gh, `repos/${repo}/pulls/${n}/comments?per_page=100`);
      for (const c of inline) {
        if (c.user?.login !== me || c.in_reply_to_id || hasMarker(c.body) || !c.original_line) continue;
        add(c.original_commit_id, { path: c.path, line: c.original_line, text: c.body.slice(0, 500), source: 'inline' }, c.created_at);
      }
      const issue = await getAll<{ user: { login: string } | null; body: string; created_at: string }>(gh, `repos/${repo}/issues/${n}/comments?per_page=100`);
      for (const c of issue) {
        if (c.user?.login !== me || hasMarker(c.body)) continue;
        for (const g of parseAiReview(c.body)) add(commitAt(commits, c.created_at), { ...g, source: 'ai-review' }, c.created_at);
      }
      const best = [...byCommit.entries()].sort((a, b) => b[1].gold.length - a[1].gold.length)[0];
      if (!best) continue;
      const [head, { gold, first }] = best;
      const id = `${repo.split('/')[1]}-${n}-${head.slice(0, 12)}`;
      const c: Case = { id, org, repo, number: n, head, base: pull.base.ref, me, before: first, gold };
      writeJson(join(dir, `${id}.json`), c);
      written++;
    }
    await commitMemory(orgDir(org), `replay: ${written} cases from your past reviews`);
    print({ cases: written, dir });
    return 0;
  },

  /** Scores an eval run (one draft per case) against the cases, and gates it against the accepted baseline. */
  async score(args) {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { label: { type: 'string' }, accept: { type: 'boolean' }, gate: { type: 'boolean' } } });
    const [org, runDir] = positionals;
    if (!org || !runDir) throw new Error('usage: sous score <org> <run-dir> [--label <text>] [--gate] [--accept]');
    const casesDir = join(orgDir(org), 'replay', 'cases');
    const scores = readdirSync(runDir)
      .filter((f) => f.endsWith('.json'))
      .flatMap((f) => {
        const id = f.replace(/\.json$/, '');
        const c = readJson<Case | null>(join(casesDir, f), null);
        if (!c) return [];
        const draft = readJson<{ findings?: Draft['findings'] }>(join(runDir, f), {});
        return [scoreCase(id, c.gold, draft.findings ?? [])];
      });
    if (scores.length === 0) throw new Error(`no drafts in ${runDir} match a case in ${casesDir}`);
    const now = totals(scores);
    const log = join(orgDir(org), 'replay', 'scores.jsonl');
    const history = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Totals & { accepted?: boolean }) : [];
    const baseline = [...history].reverse().find((h) => h.accepted) ?? null;
    const fails = gateFails(now, baseline);
    const accepted = Boolean(values.accept) && fails.length === 0;
    appendLine(log, { at: new Date().toISOString(), label: values.label ?? '', ...now, accepted });
    print({ ...now, baseline, fails, accepted, perCase: scores });
    return values.gate && fails.length ? 1 : 0;
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
