---
description: Answer Sous's open questions, one at a time. Usage: /learn [org]
---

1. Read `questions.md` and `engine-fixes.md` in each org (or only $ARGUMENTS). Each entry follows `prompts/question-format.md`.
2. For each entry, one at a time:
   - First write its background, the problem and the evidence as a short message, in plain words for someone who hasn't seen the PR. Fill any gap by reading the PR or the files it cites: never ask with less context than the entry should have had.
   - Then ask with the AskUserQuestion tool: the decision in under 40 words, two to four options in plain words, each with its cost, Sous's pick first and marked recommended.
   - When Sivantha says the question is unclear, rewrite it with what was missing and ask again once; if it still misses, record their words as unconfirmed and move on.
3. Write each answer into memory as a rule, a system fact or a habit, one bullet, with the PR it came from. Remove the question from `questions.md`. An answer that changes the engine (a prompt, a check) becomes an engine fix as the reflector makes them.
4. If the answer settles a thread that is waiting, write the reply in Sivantha's voice, quoting the line at the PR's current head that shows it, and show it with the thread link. On Sivantha's yes, post it with `./bin/sous reply`; otherwise leave it for them.
5. Commit each memory folder that changed.
6. Then each entry in `engine-fixes.md`, one at a time: say what went wrong in the run and what the fix changes, in plain words, then ask with AskUserQuestion whether to open the PR. On a yes, clone this repo into a new folder under `$TMPDIR`, branch `sous/<slug>` from `origin/main`, make the change there (never in this checkout), run `pnpm check` and `./bin/sous leak-check --diff origin/main`, push, and open the PR with `gh pr create --body-file` as a call of its own. Sivantha merges; you never do. Remove the entry either way, noting a no in `questions.md` only if they want it kept for later.
