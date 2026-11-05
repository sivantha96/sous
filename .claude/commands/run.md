---
description: The scheduled run. Reviews what is due in every org, then learns. Usage: /run
---

0. Note the run's start time as an ISO timestamp (`date -u +%Y-%m-%dT%H:%M:%SZ`); the gate and the learning round use it.
1. Run `./bin/sous due`. It prints `take` (this run's PRs, already capped) and every org's queue.
2. For each PR in `take`, in order:
   - If its reason is `REPLY`, run the `reply-judge` subagent with its `threads`, and move on.
   - If its reason is `REREQUESTED`, the author asked for your review again with no new push: run `reply-judge` on any `threads` first (they may be disputing a finding), then follow `/review` on the same head. `sous post` drops points already made, and records the head when nothing new is left.
   - If its gate is `wait`, run `./bin/sous gate <org> <repo> <n> <head> <run start time>` (at most twice for the same PR; it polls inside). On `defer`, move on; the next run picks it up.
   - Then follow `/review` steps 2 to 6 for it. Run up to 2 PRs at the same time.
3. Run `./bin/sous tokens --org <org> --label run` for each org that had a review, so the run's tokens and time are in the event log before the learning round reads them.
4. Run `/learn-round <org> <run start time>` for every org this run touched: a review, a reply, a skip, a refusal or a block.
5. If `questions.md` in any org gained questions, finish with one line: "Sous: <n> reviews posted, <m> questions waiting. Run /learn to answer."

Never stop to ask anything during a run. Doubts go to `questions.md`.

An org that `sous due` lists as `blocked` (its gh account isn't signed in) is skipped this run; say so in the last line. When a step fails for one PR, note it in that PR's line and go on with the next PR: one PR never stops the run.
