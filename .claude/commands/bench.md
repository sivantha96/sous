---
description: Check Sous's general bug-finding on a public benchmark slice. Usage: /bench <benchmark.json>
---

A replay of your own reviews measures how well Sous fits you. A public benchmark measures whether it finds real bugs at all, independent of you. Run this occasionally, not on every change.

1. You supply the benchmark file: public PRs with their golden comments, as `[{ repo, number, head, base, comments: [{ path, line, body }] }]`. Sous never downloads benchmark data itself.
2. Run `./bin/sous bench import <benchmark.json>`. The cases land in a separate `bench` org folder, apart from any real org's memory.
3. Run `/eval bench 10 "<label>"` against those cases. Use only the base voice and lenses; never load an org's memory for a benchmark.
4. Report recall and precision beside the org's own replay scores. Never gate rule changes on the benchmark.
