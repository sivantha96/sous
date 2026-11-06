---
description: The learning round for one org after a run. Usage: /learn-round <org> <run start time> [owner/repo#n ...]
---

The PRs after the start time are the ones this session reviewed: a hand `/review` passes its one PR. Other sessions may be reviewing other PRs at the same time, so this round looks only at its own. With no PRs given (a scheduled run, which holds the org's lock), it covers every PR since the start time.

1. When this session posted a review, run the `review-judge` subagent with the org, the run start time, the PRs (if given) and the file to write: `~/.sous/tmp/scores-<org>-${CLAUDE_SESSION_ID}.json`. When it writes that file, run `./bin/sous quality <org> <that file>` to log the scores; a review already scored is skipped.
2. Run `./bin/sous retro <org> <run start time> --session ${CLAUDE_SESSION_ID}`, adding `--pr <owner/repo#n>` for each PR given: this session's reviews, problems, low review scores, cost and time, and the median of recent runs.
3. Run the `signal-collector` subagent for the org.
4. If it replies "no signals", the retro has no problems and no low scores, and its cost is within 1.5 times the median (or there is no median yet), stop with one line: the reviews, the paid tokens and the minutes.
5. Otherwise run the `reflector` subagent for the org, and give it the retro output.
