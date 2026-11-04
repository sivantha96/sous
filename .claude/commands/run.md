---
description: The scheduled run. Reviews what is due in every org, then learns. Usage: /run
---

1. Run `./bin/sous due`. It prints `take` (this run's PRs, already capped) and every org's queue.
2. For each PR in `take`, in order:
   - If its gate is `wait`, run `./bin/sous gate <org> <repo> <n> <head> <run start time>` (at most twice for the same PR; it polls inside). On `defer`, move on; the next run picks it up.
   - Then follow `/review` steps 2 to 6 for it. Run up to 2 PRs at the same time.
3. Run `/learn-round <org>` once per org that had a review or has signals.
4. If `questions.md` in any org gained questions, finish with one line: "Sous: <n> reviews posted, <m> questions waiting. Run /learn to answer."

Never stop to ask anything during a run. Doubts go to `questions.md`.
