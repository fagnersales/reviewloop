<!-- reviewloop: append the section below to the user's global agent
instructions (~/.claude/CLAUDE.md for Claude Code, ~/.codex/AGENTS.md for
Codex). Replace <REVIEWLOOP_ROOT> with the absolute path of the reviewloop
checkout. If `npm link` succeeded, the `reviewloop-await` / `reviewloop-ack`
bins may be used instead of the `node <REVIEWLOOP_ROOT>/worker/…` forms. -->

## PR reviews (reviewloop)

Repos on this machine may be watched by reviewloop — every push to an open PR
gets an automated review. After you push a PR branch, **don't ask the human
whether the review is done** — block on it as a **background** command:

```bash
node <REVIEWLOOP_ROOT>/worker/await.mjs <pr> --repo <owner/name>
```

It waits (websocket, no polling) for the review of the commit you just pushed
and exits with a verdict code — **branch on the exit code, not the JSON**:

- `0` reviewed, clean — you're done
- `2` reviewed with P0/P1 blockers — read the `reviewUrl` in the stdout JSON,
  fix, push, and run `await` again for the new head SHA
- `3` review failed (`error` in the JSON has the reason) — retriable; re-run
  `await` to catch the automatic retry
- `124` timed out · `1` usage/connection error, or the repo isn't watched
  (in which case stop waiting — there will be no review)

When you get exit `2` and are **going to fix it yourself**, ack it first so
the console board shows the review is being handled:

```bash
node <REVIEWLOOP_ROOT>/worker/ack.mjs <pr> --repo <owner/name>
```

If you bail on a PR you acked, release it with `--clear`. A clean review
(exit `0`) needs no ack.
