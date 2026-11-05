---
description: The learning round for one org after a run. Usage: /learn-round <org> <run start time>
---

1. Run `./bin/sous retro <org> <run start time>`: this run's reviews, problems, cost and time, and the median of recent runs.
2. Run the `signal-collector` subagent for the org.
3. If it replies "no signals" and the retro has no problems and its cost is within 1.5 times the median (or there is no median yet), stop with one line: the reviews, the paid tokens and the minutes.
4. Otherwise run the `reflector` subagent for the org, and give it the retro output.
