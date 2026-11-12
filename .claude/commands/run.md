---
description: The scheduled run. Reviews what is due in one org (or every org), then learns. Usage: /run [org]
---

0. Note the run's start time as an ISO timestamp: run `date -u +%Y-%m-%dT%H:%M:%SZ` as a call of its own, never chained with step 1. The gate and the learning round use it.
1. Run `./bin/sous due --lock ${CLAUDE_SESSION_ID}` with a Bash timeout of 600000 ms (it reads every open PR and can take minutes), adding `--org $ARGUMENTS` when an org was given. It prints `take` (this run's PRs, already capped) and each org's queue. An org listed as `locked` is still being worked on by an earlier run: leave it alone. When every org is locked, stop with that one line.
2. Work one org at a time. Before an org's first PR, run `./bin/sous focus <org> ${CLAUDE_SESSION_ID}`, so the guard keeps every other org out of reach; keep it through that org's learning round, and clear it with `./bin/sous focus --clear ${CLAUDE_SESSION_ID}` before the next org and at the end, even when a step failed. For each PR in `take`, in order. First claim it with `./bin/sous pr-lock <org> <repo> <n> ${CLAUDE_SESSION_ID}`; on exit 3 another session (a hand `/review`) is on it, so skip it this run. Release it with `./bin/sous pr-unlock <org> <repo> <n> ${CLAUDE_SESSION_ID}` when you are done with it, even when a step failed.
   - If it has `threads`, whatever its reason, run the `reply-judge` subagent with them first: the author may say what they changed, point to another PR, or dispute a finding. It replies, resolves or asks in those threads.
   - If its reason is `REPLY`, that is all: move on.
   - If its reason is `REREQUESTED`, the author asked for your review again with no new push: follow `/review` on the same head. `sous post` drops points already made, and records the head when nothing new is left.
   - If its gate is `wait`, run `./bin/sous gate <org> <repo> <n> <head> <run start time>` (at most twice for the same PR; it polls inside). On `defer`, move on; the next run picks it up.
   - Then follow `/review` steps 2 to 8 for it. Run up to 2 PRs at the same time.
3. Run `./bin/sous tokens --org <org> --label run --session ${CLAUDE_SESSION_ID}` for each org that had a review, so the run's tokens and time are in the event log before the learning round reads them.
4. Run `/learn-round <org> <run start time>` for every org this run touched: a review, a reply, a skip, a refusal or a block. Run its subagents in the foreground and wait for each.
5. Run `./bin/sous unlock <org> ${CLAUDE_SESSION_ID}` for every org this run locked, even when a step failed. This is the run's last command.
6. Finish with the summary, and nothing after it: for each org this run touched, run `./bin/sous summary <org> <run start time>` and print its table as it comes, under the org's name. It lists each PR with its link and the comments, replies and resolved threads Sous posted on it. Below the tables, one line: "<n> reviews posted, <m> questions and <k> engine fixes waiting for /learn." Name a blocked or locked org, or a step that failed, in one more line.

A run is non-interactive: nobody is watching it. Never stop to ask anything, and never call AskUserQuestion, PushNotification, ScheduleWakeup or Monitor. Doubts go to `questions.md` in the form `prompts/question-format.md` sets. If the app gives you a wrap-up tool, pass it the recap alone, with no question and no buttons. While subagents run, write no progress lines such as "waiting on the gatherers": nobody reads them.

Run every subagent as an Agent call with its `subagent_type`, never through a Workflow. Never end the turn while a subagent you started is still running: a scheduled run ends with the turn, so anything still running is cut off and the lock stays held.

An org that `sous due` lists as `blocked` (its gh account isn't signed in) is skipped this run; say so in the last line. When a step fails for one PR, note it in that PR's line and go on with the next PR: one PR never stops the run.
