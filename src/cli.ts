import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { isPaused, loadConfig, loadProfile, saveConfig, saveProfile, type Config, type Profile } from './config.ts';
import { checkOutbound, ensureCanaries, otherOrgTerms } from './outbound.ts';
import { hiddenInDiff, stripHidden } from './hidden.ts';
import { CODEOWNERS_PATHS, parseCodeowners, unownedChanges } from './owners.ts';
import { findSkill } from './skills.ts';
import { findDue, patchId } from './due.ts';
import { gate, POLL_SECONDS, readCodeRabbit } from './gate.ts';
import { get, getAll, ghFor, send, whoami } from './gh.ts';
import { appendLine, meDir, orgDir, readJson, sousHome, writeJson } from './home.ts';
import { buildDenylist, findLeaks } from './leak.ts';
import { applyCorrections, isDuplicate, missingDecisions, verifyEvidence, type Correction } from './evidence.ts';
import { buildReview, dismissOwn, hasMarker, LintError, marker, postReview, signed, type Draft } from './post.ts';
import { commitAt, gateFails, lensRecall, meanTotals, parseAiReview, scoreCase, totals, type Case, type Gold, type Totals } from './replay.ts';
import { assertOwnThread, reviewThreads, sousHasLastWord, threadIdFor, type PrComment } from './threads.ts';
import { lintText } from './voice-lint.ts';
import { codeLinks, plan } from './plan.ts';
import { mergeUsage, spanSeconds, subagentLogs, usageByModel, type Usage } from './usage.ts';
import { checkScores, cycleTimes, qualityAverages, retro, runSummary } from './retro.ts';
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { diffTerms, factState, parseBullets, pinBullet, scopeMatches, searchMemory, type Bullet, type Cite } from './memory.ts';
import { AI_CONFIG, CONVENTION_FILES, isNoise, sparsePatterns } from './noise.ts';
import { askByHand, askedByHand, askedYou, emptyPr, loadState, logEvent, prKey, readEvents, releaseLock, releasePrLock, saveState, takeLock, takePrLock, type LoggedEvent } from './state.ts';

const run = promisify(execFile);

/** Refuses any text bound for GitHub that fails the outbound check (outbound.ts). */
function guardOutbound(org: string, profile: Profile, key: string, texts: string[]): void {
  ensureCanaries();
  const rules = { org, otherOrgTerms: otherOrgTerms(org), linkHosts: profile.linkHosts };
  const problems = texts.flatMap((t, i) => checkOutbound(t, rules).map((p) => (texts.length > 1 ? `comment ${i + 1}: ${p}` : p)));
  if (problems.length === 0) return;
  logEvent(org, 'outbound-refused', { pr: key, problems });
  throw new LintError(problems);
}
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

/** Every memory bullet for an org: its rules, system facts and candidates, then the lead's own habits. */
function memoryBullets(org: string): Bullet[] {
  const out: Bullet[] = [];
  for (const [label, dir] of [['org', orgDir(org)], ['me', meDir()]] as const) {
    for (const sub of label === 'org' ? ['rules', 'system', 'candidates'] : ['.']) {
      const d = join(dir, sub);
      if (!existsSync(d)) continue;
      for (const f of readdirSync(d).filter((x) => x.endsWith('.md'))) out.push(...parseBullets(`${label === 'me' ? 'me' : sub}/${f}`, readFileSync(join(d, f), 'utf8')));
    }
  }
  return out;
}

const commands: Record<string, (args: string[]) => Promise<number>> = {
  async init() {
    mkdirSync(meDir(), { recursive: true });
    const path = join(sousHome(), 'config.json');
    if (!existsSync(path)) saveConfig({ orgs: [], paused: false, maxReviewsPerRun: 3, attribution: 'From the AI reviewer', evalBudgetPerDay: 15, maxCommentsPerReview: 10 });
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
      postSuggestions: existing?.postSuggestions ?? false,
      linkHosts: existing?.linkHosts ?? [],
      skills: existing?.skills ?? [],
    });
    ensureCanaries();
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
    const { values } = parseArgs({ args, options: { org: { type: 'string' }, lock: { type: 'string' } } });
    const config = loadConfig();
    if (values.org && !config.orgs.includes(values.org)) throw new Error(`${values.org} is not a watched org; run \`sous org add ${values.org}\``);
    const started = new Date();
    const out = [];
    for (const org of values.org ? [values.org] : config.orgs) {
      // --lock <session>: skip an org another run is still working on.
      if (values.lock) {
        const lock = takeLock(org, values.lock, started);
        if (!lock.ok) {
          out.push({ org, locked: `another run (session ${lock.heldBy}) has held this org since ${lock.since}`, due: [], skipped: [] });
          continue;
        }
      }
      const profile = loadProfile(org);
      // Preflight: an org whose gh account can't sign in is blocked for this run, never guessed at.
      let gh: Awaited<ReturnType<typeof ghFor>>;
      let me: string;
      try {
        gh = await ghFor(profile.ghAccount);
        me = await whoami(gh);
      } catch (e) {
        const why = `gh account ${profile.ghAccount} is not signed in: ${(e as Error).message.slice(0, 200)}`;
        logEvent(org, 'blocked', { why });
        out.push({ org, blocked: why, paused: isPaused(config, org), postingMode: profile.postingMode, due: [], skipped: [] });
        continue;
      }
      const { due, skipped, rebased } = await findDue(gh, profile, loadState(org), me, started);
      for (const s of skipped) logEvent(org, 'skipped', s);
      // A rebase that changes nothing: record the new head, no review needed.
      if (rebased.length) {
        const state = loadState(org);
        for (const r of rebased) {
          const pr = state.prs[r.pr];
          if (pr) state.prs[r.pr] = { ...pr, head: r.head };
          logEvent(org, 'rebase-skip', r);
        }
        saveState(org, state);
      }
      for (const d of due.filter((d) => d.gate.action === 'defer')) logEvent(org, 'deferred', { pr: prKey(d.repo, d.number), head: d.head });
      out.push({ org, paused: isPaused(config, org), postingMode: profile.postingMode, due, skipped });
    }
    // Pick this run's reviews in code, so the cap holds whatever the prompt says.
    let budget = config.maxReviewsPerRun;
    const take = out.flatMap((o) => o.due.filter((d) => d.gate.action !== 'defer')).filter(() => budget-- > 0);
    print({ take: take.map((d) => ({ ...d, paused: isPaused(config, d.org) })), orgs: out });
    return 0;
  },

  /** Records a hand review (`/review <link>`), so `sous post` may post on a PR that never asked. Main session only. */
  async ask(args) {
    const [org, repo, n] = args;
    if (!org || !repo || !n) throw new Error('usage: sous ask <org> <owner/repo> <number>');
    if (!loadConfig().orgs.includes(org) || !repo.toLowerCase().startsWith(`${org.toLowerCase()}/`)) throw new Error(`${repo} is not in a watched org`);
    askByHand(org, prKey(repo, Number(n)));
    print({ asked: prKey(repo, Number(n)) });
    return 0;
  },

  /** Releases the run lock `sous due --lock` took, when this session holds it. */
  /** Claims one PR for this session's review; exits 3 when another session is reviewing it. */
  async 'pr-lock'(args) {
    const [org, repo, n, session] = args;
    if (!org || !repo || !n || !session) throw new Error('usage: sous pr-lock <org> <owner/repo> <number> <session id>');
    const key = prKey(repo, Number(n));
    const lock = takePrLock(org, key, session);
    print({ pr: key, ...lock });
    return lock.ok ? 0 : 3;
  },

  /** Frees a PR this session claimed. */
  async 'pr-unlock'(args) {
    const [org, repo, n, session] = args;
    if (!org || !repo || !n || !session) throw new Error('usage: sous pr-unlock <org> <owner/repo> <number> <session id>');
    const key = prKey(repo, Number(n));
    print({ pr: key, released: releasePrLock(org, key, session) });
    return 0;
  },

  async unlock(args) {
    const [org, session] = args;
    if (!org || !session) throw new Error('usage: sous unlock <org> <session>');
    print({ org, released: releaseLock(org, session) });
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
    // Fetches, and the blobs a partial clone downloads on demand, ask git's credential helper. The global
    // one is often the macOS keychain, which opens a password window per fetch; this clone uses gh's token.
    await run('git', ['config', '--local', '--unset-all', 'credential.helper'], { cwd: clone }).catch(() => undefined);
    await run('git', ['config', '--local', '--add', 'credential.helper', ''], { cwd: clone });
    await run('git', ['config', '--local', '--add', 'credential.helper', '!gh auth git-credential'], { cwd: clone });
    await run('git', ['fetch', '-q', 'origin', `pull/${n}/head`, `+refs/heads/${base}:refs/remotes/origin/${base}`], { cwd: clone, env });
    const tree = join(clone, '.worktrees', `${n}-${head.slice(0, 12)}`);
    // A checkout made before AI-config folders were excluded is rebuilt.
    if (existsSync(tree) && AI_CONFIG.some((p) => existsSync(join(tree, p)))) await run('git', ['worktree', 'remove', '--force', tree], { cwd: clone });
    if (!existsSync(tree)) {
      // The PR head's .claude/, .mcp.json and similar never reach an agent's working folder.
      // Their changes are still reviewed from the diff, and their base copies are read with git show.
      await run('git', ['worktree', 'add', '-q', '--no-checkout', '--detach', tree, head], { cwd: clone, env });
      await run('git', ['sparse-checkout', 'set', '--no-cone', ...sparsePatterns()], { cwd: tree });
      await run('git', ['checkout', '-q', '--detach', head], { cwd: tree });
    }
    const { stdout: baseFiles } = await run('git', ['ls-tree', '--name-only', `origin/${base}`], { cwd: clone });
    const conventions = CONVENTION_FILES.filter((f) => baseFiles.split('\n').includes(f));
    const { stdout: diff } = await run('git', ['diff', '-U0', '--no-ext-diff', `origin/${base}...${head}`], { cwd: clone, maxBuffer: 256 * 1024 * 1024 });
    print({ tree, baseRef: `origin/${base}`, readInstructionsWith: `git -C ${clone} show origin/${base}:<path>`, baseConventions: conventions, excludedFromCheckout: AI_CONFIG, hiddenCharacters: hiddenInDiff(diff) });
    return 0;
  },

  /** Changed paths whose CODEOWNERS owners nobody asked to review, read from the base branch. */
  async owners(args) {
    const [org, repo, n, base] = args;
    if (!org || !repo || !n || !base) throw new Error('usage: sous owners <org> <owner/repo> <number> <base>');
    const gh = await ghFor(loadProfile(org).ghAccount);
    const clone = join(sousHome(), 'cache', repo);
    let text = '';
    let source = '';
    for (const p of CODEOWNERS_PATHS) {
      try {
        text = execFileSync('git', ['show', `origin/${base}:${p}`], { cwd: clone, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        source = p;
        break;
      } catch {
        // Not at this path; GitHub reads the next one.
      }
    }
    if (!source) {
      print({ codeowners: null, unowned: [] });
      return 0;
    }
    const files = (await getAll<{ filename: string }>(gh, `repos/${repo}/pulls/${n}/files?per_page=100`)).map((f) => f.filename);
    const req = await get<{ users: { login: string }[]; teams: { slug: string }[] }>(gh, `repos/${repo}/pulls/${n}/requested_reviewers`);
    const reviewers = (await getAll<{ user: { login: string } | null }>(gh, `repos/${repo}/pulls/${n}/reviews?per_page=100`)).flatMap((r) => (r.user ? [r.user.login] : []));
    print({ codeowners: source, unowned: unownedChanges(parseCodeowners(text), files, { users: [...req.users.map((u) => u.login), ...reviewers], teams: req.teams.map((t) => t.slug) }) });
    return 0;
  },

  /** The installed convention skills (org profile `skills`) whose paths the PR touches, with their files. */
  async skills(args) {
    const [org, repo, n] = args;
    if (!org || !repo || !n) throw new Error('usage: sous skills <org> <owner/repo> <number>');
    const profile = loadProfile(org);
    const gh = await ghFor(profile.ghAccount);
    const files = (await getAll<{ filename: string }>(gh, `repos/${repo}/pulls/${n}/files?per_page=100`)).map((f) => f.filename);
    print(profile.skills.filter((s) => scopeMatches(s.paths, files)).map((s) => ({ name: s.name, file: findSkill(s.name) })));
    return 0;
  },

  /**
   * The PR's own words (title, body, reviews, comments) with hidden text removed, for the
   * gatherer's `.pr-text.md`. Replay passes --before and --exclude so the answers stay out.
   */
  async prtext(args) {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { before: { type: 'string' }, exclude: { type: 'string' } } });
    const [org, repo, n] = positionals;
    if (!org || !repo || !n) throw new Error('usage: sous prtext <org> <owner/repo> <number> [--before <iso>] [--exclude <login>]');
    const gh = await ghFor(loadProfile(org).ghAccount);
    type C = { user: { login: string } | null; body: string | null; created_at?: string; submitted_at?: string; path?: string; line?: number | null };
    const pull = await get<{ title: string; body: string | null; labels: { name: string }[] }>(gh, `repos/${repo}/pulls/${n}`);
    const keep = (c: C) => c.user?.login !== values.exclude && (!values.before || (c.created_at ?? c.submitted_at ?? '') < values.before);
    const sources: [string, C[]][] = [
      ['Conversation', await getAll<C>(gh, `repos/${repo}/issues/${n}/comments?per_page=100`)],
      ['Review bodies', (await getAll<C>(gh, `repos/${repo}/pulls/${n}/reviews?per_page=100`)).filter((r) => r.body)],
      ['Inline comments', await getAll<C>(gh, `repos/${repo}/pulls/${n}/comments?per_page=100`)],
    ];
    let removed = 0;
    const clean = (t: string | null): string => {
      const r = stripHidden(t ?? '');
      removed += r.removed;
      return r.text.trim();
    };
    const parts = [`# ${clean(pull.title)}`, `Labels: ${pull.labels.map((l) => l.name).join(', ') || 'none'}`, clean(pull.body) || '(no description)'];
    for (const [heading, items] of sources) {
      const shown = items.filter(keep);
      if (shown.length) parts.push(`## ${heading}`, ...shown.map((c) => `- ${c.user?.login ?? 'ghost'}${c.path ? ` on ${c.path}:${c.line ?? '?'}` : ''}${hasMarker(c.body) ? ' (Sous)' : ''}: ${clean(c.body).replace(/\n/g, '\n  ')}`));
    }
    parts.push(`Hidden content removed: ${removed} item(s).`);
    console.log(parts.join('\n\n'));
    return 0;
  },

  /**
   * The only way a review leaves the machine. Adopts an earlier post on the same head, checks every
   * finding's quotes against the real files, drops points Sous already made, allows one repair limited
   * to line, side, path and quote, then posts and gives back a review request the post consumed.
   */
  async post(args) {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { repair: { type: 'string' } } });
    const [file] = positionals;
    if (!file) throw new Error('usage: sous post <draft.json> [--repair <corrections.json>]');
    const draft = JSON.parse(readFileSync(file, 'utf8')) as Draft & { repaired?: boolean };
    const config = loadConfig();
    const profile = loadProfile(draft.org);
    const pending = isPaused(config, draft.org) || profile.postingMode === 'draft';
    const gh = await ghFor(profile.ghAccount);
    const me = await whoami(gh);
    const key = prKey(draft.repo, draft.number);
    const state = loadState(draft.org);
    const prev = state.prs[key] ?? emptyPr(draft.head);

    // A post whose response was lost already exists on this head: adopt it instead of posting twice.
    for (const r of await getAll<{ id: number; user: { login: string } | null; commit_id: string }>(gh, `repos/${draft.repo}/pulls/${draft.number}/reviews?per_page=100`)) {
      if (r.user?.login !== me || r.commit_id !== draft.head || prev.reviewIds.includes(r.id)) continue;
      const comments = await get<{ id: number; body: string }[]>(gh, `repos/${draft.repo}/pulls/${draft.number}/reviews/${r.id}/comments?per_page=100`);
      if (!comments.some((c) => c.body.includes(marker(draft.head)))) continue;
      state.prs[key] = { ...prev, head: draft.head, reviewedAt: new Date().toISOString(), reviewIds: [...prev.reviewIds, r.id], commentIds: [...prev.commentIds, ...comments.map((c) => c.id)] };
      saveState(draft.org, state);
      logEvent(draft.org, 'adopted', { pr: key, head: draft.head, reviewId: r.id, comments: comments.length });
      print({ pr: key, adopted: r.id });
      return 0;
    }

    const files = await getAll<{ filename: string; patch?: string }>(gh, `repos/${draft.repo}/pulls/${draft.number}/files?per_page=100`);
    const pull = await get<{ base: { ref: string }; state: string }>(gh, `repos/${draft.repo}/pulls/${draft.number}`);
    // The recipient is fixed by code, never by the draft: a watched org, an open PR, and one Sous already reviewed, Sivantha asked for by hand, or that asks for Sivantha's review by name or through a team.
    if (!config.orgs.includes(draft.org) || !draft.repo.toLowerCase().startsWith(`${draft.org.toLowerCase()}/`)) throw new Error(`${draft.repo} is not in a watched org; not posting`);
    if (pull.state !== 'open') throw new Error(`${key} is ${pull.state}; not posting`);
    const asked = async () =>
      askedYou(await get<{ users: { login: string }[]; teams: { slug: string }[] }>(gh, `repos/${draft.repo}/pulls/${draft.number}/requested_reviewers`), me, draft.org, await getAll<{ slug: string; organization: { login: string } }>(gh, 'user/teams?per_page=100'));
    if (!state.prs[key] && !askedByHand(draft.org, key) && !(await asked())) throw new Error(`${key} never asked for your review, by name or through your teams; not posting`);
    const clone = join(sousHome(), 'cache', draft.repo);
    if (!existsSync(clone)) throw new Error(`no clone at ${clone}; run sous checkout first`);
    const git = (...a: string[]): string | null => {
      try {
        return execFileSync('git', a, { cwd: clone, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
      } catch {
        return null;
      }
    };
    const base = git('merge-base', `origin/${pull.base.ref}`, draft.head)?.trim();
    const tree = (git('ls-tree', '-r', '--name-only', draft.head) ?? '').split('\n').filter(Boolean);
    const read = (side: 'RIGHT' | 'LEFT', path: string): string[] | null => {
      const sha = side === 'LEFT' ? base : draft.head;
      const text = sha ? git('show', `${sha}:${path}`) : null;
      return text === null ? null : text.split('\n');
    };

    let findings = draft.findings;
    const repairing = values.repair !== undefined;
    if (repairing) {
      if (draft.repaired) throw new Error('this draft was repaired once already; Sous allows one repair');
      findings = applyCorrections(findings, JSON.parse(readFileSync(values.repair!, 'utf8')) as Correction[]);
      writeJson(file, { ...draft, findings, repaired: true });
    }
    const checked = verifyEvidence(findings, { files, tree, read });
    const failing = new Set(checked.problems.map((p) => p.index));
    if (failing.size && !repairing) {
      const problems = checked.problems.map((p) => `#${p.index} ${p.problem}`);
      logEvent(draft.org, 'lint-refused', { pr: key, problems });
      throw new LintError([...problems, 'fix with one `sous post <draft> --repair <corrections.json>`: [{index, target: anchor|evidence|counterEvidence, item?, field: line|side|path|quote, value}]']);
    }
    // Points Sous already made on this PR are not made again.
    const existing = (await getAll<{ path: string; line: number | null; body: string }>(gh, `repos/${draft.repo}/pulls/${draft.number}/comments?per_page=100`)).filter((c) => hasMarker(c.body));
    const keep = checked.findings.filter((f, i) => !failing.has(i) && !existing.some((e) => isDuplicate(f, e)));
    const dropped = checked.findings.length - keep.length;
    if (dropped) logEvent(draft.org, 'dropped', { pr: key, failing: [...failing], duplicates: dropped - failing.size });
    if (keep.length === 0 && failing.size === 0) {
      // Every point is one Sous already made on this PR: the head is reviewed, nothing new to say.
      state.prs[key] = { ...prev, head: draft.head, reviewedAt: new Date().toISOString() };
      saveState(draft.org, state);
      logEvent(draft.org, 'reviewed', { pr: key, head: draft.head, event: 'NONE', findings: [], allDuplicates: dropped });
      print({ pr: key, event: 'NONE', dropped });
      return 0;
    }
    if (keep.length === 0) throw new Error('nothing left to post after checks; record the head with sous mark --verified');
    if (keep.length > config.maxCommentsPerReview) throw new LintError([`${keep.length} comments; at most ${config.maxCommentsPerReview} per review. Keep the most severe and drop the rest`]);

    let payload;
    try {
      payload = buildReview({ ...draft, findings: keep }, { pending, attribution: config.attribution, files, suggestions: profile.postSuggestions });
    } catch (e) {
      if (e instanceof LintError) logEvent(draft.org, 'lint-refused', { pr: key, problems: e.problems });
      throw e;
    }
    guardOutbound(draft.org, profile, key, payload.comments.map((c) => c.body));
    const requested = async () => (await get<{ users: { login: string }[] }>(gh, `repos/${draft.repo}/pulls/${draft.number}/requested_reviewers`)).users.map((u) => u.login);
    const wasRequested = (await requested()).includes(me);
    const { reviewId, commentIds } = await postReview(gh, { ...draft, findings: keep }, payload);
    // Submitting a review removes the request from your queue; give it back so the PR still waits on you.
    if (wasRequested && !(await requested()).includes(me)) {
      await send(gh, 'POST', `repos/${draft.repo}/pulls/${draft.number}/requested_reviewers`, { reviewers: [me] }).catch((e: Error) => logEvent(draft.org, 'request-not-restored', { pr: key, error: e.message.slice(0, 200) }));
    }
    state.prs[key] = { ...prev, head: draft.head, reviewedAt: new Date().toISOString(), reviewIds: [...prev.reviewIds, reviewId], commentIds: [...prev.commentIds, ...commentIds], ...(base ? { mergeBase: base } : {}), patchId: patchId(files) };
    saveState(draft.org, state);
    logEvent(draft.org, 'reviewed', { pr: key, head: draft.head, event: payload.event ?? 'PENDING', reviewId, findings: keep.map((f) => ({ severity: f.severity, path: f.path, line: f.line, id: f.id, memory: f.memory ?? [] })) });
    print({ pr: key, reviewId, event: payload.event ?? 'PENDING', comments: commentIds.length, dropped });
    return 0;
  },

  /** Records a head as reviewed with nothing to post. Requires the verifier's result, so a crash is never a clean review. */
  async mark(args) {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { verified: { type: 'string' } } });
    const [org, repo, n, head] = positionals;
    if (!org || !repo || !n || !head || !/^[0-9a-f]{40}$/.test(head) || !values.verified) throw new Error('usage: sous mark <org> <owner/repo> <number> <40-char head> --verified <verifier.json>');
    const v = JSON.parse(readFileSync(values.verified, 'utf8')) as { kept?: { ownerDecision?: boolean }[]; dropped?: unknown[] };
    if (!Array.isArray(v.kept) || !Array.isArray(v.dropped)) throw new Error('the verifier output has no kept and dropped lists; not marking the head as reviewed');
    if (v.kept.some((k) => !k.ownerDecision)) throw new Error('the verifier kept findings; post them instead of marking');
    const state = loadState(org);
    const key = prKey(repo, Number(n));
    state.prs[key] = { ...(state.prs[key] ?? emptyPr(head)), head, reviewedAt: new Date().toISOString() };
    saveState(org, state);
    logEvent(org, 'reviewed', { pr: key, head, event: 'NONE', findings: [], droppedByVerifier: v.dropped.length });
    print({ pr: key, head, event: 'NONE' });
    return 0;
  },

  /**
   * Fails unless every lens candidate id has exactly one verifier decision and every kept finding
   * still has counter-evidence (`sous post` refuses one without, and a repair can't add it back).
   */
  async decisions(args) {
    const [verifiedFile, ...lensFiles] = args;
    if (!verifiedFile || lensFiles.length === 0) throw new Error('usage: sous decisions <verified.json> <lens.json...>');
    const ids = lensFiles.flatMap((f) => (JSON.parse(readFileSync(f, 'utf8')) as { candidates?: { id?: string }[] }).candidates ?? []).map((c, i) => c.id ?? `missing-id-${i}`);
    const verified = JSON.parse(readFileSync(verifiedFile, 'utf8')) as { kept?: { id?: string; merged?: string[]; counterEvidence?: unknown[] }[]; dropped?: { id?: string }[] };
    const noCounterEvidence = (verified.kept ?? []).filter((k) => !k.counterEvidence?.length).map((k) => k.id ?? '?');
    // Listed in `missing` too, so the one resend the review already makes covers them.
    const missing = [...missingDecisions(ids, verified), ...noCounterEvidence];
    print({ candidates: ids.length, missing, noCounterEvidence });
    return missing.length ? 1 : 0;
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
    guardOutbound(org, profile, key, [text]);
    const gh = await ghFor(profile.ghAccount);
    const body = signed(text, config.attribution, pr.head);
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
    const resolved = new Set((await reviewThreads(gh, repo, Number(n))).filter((t) => t.isResolved).map((t) => t.firstCommentId));
    print({
      head: pr.head,
      reviews: reviews.filter((r) => pr.reviewIds.includes(r.id)).map((r) => ({ id: r.id, state: r.state, commit: r.commit_id })),
      blocking: reviews.filter((r) => pr.reviewIds.includes(r.id) && r.state === 'CHANGES_REQUESTED').map((r) => r.id),
      findings: comments
        .filter((c) => pr.commentIds.includes(c.id))
        .map((c) => ({ id: c.id, path: c.path, line: c.line, outdated: c.line === null, resolved: resolved.has(c.id), sousHasLastWord: sousHasLastWord(comments, pr, c.id), body: c.body.split('\n\n')[0], sous: hasMarker(c.body) })),
    });
    return 0;
  },

  async dismiss(args) {
    const [org, repo, n, id, ...message] = args;
    if (!org || !repo || !n || !id || message.length === 0) throw new Error('usage: sous dismiss <org> <owner/repo> <number> <review-id> <message>');
    const profile = loadProfile(org);
    const gh = await ghFor(profile.ghAccount);
    guardOutbound(org, profile, prKey(repo, Number(n)), [message.join(' ')]);
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
  /**
   * Scores eval runs against their cases. Loops over the cases the run was given (its run.json), so
   * a case that crashed or wrote no draft scores zero instead of dropping out. Several run folders of
   * the same cases are averaged before the gate. Reports, per case, how many gold points any lens came
   * near against how many survived, so lost recall can be traced to the lenses or the verifier.
   */
  async score(args) {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { label: { type: 'string' }, accept: { type: 'boolean' }, gate: { type: 'boolean' } } });
    const [org, ...runDirs] = positionals;
    if (!org || runDirs.length === 0) throw new Error('usage: sous score <org> <run-dir> [more run-dirs of the same cases] [--label <text>] [--gate] [--accept]');
    const casesDir = join(orgDir(org), 'replay', 'cases');
    const runs = runDirs.map((runDir) => {
      const meta = readJson<{ cases?: string[] } & Record<string, unknown>>(join(runDir, 'run.json'), {});
      // Older runs have no manifest: fall back to the drafts present.
      const ids = meta.cases ?? readdirSync(runDir).filter((f) => /^[\w-]+\.json$/.test(f) && !/\.(judge|verified)\.json$|^run\.json$/.test(f) && !f.includes('.lens-')).map((f) => f.replace(/\.json$/, ''));
      const scores = ids.flatMap((id) => {
        const c = readJson<Case | null>(join(casesDir, `${id}.json`), null);
        if (!c) return [];
        const draft = readJson<{ findings?: Draft['findings'] }>(join(runDir, `${id}.json`), {});
        const judge = readJson<{ pairs?: [number, number][] }>(join(runDir, `${id}.judge.json`), {});
        const candidates = readdirSync(runDir).filter((f) => f.startsWith(`${id}.lens-`)).flatMap((f) => (readJson<{ candidates?: { path: string; line: number; claim?: string }[] }>(join(runDir, f), {}).candidates ?? []).map((x) => ({ path: x.path, line: x.line, body: x.claim ?? '' })));
        return [{ ...scoreCase(id, c.gold, draft.findings ?? [], 10, judge.pairs ?? []), missingDraft: !existsSync(join(runDir, `${id}.json`)), nearByLenses: lensRecall(c.gold, candidates) }];
      });
      return { runDir, provenance: meta, totals: totals(scores), scores };
    });
    if (runs.every((r) => r.scores.length === 0)) throw new Error(`no cases scored in ${runDirs.join(', ')}`);
    const now = meanTotals(runs.map((r) => r.totals));
    const log = join(orgDir(org), 'replay', 'scores.jsonl');
    const history = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Totals & { accepted?: boolean }) : [];
    const baseline = [...history].reverse().find((h) => h.accepted) ?? null;
    const fails = gateFails(now, baseline);
    const accepted = Boolean(values.accept) && fails.length === 0;
    appendLine(log, { at: new Date().toISOString(), label: values.label ?? '', ...now, runs: runs.length, accepted, provenance: runs[0]?.provenance ?? {} });
    print({ ...now, runs: runs.map((r) => ({ runDir: r.runDir, ...r.totals })), baseline, fails, accepted, perCase: runs.flatMap((r) => r.scores) });
    return values.gate && fails.length ? 1 : 0;
  },

  /**
   * Starts an eval: one run folder per repeat, each with run.json (the cases, the engine commit, a
   * hash of the prompts and agents, the memory commit). Refuses when the day's eval budget is spent.
   */
  async evalrun(args) {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { cases: { type: 'string' }, repeat: { type: 'string' } } });
    const [org, label] = positionals;
    if (!org || !label || !values.cases) throw new Error('usage: sous evalrun <org> <label> --cases a,b,c [--repeat 3]');
    const cases = values.cases.split(',').filter(Boolean);
    const repeat = Number(values.repeat ?? 3);
    const config = loadConfig();
    const today = new Date().toISOString().slice(0, 10);
    const log = join(orgDir(org), 'events.jsonl');
    const usedToday = (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []).map((l) => JSON.parse(l) as { at: string; type: string; caseRuns?: number }).filter((e) => e.type === 'eval-started' && e.at.startsWith(today)).reduce((n, e) => n + (e.caseRuns ?? 0), 0);
    const want = cases.length * repeat;
    if (usedToday + want > config.evalBudgetPerDay) throw new Error(`eval budget: ${usedToday} of ${config.evalBudgetPerDay} case-runs used today; this needs ${want}. Raise evalBudgetPerDay in config.json or wait until tomorrow.`);
    const here = join(import.meta.dirname, '..');
    const engine = (await run('git', ['rev-parse', 'HEAD'], { cwd: here })).stdout.trim();
    const prompts = createHash('sha256');
    for (const d of ['prompts/lenses', '.claude/agents', '.claude/commands']) for (const f of readdirSync(join(here, d)).sort()) prompts.update(readFileSync(join(here, d, f)));
    const memory = (await run('git', ['rev-parse', 'HEAD'], { cwd: orgDir(org) }).catch(() => ({ stdout: 'none' }))).stdout.trim();
    const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
    const dirs = Array.from({ length: repeat }, (_, i) => join(orgDir(org), 'replay', 'runs', `${stamp}-${label.replace(/[^\w-]/g, '-')}-r${i + 1}`));
    for (const [i, dir] of dirs.entries()) {
      mkdirSync(dir, { recursive: true });
      writeJson(join(dir, 'run.json'), { org, label, cases, repeat: i + 1, of: repeat, engine, prompts: prompts.copy().digest('hex').slice(0, 16), memory, started: new Date().toISOString() });
    }
    logEvent(org, 'eval-started', { label, caseRuns: want, dirs });
    print({ dirs, caseRuns: want, budgetLeftToday: config.evalBudgetPerDay - usedToday - want });
    return 0;
  },

  /**
   * Turns a benchmark file you supply (public PRs with their golden comments) into replay cases in a
   * separate `bench` org, so Sous's general bug-finding can be checked beside its fit to you.
   * Input: [{ repo, number, head, base, comments: [{ path, line, body }] }].
   */
  async bench(args) {
    const [sub, file] = args;
    if (sub !== 'import' || !file) throw new Error('usage: sous bench import <benchmark.json>');
    const items = JSON.parse(readFileSync(file, 'utf8')) as { repo: string; number: number; head: string; base: string; comments: { path: string; line: number; body: string }[] }[];
    const dir = join(orgDir('bench'), 'replay', 'cases');
    mkdirSync(dir, { recursive: true });
    for (const it of items) {
      const id = `${it.repo.split('/')[1]}-${it.number}-${it.head.slice(0, 12)}`;
      const c: Case = { id, org: 'bench', repo: it.repo, number: it.number, head: it.head, base: it.base, me: '', before: new Date().toISOString(), gold: it.comments.map((g) => ({ path: g.path, line: g.line, text: g.body.slice(0, 500), source: 'inline' })) };
      writeJson(join(dir, `${id}.json`), c);
    }
    print({ cases: items.length, dir });
    return 0;
  },

  /**
   * `sous memory <org> <repo> <n>`: the memory bullets for a PR, by scope and by the names the diff touches, ranked.
   * `sous memory hits <org>`: when each bullet last drove a posted finding, for pruning.
   */
  async memory(args) {
    if (args[0] === 'hits') {
      const org = args[1];
      if (!org) throw new Error('usage: sous memory hits <org>');
      const hits = new Map<string, { count: number; last: string }>();
      const log = join(orgDir(org), 'events.jsonl');
      for (const line of existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []) {
        const e = JSON.parse(line) as { type: string; at: string; findings?: { memory?: string[] }[] };
        if (e.type !== 'reviewed') continue;
        for (const ref of (e.findings ?? []).flatMap((f) => f.memory ?? [])) hits.set(ref, { count: (hits.get(ref)?.count ?? 0) + 1, last: e.at });
      }
      print(Object.fromEntries([...hits.entries()].sort((a, b) => b[1].last.localeCompare(a[1].last))));
      return 0;
    }
    const [org, repo, n] = args;
    if (!org || !repo || !n) throw new Error('usage: sous memory <org> <owner/repo> <number> | sous memory hits <org>');
    const profile = loadProfile(org);
    const gh = await ghFor(profile.ghAccount);
    const files = (await getAll<{ filename: string; patch?: string }>(gh, `repos/${repo}/pulls/${n}/files?per_page=100`)).filter((f) => !isNoise(f.filename));
    const bullets = memoryBullets(org);
    const hits = searchMemory(bullets, files.map((f) => f.filename), diffTerms(files));
    print(hits.map((h) => ({ at: `${h.bullet.file}:${h.bullet.line}`, score: h.score, trust: h.bullet.trust, matchedBy: h.matchedBy, text: h.bullet.raw })));
    return 0;
  },

  /**
   * Checks every cited fact against the repo: `stale` when its file changed after the pinned commit,
   * `gone` when the file no longer exists. `--pin` records today's commit on unpinned cites;
   * `--retire` removes bullets whose every cited file is gone. Changes are committed to memory.
   */
  async facts(args) {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { pin: { type: 'boolean' }, retire: { type: 'boolean' } } });
    const [org] = positionals;
    if (!org) throw new Error('usage: sous facts <org> [--pin] [--retire]');
    const profile = loadProfile(org);
    const gh = await ghFor(profile.ghAccount);
    const defaultRepo = profile.ruleSources[0]?.split(':')[0];
    const latestCache = new Map<string, string | null | 'deleted'>();
    const latest = async (c: Cite): Promise<string | null | 'deleted'> => {
      const repo = c.repo ?? defaultRepo;
      if (!repo) return null;
      const key = `${repo}:${c.path}`;
      if (!latestCache.has(key)) {
        const commits = await get<{ sha: string }[]>(gh, `repos/${repo}/commits?path=${encodeURIComponent(c.path)}&per_page=1`).catch(() => []);
        const exists = await get(gh, `repos/${repo}/contents/${c.path}`).then(() => true, () => false);
        latestCache.set(key, exists ? (commits[0]?.sha ?? null) : 'deleted');
      }
      return latestCache.get(key)!;
    };
    const report: { at: string; state: string; cite: string }[] = [];
    let changed = 0;
    for (const dir of ['rules', 'system', 'candidates']) {
      const d = join(orgDir(org), dir);
      if (!existsSync(d)) continue;
      for (const f of readdirSync(d).filter((x) => x.endsWith('.md'))) {
        const path = join(d, f);
        const lines = readFileSync(path, 'utf8').split('\n');
        for (const b of parseBullets(`${dir}/${f}`, lines.join('\n')).filter((b) => b.cites.length)) {
          const states = await Promise.all(b.cites.map(async (c) => ({ c, s: factState(c, await latest(c)), sha: await latest(c) })));
          for (const { c, s } of states) if (s !== 'current') report.push({ at: `${b.file}:${b.line}`, state: s, cite: `${c.repo ?? defaultRepo}:${c.path}${c.sha ? `@${c.sha}` : ''}` });
          if (values.retire && states.every((x) => x.s === 'gone')) {
            lines[b.line - 1] = '\u0000';
            changed++;
          } else if (values.pin && states.some((x) => x.s === 'unpinned')) {
            lines[b.line - 1] = pinBullet(b.raw, states.map(({ c, s, sha }) => (s === 'unpinned' && typeof sha === 'string' ? { ...c, sha } : c)));
            changed++;
          }
        }
        writeFileSync(path, lines.filter((l) => l !== '\u0000').join('\n'));
      }
    }
    if (changed) await commitMemory(orgDir(org), `facts: ${values.retire ? 'retire facts whose files are gone' : ''}${values.pin ? ' pin unpinned cites' : ''}`.trim());
    print({ changed, notCurrent: report });
    return 0;
  },

  /**
   * Token use per subagent for one Claude Code session, read from its transcripts. Defaults to the
   * newest session run from this folder. With --org, logs it as a usage event.
   */
  async tokens(args) {
    const { values } = parseArgs({ args, options: { session: { type: 'string' }, org: { type: 'string' }, label: { type: 'string' }, cwd: { type: 'string' } } });
    const projects = join(homedir(), '.claude', 'projects', (values.cwd ?? process.cwd()).replace(/[^A-Za-z0-9]/g, '-'));
    if (!existsSync(projects)) throw new Error(`no Claude Code transcripts at ${projects}`);
    const session =
      values.session ??
      readdirSync(projects)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => ({ id: f.replace(/\.jsonl$/, ''), t: statSync(join(projects, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t)[0]?.id;
    if (!session) throw new Error('no sessions found');
    const mainLog = readFileSync(join(projects, `${session}.jsonl`), 'utf8');
    const byAgent: Record<string, Record<string, Usage>> = { main: usageByModel(mainLog) };
    // Wall time: the main session's span is the run's; a type's is the sum of its subagents' spans.
    const seconds: Record<string, number> = { main: spanSeconds(mainLog) };
    const subDir = join(projects, session, 'subagents');
    for (const f of subagentLogs(subDir)) {
      const meta = readJson<{ agentType?: string }>(f.replace(/\.jsonl$/, '.meta.json'), {});
      const type = meta.agentType ?? 'unknown';
      const log = readFileSync(f, 'utf8');
      byAgent[type] = mergeUsage(byAgent[type] ?? {}, usageByModel(log));
      seconds[type] = (seconds[type] ?? 0) + spanSeconds(log);
    }
    const totals = Object.values(byAgent).reduce((t, u) => mergeUsage(t, u), {} as Record<string, Usage>);
    if (values.org) logEvent(values.org, 'usage', { session, label: values.label ?? '', byAgent, totals, seconds });
    print({ session, byAgent, totals, seconds });
    return 0;
  },

  /**
   * A cache key for one stage of an eval case: the same head, base, prompts and memory give the same
   * key, so a rerun reuses the stage's output instead of paying for it again.
   */
  async stagekey(args) {
    const [org, stage, head, lens] = args;
    if (!org || !stage || !head) throw new Error('usage: sous stagekey <org> <gatherer|lens|verifier> <head> [lens]');
    const here = join(import.meta.dirname, '..');
    const hashFile = (p: string) => (existsSync(p) ? createHash('sha256').update(readFileSync(p)).digest('hex') : 'none');
    const memoryHead = (await run('git', ['rev-parse', 'HEAD'], { cwd: orgDir(org) }).catch(() => ({ stdout: 'none' }))).stdout.trim();
    const parts = [stage, lens ?? '', head, hashFile(join(here, '.claude', 'agents', `${stage}.md`)), lens ? hashFile(join(here, 'prompts', 'lenses', `${lens}.md`)) : '', hashFile(join(meDir(), 'habits.md')), memoryHead];
    const key = createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 24);
    const path = join(sousHome(), 'cache', 'stages', `${key}.json`);
    print({ key, path, cached: existsSync(path) });
    return 0;
  },

  /** What Sous has done in an org, from its event log: reviews, findings, refusals, drops and token use. */
  async stats(args) {
    const [org, sinceArg] = args;
    if (!org) throw new Error('usage: sous stats <org> [since ISO date]');
    const since = sinceArg ?? new Date(Date.now() - 30 * 86_400_000).toISOString();
    const events = readEvents(org).filter((e) => e.at >= since) as { at: string; type: string; event?: string; findings?: { severity: string }[]; totals?: Record<string, Usage> }[];
    const count = (f: (e: (typeof events)[number]) => boolean) => events.filter(f).length;
    const severities: Record<string, number> = {};
    for (const e of events.filter((e) => e.type === 'reviewed')) for (const f of e.findings ?? []) severities[f.severity] = (severities[f.severity] ?? 0) + 1;
    const tokens = events.filter((e) => e.type === 'usage').reduce((t, e) => mergeUsage(t, e.totals ?? {}), {} as Record<string, Usage>);
    // One read per PR Sous reviewed in the window, for when it opened and merged.
    const gh = await ghFor(loadProfile(org).ghAccount);
    const prTimes: Record<string, { createdAt: string; mergedAt: string | null }> = {};
    for (const pr of new Set(events.filter((e) => e.type === 'reviewed').map((e) => (e as { pr?: string }).pr).filter((p): p is string => !!p))) {
      const [repo, n] = pr.split('#');
      const p = await get<{ created_at: string; merged_at: string | null }>(gh, `repos/${repo}/pulls/${n}`).catch(() => null);
      if (p) prTimes[pr] = { createdAt: p.created_at, mergedAt: p.merged_at };
    }
    print({
      since,
      reviews: { posted: count((e) => e.type === 'reviewed' && e.event !== 'NONE'), nothingToPost: count((e) => e.type === 'reviewed' && e.event === 'NONE'), requestChanges: count((e) => e.event === 'REQUEST_CHANGES') },
      findings: severities,
      refusedByLint: count((e) => e.type === 'lint-refused'),
      droppedAtPost: count((e) => e.type === 'dropped'),
      rebaseSkips: count((e) => e.type === 'rebase-skip'),
      replies: count((e) => e.type === 'replied'),
      resolved: count((e) => e.type === 'resolved'),
      dismissed: count((e) => e.type === 'dismissed'),
      quality: qualityAverages(events as LoggedEvent[]),
      cycle: cycleTimes(events as LoggedEvent[], prTimes),
      tokens,
    });
    return 0;
  },

  /** The last run for the learning round: its problems, its cost and time, and the recent median. */
  async retro(args) {
    const [org, since] = args;
    if (!org || !since || Number.isNaN(Date.parse(since))) throw new Error('usage: sous retro <org> <run start ISO time>');
    print(retro(readEvents(org), since));
    return 0;
  },

  /** The run's last message: each PR it touched, linked, with the comments, replies and resolved threads it posted. */
  async summary(args) {
    const [org, since] = args;
    if (!org || !since || Number.isNaN(Date.parse(since))) throw new Error('usage: sous summary <org> <run start ISO time>');
    console.log(runSummary(readEvents(org), since));
    return 0;
  },

  /** Logs the review-judge's scores for this run's reviews, after checking every score is there and in range. */
  async quality(args) {
    const [org, file] = args;
    if (!org || !file) throw new Error('usage: sous quality <org> <scores.json>');
    const reviews = checkScores(JSON.parse(readFileSync(file, 'utf8')));
    for (const r of reviews) logEvent(org, 'scored', { pr: r.pr, scores: r.scores, low: r.low });
    print({ scored: reviews.length, low: reviews.filter((r) => r.low.length).map((r) => r.pr) });
    return 0;
  },

  /** How deep to review: lenses, the missed pass and risk drivers, from the changed paths alone. */
  async plan(args) {
    const [org, repo, n] = args;
    if (!org || !repo || !n) throw new Error('usage: sous plan <org> <owner/repo> <number>');
    const profile = loadProfile(org);
    const gh = await ghFor(profile.ghAccount);
    const pull = await get<{ body: string | null; base: { ref: string }; head: { repo: { default_branch: string } | null } }>(gh, `repos/${repo}/pulls/${n}`);
    const files = (await getAll<{ filename: string; additions: number; deletions: number }>(gh, `repos/${repo}/pulls/${n}/files?per_page=100`)).filter((f) => !isNoise(f.filename));
    const stacked = pull.base.ref !== (pull.head.repo?.default_branch ?? 'main');
    print(plan(files, { stacked, orgRules: profile.ruleSources.length > 0, body: stripHidden(pull.body ?? '').text }));
    return 0;
  },

  /**
   * Freezes code the PR body and its linked issues point to, pinned to a commit, as evidence.
   * Never copies a private repo's code into a review of a public repo.
   */
  async links(args) {
    const [org, repo, n] = args;
    if (!org || !repo || !n) throw new Error('usage: sous links <org> <owner/repo> <number>');
    const profile = loadProfile(org);
    const gh = await ghFor(profile.ghAccount);
    const pull = await get<{ body: string | null }>(gh, `repos/${repo}/pulls/${n}`);
    const prRepo = await get<{ private: boolean }>(gh, `repos/${repo}`);
    let text = pull.body ?? '';
    for (const m of text.matchAll(/(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|refs?)\s+#(\d+)/gi)) {
      text += `\n${(await get<{ body: string | null }>(gh, `repos/${repo}/issues/${m[1]}`).catch(() => ({ body: '' }))).body ?? ''}`;
    }
    const dir = join(orgDir(org), 'drafts', `${repo.split('/')[1]}-${n}-links`);
    mkdirSync(dir, { recursive: true });
    const saved: { link: string; sha: string; file: string }[] = [];
    const skipped: { link: string; why: string }[] = [];
    for (const l of codeLinks(text).slice(0, 10)) {
      const link = `${l.owner}/${l.repo}@${l.ref}:${l.path}`;
      const target = await get<{ private: boolean }>(gh, `repos/${l.owner}/${l.repo}`).catch(() => null);
      if (!target) {
        skipped.push({ link, why: 'repo not readable' });
        continue;
      }
      if (target.private && !prRepo.private) {
        skipped.push({ link, why: 'private code is never copied into a public repo review' });
        continue;
      }
      // A ref with slashes (a branch like agent/x) is tried at each split point.
      const parts = `${l.ref}/${l.path}`.split('/');
      let done = false;
      for (let i = 1; i < parts.length && !done; i++) {
        const ref = parts.slice(0, i).join('/');
        const path = parts.slice(i).join('/');
        const commit = await get<{ sha: string }>(gh, `repos/${l.owner}/${l.repo}/commits/${encodeURIComponent(ref)}`).catch(() => null);
        if (!commit) continue;
        const content = await get<{ content?: string; encoding?: string }>(gh, `repos/${l.owner}/${l.repo}/contents/${path}?ref=${commit.sha}`).catch(() => null);
        if (!content?.content) continue;
        const lines = Buffer.from(content.content, 'base64').toString('utf8').split('\n');
        const [from, to] = l.lines ?? [1, lines.length];
        const file = join(dir, `${l.owner}__${l.repo}__${path.replaceAll('/', '__')}@${commit.sha.slice(0, 12)}`);
        writeFileSync(file, lines.slice(Math.max(0, from - 21), to + 20).map((t, k) => `${Math.max(1, from - 20) + k}\t${t}`).join('\n'));
        saved.push({ link, sha: commit.sha, file });
        done = true;
      }
      if (!done) skipped.push({ link, why: 'ref or path not found' });
    }
    print({ saved, skipped });
    return 0;
  },

  /** Prints which of the given paths are noise (lockfiles, generated output), one per line. */
  async noise(args) {
    for (const p of args.filter(isNoise)) console.log(p);
    return 0;
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
