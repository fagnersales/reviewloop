<!-- convex-ai-start -->

This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read
`convex/_generated/ai/guidelines.md` first** for important guidelines on
how to correctly use Convex APIs and patterns. The file contains rules that
override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running
`npx convex ai-files install`.

<!-- convex-ai-end -->

## Waiting for a PR review (for Claude Code)

After you push a PR to a repo this console reviews, **do not ask the human
whether the review is done** — block on it programmatically. Run, as a
**background** command:

```bash
node worker/await.mjs <pr> --repo <owner/name>
```

It subscribes to the Convex `reviews` row for *this push's* head SHA (head-SHA
keyed, so it waits for the review of the commit you just pushed, not a stale
one), blocks until that row is `reviewed`/`failed`, then prints the result JSON
to stdout and exits with a verdict code:

- `0` reviewed, clean (no P0/P1) · `2` reviewed but has P0/P1 blockers ·
  `3` failed · `124` timeout · `1` usage/connection error.

Read the JSON (`reviewUrl`, `p0`/`p1`/`p2`, `confidence`) and the exit code to
decide what to do next. `--head <sha>` and `--repo` are auto-resolved from `gh`
when omitted; `--timeout <seconds>` defaults to 1800.
