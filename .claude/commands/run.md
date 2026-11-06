---
description: The scheduled run. Reviews what is due in one org (or every org), then learns. Usage: /run [org]
---

0. Note the run's start time as an ISO timestamp: run `date -u +%Y-%m-%dT%H:%M:%SZ` as a call of its own, never chained with step 1. The gate and the learning round use it.
1. Run `./bin/sous due --lock ${CLAUDE_SESSION_ID}`, adding `--org $ARGUMENTS` when an org was given. It prints `take` (this run's PRs, already capped) and each org's queue. An org listed as `locked` is still being worked on by an earlier run: leave it alone. When every org is locked, stop with that one line.
2. For each PR in `take`, in order:
   - If its reason is `REPLY`, run the `reply-judge` subagent with its `threads`, and move on.
   - If its reason is `REREQUESTED`, the author asked for your review again with no new push: run `reply-judge` on any `threads` first (they may be disputing a finding), then follow `/review` on the same head. `sous post` drops points already made, and records the head when nothing new is left.
   - If its gate is `wait`, run `./bin/sous gate <org> <repo> <n> <head> <run start time>` (at most twice for the same PR; it polls inside). On `defer`, move on; the next run picks it up.
   - Then follow `/review` steps 2 to 8 for it. Run up to 2 PRs at the same time.
3. Run `./bin/sous tokens --org <org> --label run --session ${CLAUDE_SESSION_ID}` for each org that had a review, so the run's tokens and time are in the event log before the learning round reads them.
4. Run `/learn-round <org> <run start time>` for every org this run touched: a review, a reply, a skip, a refusal or a block. Run its subagents in the foreground and wait for each.
5. Run `./bin/sous unlock <org> ${CLAUDE_SESSION_ID}` for every org this run locked, even when a step failed. This is the run's last command.
6. If `questions.md` or `engine-fixes.md` in any org gained entries, finish with one line: "Sous: <n> reviews posted, <m> questions and <k> engine fixes waiting. Run /learn to go through them one at a time." Don't list the questions themselves: `/learn` gives each one its background before asking.

Never stop to ask anything during a run. Doubts go to `questions.md` in the form `prompts/question-format.md` sets.

Run every subagent as an Agent call with its `subagent_type`, never through a Workflow. Never end the turn while a subagent you started is still running: a scheduled run ends with the turn, so anything still running is cut off and the lock stays held.

An org that `sous due` lists as `blocked` (its gh account isn't signed in) is skipped this run; say so in the last line. When a step fails for one PR, note it in that PR's line and go on with the next PR: one PR never stops the run.
