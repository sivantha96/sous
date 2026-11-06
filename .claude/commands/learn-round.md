---
description: The learning round for one org after a run. Usage: /learn-round <org> <run start time>
---

1. When the run posted a review, run the `review-judge` subagent with the org and the run start time. When it writes a scores file, run `./bin/sous quality <org> <that file>` to log the scores.
2. Run `./bin/sous retro <org> <run start time>`: this run's reviews, problems, low review scores, cost and time, and the median of recent runs.
3. Run the `signal-collector` subagent for the org.
4. If it replies "no signals", the retro has no problems and no low scores, and its cost is within 1.5 times the median (or there is no median yet), stop with one line: the reviews, the paid tokens and the minutes.
5. Otherwise run the `reflector` subagent for the org, and give it the retro output.
