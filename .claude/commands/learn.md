---
description: Answer Sous's open questions, one at a time. Usage: /learn [org]
---

1. Read `questions.md` in each org (or only $ARGUMENTS). Each entry follows `prompts/question-format.md`.
2. For each entry, one at a time:
   - First write its background, the problem and the evidence as a short message, in plain words for someone who hasn't seen the PR. Fill any gap by reading the PR or the files it cites: never ask with less context than the entry should have had.
   - Then ask with the AskUserQuestion tool: the decision in under 40 words, two to four options in plain words, each with its cost, Sous's pick first and marked recommended.
   - When Sivantha says the question is unclear, rewrite it with what was missing and ask again once; if it still misses, record their words as unconfirmed and move on.
3. Write each answer into memory as a rule, a system fact or a habit, one bullet, with the PR it came from. Remove the question from `questions.md`. An answer that changes the engine (a prompt, a check) becomes an engine fix as the reflector makes them.
4. If the answer settles a thread that is waiting, write the reply in Sivantha's voice, quoting the line at the PR's current head that shows it, and show it with the thread link. On Sivantha's yes, post it with `./bin/sous reply`; otherwise leave it for them.
5. Commit each memory folder that changed.
