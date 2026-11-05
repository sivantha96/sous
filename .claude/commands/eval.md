---
description: Replay past PRs and score Sous against what Sivantha said. Never posts. Usage: /eval <org> [sample size] [label]
---

Arguments: $ARGUMENTS (org, then an optional sample size, default all, then an optional label).

1. List the cases: `ls ~/.sous/orgs/<org>/replay/cases/`. With a sample size, take that many, always including the largest cases, so runs stay comparable.
2. Make a run folder: `~/.sous/orgs/<org>/replay/runs/<UTC timestamp>/`.
3. For each case (up to 3 at a time), read its JSON, then:
   - `./bin/sous checkout <org> <repo> <number> <head> <base>`.
   - Run `gatherer` in **replay mode**: it reads only comments created before the case's `before` time, and never any comment by the case's `me` account (those are the answers). It skips CI and knowledge-graph lookups for later commits.
   - Run the `lens` subagents, then the `verifier`.
   - Run the `writer` in **dry mode**: it writes the draft to `<run folder>/<case id>.json` and never runs `sous post`, `sous mark` or anything that touches GitHub.
4. Run `./bin/sous score <org> <run folder> --label "<label>"` and report recall, precision, the nit share, the baseline and any case that scored zero.
5. When Sivantha says the run is a fair baseline, run `./bin/sous score <org> <run folder> --label "<label>" --accept`.

Scoring matches a finding to a gold point on the same file within 10 lines. It can't tell whether the finding says the same thing, so read the zero-score cases before trusting a drop.
