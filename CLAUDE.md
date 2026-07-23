<!-- convex-ai-start -->

This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read
`convex/_generated/ai/guidelines.md` first** for important guidelines on
how to correctly use Convex APIs and patterns. The file contains rules that
override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running
`npx convex ai-files install`.

<!-- convex-ai-end -->

## Running the review worker (for Claude Code)

Convex can't spawn `claude`, so the review worker (`worker/index.mjs`) is what
actually runs reviews **and** the House Rules composer's rewrite/shorten
transforms. If it's not running, none of that happens: queued `reviews` and
`ruleDrafts` rows just sit in `queued` forever. A House Rules scrim stuck on
"Rewriting…"/"Shortening…" is the classic symptom — the worker is down. (The UI
now gives up after ~95s with "The rewriter isn't responding — is the worker
running?", but the fix is still to start the worker.)

Start it **detached** so it survives the session/terminal closing:

```bash
nohup npm run worker > worker.log 2>&1 & disown
```

- Watch it: `tail -f worker.log` · Stop it: `pkill -f worker/index.mjs`
- Check it's alive before assuming a review/draft is stuck: `pgrep -f worker/index.mjs`
- `nohup` survives session close but **not reboot/logout** — for always-on, set up
  a `launchd` LaunchAgent instead.

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

- `0` reviewed, clean (no P0/P1) · `2` reviewed but has P0/P1 blockers (or the
  counts came back unparseable — read the review) · `3` failed (`error` in the
  JSON has the reason) · `124` timeout · `1` usage/connection error, or the repo
  isn't watched by reviewloop (self-heal got `unwatched`).

Exit `3` (failed) is the *last-observed* state, not a final give-up: the worker's
fallback reconcile (~30 min) re-enqueues open PRs whose only rows for the head SHA
are `failed`, so if you treat exit `3` as retriable you can just re-run `await` to
catch the next attempt.

If a push's `synchronize` webhook is dropped, no review row is ever created. After
a ~60s grace period `await` **self-heals** — it enqueues the review itself via the
idempotent `reviews.enqueueMissing` path, so a missed delivery recovers in ~60s
instead of waiting up to the full ~30-min reconcile interval. You don't need to do
anything: keep blocking on `await` as usual. (If self-heal finds the repo isn't
watched, it gives up at once with exit `1` rather than blocking until `--timeout`.)

Read the JSON (`reviewUrl`, `p0`/`p1`/`p2`, `confidence`) and the exit code to
decide what to do next. **Branch on the exit code, not the JSON `status`:** on
`--timeout` the `status` is the last-known state (e.g. `"reviewing"`), not
`"timeout"` — only exit `124` signals the give-up; likewise, if a PR is closed
while its review is still `queued`, the row is removed and `await` blocks until
`--timeout` (exit `124`) rather than exiting early. The same applies when a new
push lands while a review is in flight: the old pass is **superseded** — its
run is stopped, and if no review had posted yet its row is deleted, so an
`await` still keyed to the old head blocks until `--timeout`. (If the review
*had* already posted, the pass is kept and that `await` resolves normally.)
If you pushed again, just re-run `await` (it resolves the new head from `gh`);
self-heal also refuses to enqueue a head that is no longer the PR's current
head. `--head <sha>` and `--repo`
are auto-resolved from `gh` when omitted; `--timeout <seconds>` defaults to 1800.

## Acknowledging a review you pick up (for Claude Code)

When `await` returns a review with blockers (exit `2`) that **you are going to
fix**, ACK it so the console stops showing **Awaiting agent** ("reviewed, nobody's
on it") and shows **In progress** instead. The console can't know an agent has
started until that agent pushes a commit — acking is how you tell it. Run:

```bash
node worker/ack.mjs <pr> --repo <owner/name> --head <sha>
```

(installed bin alias: `reviewloop-ack <pr>`). It stamps the `reviews` row for that head
SHA and exits: `0` acked · `2` nothing to ack (no reviewed pass yet, or the PR is
merged/closed) · `1` usage/connection error. `--head` defaults to the PR's latest
pass; `--repo` is auto-resolved from `gh`. When you bail on a PR you acked, release
it with `--clear`. You don't need to ack a clean review (exit `0`) — there's
nothing to pick up. The ack is dropped automatically (~90 min) if you ack but never
push a fix, so the board reverts to **Awaiting agent** for someone else.

## The autonomous solver (`worker/solver.mjs`)

The third worker in this repo (beside the review worker and the await/ack CLIs).
It closes the loop: a GitHub issue labelled **`ready-for-agent`** → the solver
spawns `claude -p "/reviewloop-feature …"` against a **registered local checkout** (it needs
the gitignored `.env.local`/`node_modules` a build requires — a throwaway clone
won't do) → the agent builds it, opens a PR (`Closes #N`), runs its own `reviewloop-await`
auto-fix loop, and **stops**. The opened PR is then reviewed by the review half for
free. **The solver never merges** — a human does; the `pull_request` merge webhook
flips the solve task `pr-opened → done`.

Operator/agent notes if you touch this:
- The checkout registry lives in **Convex** (`solverCheckouts`, edited from the
  console's **Solver checkouts** rail panel), keyed by **hostname** so paths stay
  host-specific — each solver subscribes only to its own hostname's rows, picks
  changes up live (no restart), and writes a validation verdict back per row
  (the ✓/✗ dot in the panel). A row can carry free-text **instructions** the
  solver injects into every solve prompt for that repo ("copy these .example
  files", …). `worker/solver.config.json` is now optional tuning only — no
  checkout map, no fallback. A watched repo with no registered checkout has its
  solve **failed fast** with a clear reason, never silently stalled.
- New rows are **provisioned by the solver itself** (`provision: requested →
  provisioning → ready | failed`): it clones via `gh` to the registered path
  (default `~/solver-checkouts/<name>`), then spawns a one-shot `claude -p`
  setup agent that installs deps per the repo's lockfile, finds a sibling clone
  by matching `git remote origin` and copies its gitignored env files (never
  inventing secrets), and follows the repo's README setup. Progress streams to
  `provisionProgress`; the agent's report lands in `provisionReport`; a cron
  fails stale `provisioning` rows. Registering an already-prepared path no-ops
  straight to ready, and solves against a not-yet-ready checkout fail fast with
  the provisioning state as the reason.
- Every autonomous spawn sets **`REVIEWLOOP_UNATTENDED=1`** (the contract that tells
  `reviewloop-feature` it's headless — flush follow-ups via `reviewloop-suggest`, skip human
  chatter) and assigns a deterministic branch `solve/issue-<N>-<slug>` so the worker
  can locate the opened PR and clean up the local worktree afterward.
- Run it with `npm run solver` (separate process from `npm run worker`). It gates on
  the **real GitHub `ready-for-agent` label** (so manually-triaged issues work too),
  via the `issues` webhook + a `gh issue list` reconcile fallback.
- It **swaps the issue's state-role label** as it works so `ready-for-agent` only ever
  means "waiting, claimable": `ready-for-agent` →(claim)→ `agent-in-progress`
  →(PR opened)→ `ready-for-human`, or →(failed)→ `agent-failed`. A failed solve does
  **not** auto-retry (the reconcile keys on `ready-for-agent`); re-label to retry.
- Trigger gates are deliberate. Gate 1 (open a follow-up as an issue) is human
  by default, but the operator can hand it to the inbox's opt-in Auto-review
  agent (rail control), which keeps→files or drops each proposal. Gate 2
  (promote to `ready-for-agent`) is **always human** — never auto-promote; that
  brake is what keeps the solver from cascading.
