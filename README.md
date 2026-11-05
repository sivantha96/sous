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
| `sous due` | Finds PRs due in every org, reads CodeRabbit's state, picks this run's PRs (capped by `maxReviewsPerRun`). No model tokens |
| `sous gate` | Waits for CodeRabbit on one PR, polling every 3 minutes |
| `sous checkout` | Read-only worktree of a PR head, without `.claude/`, `.mcp.json` and other AI-config paths (their changes are reviewed from the diff, their base copies read with `git show`) |
| `sous noise` | Prints which paths are lockfiles or generated output |
| `sous post` | The only way a review leaves the machine: inline comments only (no review body), voice lint, lines checked against the diff, the italic attribution and marker on every comment, COMMENT or REQUEST_CHANGES, never APPROVE |
| `sous mark` | Records a head reviewed with nothing to post |
| `sous dismiss` | Dismisses a request-changes review, only one Sous wrote |
| `sous leak-check` | Fails when text bound for git names anything from local org memory |
| `sous reply` / `resolve` | Replies in, or resolves, a thread Sous started; refuses any other thread |
| `sous seen` | Marks teammate replies and reactions as judged |
| `sous status` | Sous's reviews, blocking reviews and findings on one PR |
| `sous replay build` | Builds replay cases from your past reviews in an org |
| `sous score` | Scores an eval run against the cases; `--gate` fails on a drop, `--accept` sets the baseline |
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
| `reflector` | Opus | Memory edits behind the replay gate, engine PRs, questions for you |

## Rules this code enforces

- Never approves: `APPROVE` is not a value the review type can hold, and `postReview` refuses it at run time.
- Requests changes for any major finding; minors and nits only comment.
- Paused orgs and orgs in draft mode get pending reviews.
- Dismisses only its own reviews: posted by your account, carrying the Sous marker, and recorded in state.
- Text that fails the voice lint is never posted.
- `.claude/settings.json` blocks agents from writing to GitHub except through `sous`.

`pnpm check` runs the typecheck and tests.

## The guard

`bin/sous-guard` is a PreToolUse hook (`.claude/settings.json`) on every Bash, Read, Grep and Glob call, in the main session and in every subagent. Claude Code tells it which subagent is calling (`agent_type`), and `src/guard.ts` applies that role's policy:

| Role | Subagents | May run |
|---|---|---|
| reader | gatherer, lens, verifier, match-judge, signal-collector, and any unknown one | read-only commands (`src/vendor/shell-policy.ts`), read-only `git` and `gh`, read-only `sous` commands |
| writer | writer | the same, plus `sous post` and `sous mark` |
| reply-judge | reply-judge | the same, plus `sous reply`, `resolve` and `seen` |
| reflector | reflector | the same, plus git commits and pushes (never forced), `gh pr create`, `pnpm check` |
| main | the orchestrating session | anything but network tools |

No role may use `curl`, `wget`, `ssh` or other network tools, or read credentials and env files (`.env.example` excepted), including through a symlink. `src/vendor/shell-policy.ts` is copied from vercel-labs/knowledge-agent-template under MIT; its notice is in the file.
