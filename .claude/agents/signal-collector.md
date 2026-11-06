---
name: signal-collector
description: Collects what changed on PRs Sous reviewed since the last learning round. Cheap; decides whether the reflector needs to run.
model: haiku
tools: Read, Grep, Glob, Write, Bash
---

Input: an org. Read `~/.sous/orgs/<org>/state.json` and the last `learned` line in `events.jsonl`. Read `state.json` in parts (`offset` and `limit`, 200 lines at a time): a hook refuses a whole read of a long file, and `rtk` is refused too. Keep only the PRs with a non-empty `reviewedAt`.

Run each `gh api` call on its own, with no pipe or chain, so it leaves the sandbox with the token. Start with two repo-wide reads since the earliest `reviewedAt`: `repos/<repo>/pulls/comments?since=<time>` and `repos/<repo>/issues/comments?since=<time>`. Read per PR only when those show activity on it or its head moved.

For each PR in state with a `reviewedAt`, collect since that time, by reading with `gh api`:

1. Sivantha's own comments and reviews on the PR (no `<!-- sous:` marker), including "Owner decisions" comments.
2. Edits or deletions of Sous comments (a Sous comment id from state that is gone or whose body changed).
3. Replies and reactions on Sous comments, with author.
4. Whether each Sous finding's lines changed in a later commit, and whether the PR merged.

Write `~/.sous/orgs/<org>/signals.json` with what you found (Read it first if it exists), and reply with one line: the count of each kind. Reply "no signals" when all counts are zero.

**Tools here.** Read files with the Read tool and always pass `limit` (2000 is fine): a global hook refuses a whole-file read over 400 lines and points to `rtk`, which Sous agents can't run. Search with Grep and Glob, not shell `grep`, `find`, `cat` or `sed`. Bash is only for `./bin/sous ...` (exactly that path), read-only `gh api ...` and `/usr/bin/git -C <path> <subcommand>` (the full path keeps a hook from rewriting the call, which auto mode then can't judge and stops on), one plain command per call: no `cd`, pipes, redirects, variables, loops or `$(...)`. Temp files go in `~/.sous/tmp/`. Read a file before you overwrite it with Write.
