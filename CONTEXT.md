# reviewloop.sh — domain glossary

Names the code uses with a precise meaning. Design conversations and
architecture reviews should use these terms (and add to this file when a new
one crystallizes).

- **Review pass** — one review of one push: a `reviews` row keyed by
  (repo, prNumber, headSha). A PR accumulates passes as it's pushed to; the
  **latest pass** (max `queuedAt`) is the one the board shows and that
  ack/merge act on. Canonical rules: `latestPass` / `preferredPass` in
  `convex/prStatus.ts` (preferred = a reviewed row beats a newer failed retry
  of the same SHA).

- **Superseded pass** — a pass whose head SHA stopped being the PR's head
  before its review finished: a new push enqueues the new head and *supersedes*
  the older live passes (`doEnqueue` in `convex/reviews.ts`). A still-queued
  stale pass is deleted outright; a `reviewing` one is stamped `supersededAt`
  and the worker's `superseded` subscription kills that run's `claude` child —
  so a PR never shows two live reviews. The row's fate turns on whether the
  review landed: stopped before posting → `discardSuperseded` deletes it;
  review already on GitHub → finished as `reviewed` and kept (a posted review
  stays on the dashboard). If the holding worker is dead, `requeueStale`
  discards (never requeues) it.

- **PR status (`statusKey`)** — the 8-state lifecycle a PR resolves to
  (`verified · awaiting · inprogress · reviewing · queued · failed · merged ·
  closed`), computed server-side by `statusKey` in `convex/prStatus.ts` and
  shipped on the `prs` query; the frontend only maps it to tones. A `reviewed`
  pass fans out by ack + finding counts, and an unparseable count is never
  clean (`passVerdict` — mirrored in plain JS by `worker/await.mjs`'s exit
  code rule).

- **State-role label** — one of the six mutually-exclusive GitHub labels that
  encode where a follow-up issue sits in its lifecycle:
  `needs-triage → ready-for-agent → agent-in-progress → ready-for-human`
  (or `→ agent-failed`), plus `wontfix`. An issue carries exactly one.
  `ready-for-agent` only ever means "waiting, claimable". Canonical vocabulary
  and swap logic: `STATE_LABELS` / `setStateLabel` in `worker/lib.mjs`.

- **Triage subset** — the human-settable state-role labels (`needs-triage`,
  `ready-for-agent`, `ready-for-human`, `wontfix`): what the console picker
  offers and what `triageLabel` in `convex/schema.ts` validates. Deliberately
  narrower than the full six — `agent-in-progress`/`agent-failed` are set only
  by the solver.

- **The two gates** — the human brakes in the follow-up loop. Gate 1: a human
  approves a suggested issue in the console, and the review worker files it on
  GitHub as `needs-triage`. Gate 2: a human promotes it (label choice), and the
  worker propagates the label — `ready-for-agent` is what hands it to the
  solver. Don't add an auto-cascade across these.

- **Worker runtime** — the shared module `worker/lib.mjs` behind the five
  worker scripts (`index`, `solver`, `await`, `ack`, `suggest`): config +
  Convex-URL resolution, the `run`/`gh` spawn helpers, the claude stream-json
  runner (`streamClaude`), and the state-role label machine. Convention changes
  go there, not per-script.

- **Claimable** — a queued row (review or solve task) no worker has claimed
  yet, surfaced by the `claimable` queries. The Convex claim mutation — not any
  GitHub state — is what prevents double-processing.

- **House rule** — an operator-defined taste rule the reviewer enforces
  (e.g. "no code comments"): a `reviewRules` row with a level — `block`
  (violations post at P1, a merge blocker) or `warn` (P2, a note) — and a
  scope: global (no `repo`, applies to every watched repo) or one
  "owner/name". Edited from the console's rules popover, subscribed to by
  the review worker, and injected into the review brief at spawn time
  (`rulesForRepo` + `houseRulesSection` in `worker/index.mjs`) — so a change
  applies to the next review, never one in flight. Levels ride the existing
  P0/P1/P2 machinery; nothing downstream (counts, `await` verdicts) parses
  rules specially.
