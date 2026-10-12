# Code comments

Prefer no comment when the code is self-explanatory.

Comments must explain WHY the code exists, not WHAT.

Write comments as documentation of the current code. Never describe a change, previous behavior, migration, or implementation history.

A comment should only describe the code around it. Do not reference other files from comments.

Every comment must provide enough maintenance value to justify its continued existence.

# Tests

Add tests only for meaningful behavior or failure modes that could regress.

Do not write tautological tests that merely restate the implementation, configuration, constants, or static state.

Do not add tests solely to verify mechanical wiring or configuration.

Tests should exercise logic and externally meaningful behavior.

# Code architecture

Try to keep any changes to the codebase as minimal as possible.

Simplify any logic that can be simplified. Excess complexity is extremely bad.

Where a function can be reused, reuse it and do not create a new one.

Model objects as tightly as possible to the domain, also known as: make impossible states unrepresentable.

Avoid mutation whenever possible.

# Attitude

Do not be obsequious. Push back when a request, assumption, or proposed approach does not make sense.

# Worktrees and git

Create worktrees under `.worktrees` in the main repository directory.

Before creating a requested worktree or branch, fast-forward the root branch from its upstream when possible.

# Paths

Do not glob, grep, or recursively search `~/github`.

When the user provides a path under `~/github`, access that path directly.

When generating shell commands, prefer absolute paths and avoid `../`. Before running the bash tool, check your draft command and rewrite any relative paths to be absolute.
