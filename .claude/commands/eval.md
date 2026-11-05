---
description: Replay past PRs and score Sous against what Sivantha said. Never posts. Usage: /eval <org> [sample size] [label]
---

Arguments: $ARGUMENTS (org, then an optional sample size, default all, then an optional label).

1. List the cases: `ls ~/.sous/orgs/<org>/replay/cases/`. With a sample size, take that many, always including the largest cases, so runs stay comparable.
2. Run `./bin/sous evalrun <org> <label> --cases <ids,comma-separated> --repeat 3`. It makes one run folder per repeat, each with `run.json` (the cases, engine commit, prompt hash, memory commit), and refuses when the day's eval budget is spent. Every case listed is scored: one that crashes or writes no draft scores zero.
3. For each run folder, and each case in it (up to 3 at a time), read the case JSON, then:
   - `./bin/sous checkout <org> <repo> <number> <head> <base>`.
   - Run `gatherer` in **replay mode**: it reads only comments created before the case's `before` time, and never any comment by the case's `me` account (those are the answers). It skips CI and knowledge-graph lookups for later commits.
   - Run the `lens` subagents, then the `verifier`. Save each lens output as `<run folder>/<case id>.lens-<lens>.json` and the verifier's as `<case id>.verified.json`, so the score can tell whether a point was lost in the lenses or in the verifier. The gatherer's context is the same in every repeat: run `./bin/sous stagekey <org> gatherer <head>` and reuse the cached file when `cached` is true. Never reuse lens or verifier output across repeats: the repeats exist to measure their variance.
   - Run the `writer` in **dry mode**: it writes the draft to `<run folder>/<case id>.json` and never runs `sous post`, `sous mark` or anything that touches GitHub.
4. For each case, run the `match-judge` subagent on the case file and its draft, writing `<run folder>/<case id>.judge.json`.
5. Run `./bin/sous tokens --org <org> --label eval` to log the run's token use.
6. Run `./bin/sous score <org> <every run folder of this eval> --label "<label>"`. It averages the repeats before comparing with the baseline and report recall, precision, the nit share, the baseline, each case's `nearByLenses` against `matched` (where points were lost), and any case that scored zero or had no draft.
7. When Sivantha says the run is a fair baseline, run the same score command with `--accept`.

Scoring takes the judge's pairs first, then any finding on the same file (folders optional) within 10 lines. Changing the judge or the matcher changes the numbers, so re-score the baseline run with the new matcher and accept it before comparing.
