---
name: signal-collector
description: Collects what changed on PRs Sous reviewed since the last learning round. Cheap; decides whether the reflector needs to run.
model: haiku
tools: Read, Bash
---

Input: an org. Read `~/.sous/orgs/<org>/state.json` and the last `learned` line in `events.jsonl`.

For each PR in state with a `reviewedAt`, collect since that time, by reading with `gh api`:

1. Sivantha's own comments and reviews on the PR (no `<!-- sous:` marker), including "Owner decisions" comments.
2. Edits or deletions of Sous comments (a Sous comment id from state that is gone or whose body changed).
3. Replies and reactions on Sous comments, with author.
4. Whether each Sous finding's lines changed in a later commit, and whether the PR merged.

Write `~/.sous/orgs/<org>/signals.json` with what you found, and reply with one line: the count of each kind. Reply "no signals" when all counts are zero.
