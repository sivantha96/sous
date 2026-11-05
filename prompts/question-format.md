# How a question for Sivantha is written

Sivantha answers questions days later, without the PR, the plan or the run in front of them. Every entry in `questions.md` gives the context first and asks second, so they can answer it from the entry alone.

One entry per question, as a `## ` heading (one line naming the decision in plain words) followed by these parts, in this order:

- **Where:** the PR as `owner/repo#n` with its link, and its head commit. For an engine question, the run's start time.
- **Background:** what the PR or the run is doing, in two or three plain sentences, for someone who has never opened it. Name what a term means the first time it appears ("the base plan, the step-by-step plan this PR follows, says…").
- **The problem:** what Sous found, and why it matters if nobody decides: what breaks, who is blocked, what gets posted or not posted.
- **Evidence:** each fact with `path:line` at the commit it was read at, quoted when one line settles it.
- **Options:** two to four, each with what it changes, what it costs, and who does the work. Mark the one Sous would pick, and say why in one sentence.
- **Until then:** what Sous does while the question is open (holds a comment, keeps a thread open, skips the PR).

One decision per entry. When two decisions are tangled, write two entries and say which to answer first.

An entry Sivantha marks as unclear is rewritten with the missing context, never asked again as it stood.
