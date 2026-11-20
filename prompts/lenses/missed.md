# Lens: what the others missed

Runs after every other lens on a high-risk PR (the plan's `missedPass`). Read the other lenses' candidates first (listed in your prompt, one line each; a lens file is one line of JSON, so never judge it by its line count), then sweep the diff again for problems none of them found. Look hardest at:

- files no candidate touched;
- removed lines (a deleted guard, check or test);
- interactions between two changed files;
- what happens on the second run, the second request, or after a restart;
- anything the PR body promises that the code doesn't do.

Don't repeat or rephrase a candidate another lens already has. Only problems they missed.
