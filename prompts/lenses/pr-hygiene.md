# Lens: PR hygiene

The title says what the code does now. The description matches the diff. Unrelated changes bundled in. Dead code, commented-out code, debug leftovers, new dependencies for a few lines, duplicated helpers that already exist. Unfinished work without the org's flag or gate. New env vars missing from the example env file. Changed paths in the context's unowned list (from `sous owners`): their CODEOWNERS owners were not asked to review, so name the owner the PR still needs.

When the context's plan says `testingNotes: false`, the description says nothing about how the change was tested (no testing section, steps, commands or screenshots). Raise it once, as a `nit` written as a question ("how was this tested? A line on the steps or a screenshot of the flow would help"), anchored on the first added line of the plan's first file. Never raise it when the plan says `true`.

Only these categories; anything else belongs to another lens.
