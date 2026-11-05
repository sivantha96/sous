# Sous

A PR reviewer that reviews the way you do, posts under your account, and learns from every review.

Only the engine lives here. Everything Sous learns lives in `~/.sous` on your machine and is never pushed:

```
~/.sous/
  config.json          orgs to watch, pause switch, reviews per run, the attribution line
  me/                  your voice and habits, the same in every org (local git)
  orgs/<org>/          one org's profile, rules, facts, examples, replay set, events, questions (local git)
  cache/               read-only clones; nothing in them is ever run
```

## Setup

1. `pnpm install`
2. `./bin/sous init`
3. `./bin/sous org add <org>` (add `--draft` to start an org with pending reviews only)
4. Run Claude Code in this folder and try `/review <org> <owner/repo> <number>`.
5. Schedule `/run` every 15 minutes as a Claude Code desktop scheduled task with this folder as its working directory.

## Commands

| Command | Does |
|---|---|
| `sous due` | Finds PRs due in every org, reads CodeRabbit's state, picks this run's PRs (capped by `maxReviewsPerRun`). No model tokens. A PR is due when it is new, was pushed, has replies on Sous's threads, or was re-requested by someone else after Sous's last review with no push (`REREQUESTED`). An org whose gh account can't sign in is listed as `blocked`; a PR that errors is listed as skipped, and the rest still run |
| `sous gate` | Waits for CodeRabbit on one PR, polling every 3 minutes |
| `sous checkout` | Read-only worktree of a PR head, without `.claude/`, `.mcp.json` and other AI-config paths (their changes are reviewed from the diff, their base copies read with `git show`). Also lists added lines that carry invisible or bidi characters (`hiddenCharacters`) |
| `sous prtext` | The PR's title, body, reviews and comments with HTML comments and invisible characters removed, for the gatherer's `.pr-text.md`. The guard keeps the verifier and writer from reading that file |
| `sous owners` | Changed paths whose CODEOWNERS owners (from the base branch, last match wins) nobody asked to review |
| `sous skills` | The installed Claude Code skills the org profile lists (`skills`: name and paths) that match the PR's paths, with each SKILL.md |
| `sous noise` | Prints which paths are lockfiles or generated output |
| `sous plan` | Risk score, drivers, lenses, the missed pass and file order, from the changed paths alone (no model call) |
| `sous memory` | Memory bullets for a PR, by scope and by the names the diff touches, ranked; `sous memory hits <org>` shows when each bullet last drove a posted finding |
| `sous facts` | Checks cited facts against the repo: stale (file changed since the pinned commit) or gone; `--pin` records commits, `--retire` removes facts whose files are gone |
| `sous links` | Freezes code the PR body and linked issues point to, pinned to a commit; never copies private code into a public repo review |
| `sous post` | The only way a review leaves the machine. Adopts an earlier post on the same head; checks every anchor, evidence and counter-evidence quote against the real files (moving a miscounted line within 3, completing a shortened path); drops points Sous already made; allows one `--repair` limited to line, side, path and quote; posts inline comments only, on added or removed lines, with the attribution and marker; COMMENT or REQUEST_CHANGES, never APPROVE; gives back your review request |
| `sous decisions` | Fails unless every lens candidate id has exactly one verifier decision |
| `sous mark` | Records a head reviewed with nothing to post; needs the verifier result (`--verified`) |
| `sous dismiss` | Dismisses a request-changes review, only one Sous wrote |
| `sous leak-check` | Fails when text bound for git names anything from local org memory |
| `sous reply` / `resolve` | Replies in, or resolves, a thread Sous started; refuses any other thread |
| `sous seen` | Marks teammate replies and reactions as judged |
| `sous status` | Sous's reviews, blocking reviews and findings on one PR |
| `sous replay build` | Builds replay cases from your past reviews in an org |
| `sous evalrun` | Starts an eval: one run folder per repeat with the cases, engine commit, prompt hash and memory commit; refuses past the daily budget (`evalBudgetPerDay`) |
| `sous score` | Scores eval runs: every listed case counts (a missing draft scores zero), repeats are averaged, and each case shows points lenses came near against points kept; `--gate` fails on a drop, `--accept` sets the baseline |
| `sous bench import` | Turns a benchmark file you supply into cases in a separate `bench` org |
| `sous tokens` | Token use and running time per subagent and model for a session, from Claude Code transcripts; `--org` logs it |
| `sous retro` | The last run for the learning round: its reviews, problems (refusals, skips, blocks, deferrals), paid tokens and minutes, next to the median of the 10 runs before it. No model tokens |
| `sous stagekey` | Cache key for one eval stage (same head, prompts and memory, same key), so reruns reuse it |
| `sous stats` | Reviews, findings, refusals, drops, replies and tokens from the event log; `/stats` answers questions from it |
| `sous pause [org]` / `resume [org]` | Stops posting; reviews become pending drafts |

## Subagents

| Subagent | Model | Job |
|---|---|---|
| `gatherer` | Haiku | Context bundle: diff, comments, CI, base-branch rules, local memory, cross-repo impact |
| `lens` | Sonnet | One lens from `prompts/lenses/`, run in parallel |
| `verifier` | Opus | Re-reads every candidate at the head; drops what it can't prove |
| `writer` | Opus | Writes the review in your voice and runs `sous post` |
| `signal-collector` | Haiku | What changed since the last learning round |
| `match-judge` | Haiku | In `/eval`, pairs your points with Sous findings that make the same point anywhere |
| `reply-judge` | Sonnet, Opus for hard cases | Weighs teammates' replies and reactions: adopts, withdraws, answers once, or asks you |
| `reflector` | Opus | Reviews the run (problems, tokens and time against recent runs) and the signals: memory edits behind the replay gate, engine PRs, questions for you. Skipped when a run had no signals, no problems and a normal cost |

## Rules this code enforces

- Never approves: `APPROVE` is not a value the review type can hold, and `postReview` refuses it at run time.
- Requests changes for any major finding; minors and nits only comment.
- Paused orgs and orgs in draft mode get pending reviews.
- Dismisses only its own reviews: posted by your account, carrying the Sous marker, and recorded in state.
- Text that fails the voice lint is never posted.
- Memory bullets under `candidates/`, or marked `(trust: teammate)`, rank below the lead's rules and never override one. A teammate's candidate becomes a rule only after Sivantha says yes in `questions.md`.
- Every comment, reply and dismissal passes `src/outbound.ts` first. Any of these is refused: a name from another watched org, the canary line `sous` keeps at the top of every memory file, a link outside `github.com/<org>/` and the profile's `linkHosts`, or a link with a query string.
- `sous post` posts only to an open PR in a watched org that asked for your review or that Sous reviewed before. It posts at most `maxCommentsPerReview` comments (default 10).
- `.claude/settings.json` blocks agents from writing to GitHub except through `sous`.

`pnpm check` runs the typecheck and tests.

## The guard

`bin/sous-guard` is a PreToolUse hook (`.claude/settings.json`) on every Bash, Read, Grep, Glob, Write, Edit and NotebookEdit call, in the main session and in every subagent. Claude Code tells it which subagent is calling (`agent_type`), and `src/guard.ts` applies that role's policy:

| Role | Subagents | May run |
|---|---|---|
| reader | gatherer, lens, verifier, match-judge, signal-collector, and any unknown one | read-only commands (`src/vendor/shell-policy.ts`), read-only `git` and `gh`, read-only `sous` commands |
| writer | writer | the same, plus `sous post` and `sous mark` |
| reply-judge | reply-judge | the same, plus `sous reply`, `resolve` and `seen` |
| reflector | reflector | the same, plus git commits and pushes (never forced), `gh pr create`, `pnpm check` |
| main | the orchestrating session | anything but network tools and commands that print credentials |

No role may use `curl`, `wget`, `ssh` or other network tools, print a credential (`gh auth token`, `printenv`, a bare `env`, keychain and Doppler reads), point `gh` at a host other than github.com, or read credentials and env files (`.env.example` excepted), including through a symlink.

Writes (`checkWrite`):
- No role writes a credential or env file, or anything inside a `.git` folder.
- No role writes Sous's own guard rails: `src/guard.ts`, `src/outbound.ts`, `src/published.ts`, `src/post.ts`, `src/vendor/`, `bin/sous-guard` and `.claude/settings*.json`. The main session may, but only when you start it with `SOUS_ENGINE_EDIT=1`.
- Subagents write only under `~/.sous` and the temp folder. The reflector may also write in this repo. `src/vendor/shell-policy.ts` is copied from vercel-labs/knowledge-agent-template under MIT; its notice is in the file.

## The sandbox

The guard checks commands by name, so `node -e "fetch(…)"` from the main session would get past it. `.claude/settings.json` therefore also turns on Claude Code's sandbox:
- **Writes:** only to `~/.sous`, the working folder and the temp folder.
- **Reads:** never from `~/.ssh`, `~/.aws`, `~/.config/gh`, Doppler's files, `.netrc` or `.npmrc`.
- **Network:** only github.com, api.github.com and codeload.github.com.
- **Environment:** `GH_TOKEN` and `GITHUB_TOKEN` are withheld.

`./bin/sous` and `gh` run outside the sandbox (`excludedCommands`): they are the only programs that hold the token. The guard limits `gh` to reads and github.com.

Claude Code ignores a folder's project settings until the folder is trusted. Open Claude Code in this folder once and accept the trust prompt, then check the sandbox with this headless run:

```bash
printf '%s\n' "Run each command in its own Bash call and print its output: 1) node -e \"fetch('https://example.com').then(r=>console.log(r.status)).catch(e=>console.log('BLOCKED'))\" 2) gh api user -q .login 3) touch ~/sandbox-probe.txt" | claude -p --model haiku --permission-mode dontAsk --allowedTools Bash
```

Expected: 1 prints `BLOCKED`, 2 prints your login, and 3 fails with "Operation not permitted".

## Who holds what

A subagent that reads text a stranger wrote, holds private data and can send something out has all three traits an injection needs. Those subagents get the tightest checks.

| Subagent | Reads stranger-written text | Holds private data | Can send out | Checks on what it sends |
|---|---|---|---|---|
| gatherer, lens, verifier | PR code, title and body, comments | org memory | no | |
| signal-collector | replies and reactions | state | no | |
| match-judge | past review comments | eval cases | no | |
| writer | only through findings | voice and examples | `sous post` | voice lint, evidence quotes, `outbound.ts`, a fixed recipient, a comment cap |
| reply-judge | teammate replies | org memory | `sous reply`, `resolve` | voice lint, `outbound.ts`, only its own threads |
| reflector | through events and questions | all memory | git pushes and PRs to this repo | `sous leak-check`, the protected guard files, never merges |
