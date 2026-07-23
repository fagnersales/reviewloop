import { defineSchema, defineTable } from "convex/server"
import { v } from "convex/values"

// A review goes queued -> reviewing -> reviewed | failed.
//   queued    : a webhook (or rescan) saw a PR head SHA with no review yet
//   reviewing : the worker claimed it and `claude -p /reviewloop-review N` is running
//   reviewed  : the review was posted to GitHub (see reviewUrl)
//   failed    : the run errored or timed out
export const reviewStatus = v.union(
  v.literal("queued"),
  v.literal("reviewing"),
  v.literal("reviewed"),
  v.literal("failed"),
)

// Semantic kind of a streamed review-log line — mirrors the client's
// CloudLogKind ("info" | "done" | "warn" | "error"), driving the ticker's dot
// colour/glyph. Optional on a line; absent reads as "info".
export const logKind = v.union(
  v.literal("info"),
  v.literal("done"),
  v.literal("warn"),
  v.literal("error"),
)

// ── reviewer settings (the console's model + effort picker) ─────────────────
// What the review worker passes to `claude -p`: the model alias (`--model`) and
// the reasoning effort (`--effort`). Values are the Claude CLI's own aliases /
// levels — literal unions (not v.string()) so a typo'd write can never wedge
// the worker with a flag the CLI rejects.
export const reviewerModel = v.union(
  v.literal("fable"),
  v.literal("opus"),
  v.literal("sonnet"),
  v.literal("haiku"),
)
export const reviewerEffort = v.union(
  v.literal("low"),
  v.literal("medium"),
  v.literal("high"),
  v.literal("xhigh"),
  v.literal("max"),
)

// ── house rules (the console's taste editor) ────────────────────────────────
// Operator-defined rules the reviewer enforces on every PR, on top of the
// standard review brief (e.g. "no code comments", "no default exports"). The
// level maps a violation onto the review's existing severity machinery:
//   block : violations are posted at P1 — merge blockers, so `await` exits 2
//           and a fix agent picks them up like any other blocker
//   warn  : violations are posted at P2 — noted, never blocking
export const ruleLevel = v.union(v.literal("block"), v.literal("warn"))

// ── house-rule draft transforms (the composer's rewrite / shorten buttons) ──
// A one-shot text transform the console queues and the worker runs through the
// `claude` CLI (Convex can't spawn it) — exactly the reviews/solves intent-queue
// idiom, in miniature: "rewrite" makes a rule more concise, "shorten" cuts it
// further, both to a single plain line. See convex/ruleDrafts.ts.
//   queued  : the composer requested a transform, awaiting the worker
//   running : the worker claimed it and `claude -p` is producing the new text
//   done    : output is ready (the composer drops it into the draft, then discards)
//   failed  : the run errored or produced nothing (error holds the reason)
export const ruleDraftMode = v.union(v.literal("rewrite"), v.literal("shorten"))
export const ruleDraftStatus = v.union(
  v.literal("queued"),
  v.literal("running"),
  v.literal("done"),
  v.literal("failed"),
)

// ── follow-up suggestions ────────────────────────────────────────────────────
// A `suggestedIssues` row is a *proposal* a reviewloop-feature agent emitted at the
// unattended wrap-up of a PR it built — out-of-scope work it deferred, a
// limitation it disclosed, a tangent it noticed. It is NOT a GitHub issue yet:
// the console is the async approval inbox, and only on a human "Open" does the
// worker file it (Convex has no GitHub auth — the worker does, exactly like
// reviews). The lifecycle is two deliberate human gates, no auto-cascade:
//   suggested  : proposed by the agent, awaiting a human decision
//   approved   : human said "open it" — the worker will `gh issue create` it
//   opened      : filed on GitHub (issueNumber set), labelled needs-triage
//   dismissed   : human said no — kept as history, never opened
// Gate 2 lives on an `opened` row: the human picks a triage `label`, and the
// worker propagates it to the real GitHub issue (the solver gates on the real
// `ready-for-agent` label, so this is not cosmetic).
export const suggestionStatus = v.union(
  v.literal("suggested"),
  v.literal("approved"),
  v.literal("opened"),
  v.literal("dismissed"),
)

// What kind of work the follow-up is.
export const suggestionCategory = v.union(
  v.literal("bug"),
  v.literal("enhancement"),
  v.literal("chore"),
)

// How the agent surfaced it while building the PR (drives the source tag).
export const suggestionSource = v.union(
  v.literal("deferred-p2"),
  v.literal("disclosed-limitation"),
  v.literal("build-tangent"),
)

// The triage state-role labels (canonical names; the real GitHub label strings
// are per-repo tracker config). An opened follow-up always starts needs-triage;
// the human promotes it. `ready-for-agent` is what the autonomous solver loop
// gates on — promotion is the deliberate second gate.
//
// Deliberately the HUMAN-SETTABLE subset of the full 6-label vocabulary in
// worker/lib.mjs (STATE_LABELS) — the solver-set labels (agent-in-progress /
// agent-failed) are never chosen from the console, so they aren't valid here.
export const triageLabel = v.union(
  v.literal("needs-triage"),
  v.literal("ready-for-agent"),
  v.literal("ready-for-human"),
  v.literal("wontfix"),
)

// Auto-triage of the inbox (opt-in, see the `triageSettings` table): when the
// operator enables it, the worker runs a one-shot `claude -p` judgment over each
// new `suggested` row and decides gate 1 itself — drop it (dismissed, with the
// agent as decider) or keep it, which auto-approves the row so the worker files
// it on GitHub as if a human had clicked "Open it". Gate 2 (promoting the opened
// issue to ready-for-agent) stays human, so nothing auto-builds. The marker
// lives beside `status`, not inside it, because triage is orthogonal to the
// suggestion lifecycle:
//   (absent)  : never considered (auto-triage off, or not picked up yet)
//   triaging  : a worker claimed it and the judgment run is in flight
//   kept      : the agent decided it's worth tracking (status flips to approved
//               in the same write; the worker then opens the GitHub issue)
//   dropped   : the agent dismissed it (status flips to dismissed in the same
//               write; a human Restore flips it back to suggested and stamps
//               `kept` — without re-approving — so the agent can't re-drop
//               what a human chose to keep)
export const triageState = v.union(
  v.literal("triaging"),
  v.literal("kept"),
  v.literal("dropped"),
)

// The non-system columns of a `suggestedIssues` row.
export const suggestedIssueFields = {
  // source PR provenance — the PR the agent built when it proposed this
  repo: v.string(), // "owner/name"
  sourcePrNumber: v.number(),
  sourceHeadSha: v.string(), // head SHA at proposal time
  sourcePrTitle: v.string(),
  sourcePrUrl: v.string(),
  // the proposal itself
  title: v.string(),
  body: v.string(), // markdown
  category: suggestionCategory,
  source: suggestionSource,
  files: v.array(v.string()), // "files to touch" the brief points a fresh agent at
  // stable idempotency key derived from (repo, sourcePrNumber, title): an agent
  // re-run, or a second reviewloop-feature session, collapses onto the same row instead
  // of double-filing. Also embedded as a marker in the opened issue body so the
  // worker can dedup against GitHub (crash-safety between create and markOpened).
  dedupKey: v.string(),
  status: suggestionStatus,
  proposedBy: v.string(), // agent/host label, like reviews.worker
  createdAt: v.number(),
  // human decision (gate 1): when/who approved or dismissed
  decidedAt: v.optional(v.number()),
  decidedBy: v.optional(v.string()),
  // set by the worker on `opened` — the filed GitHub issue
  issueNumber: v.optional(v.number()),
  // desired triage label (gate 2). On open it's needs-triage; the console picker
  // changes it and the worker propagates the change to GitHub.
  label: v.optional(triageLabel),
  // the label the worker last actually applied on GitHub — drives label sync:
  // a row with label !== appliedLabel needs the worker to `gh issue edit` it.
  appliedLabel: v.optional(triageLabel),
  // worker-loop safety: bounded retries + last error for the GitHub side-effect
  // (issue create / label edit), so a persistent gh failure surfaces instead of
  // spinning the subscription forever.
  attempts: v.optional(v.number()),
  error: v.optional(v.string()),
  // auto-triage of new suggestions — see triageState above. `triagedAt` doubles
  // as the stale-claim boundary (a crashed worker's "triaging" row is requeued by
  // cron); `triageAttempts` bounds retries separately from the GitHub-side
  // `attempts` (which approve() resets) — a failed run's reason lands in the
  // shared `error` field.
  triage: v.optional(triageState),
  triagedAt: v.optional(v.number()),
  triagedBy: v.optional(v.string()), // worker/agent label, like proposedBy
  triageReason: v.optional(v.string()), // the agent's one-line keep/drop rationale
  triageAttempts: v.optional(v.number()),
}

// ── solver checkout registry ─────────────────────────────────────────────────
// Where a solve is allowed to run: a repo → local-path map, keyed by HOST so the
// registry can live in Convex (edited from the console) without breaking the
// "paths are host-specific" invariant — each solver subscribes only to its own
// hostname's rows and ignores the rest. The row is just the *pointer*; the real
// requirement (a clone with node_modules + .env.local) still has to exist on the
// machine, so the solver validates each row on the ground and writes the verdict
// back here for the console to show.
//   ok      : path exists, is a git clone of the mapped repo (statusDetail may
//             carry non-fatal warnings, e.g. "no .env.local")
//   invalid : unusable — statusDetail has the reason; solves for it fail fast
//   (absent): not yet validated by a live solver on that host
export const checkoutStatus = v.union(v.literal("ok"), v.literal("invalid"))

// Autonomous provisioning of the checkout itself — the console registers a repo
// with nothing prepared on disk, and the solver on that host makes it real:
// clone via `gh`, then a one-shot `claude -p` setup agent (install deps, copy
// gitignored env files from a sibling clone of the same repo found by matching
// `git remote origin`, follow the repo's own README setup). Exactly the
// intent-queue idiom of reviews/solves, in miniature:
//   requested    : the console asked; awaiting a solver on that host
//   provisioning : the solver claimed it and is cloning / running setup
//   ready        : prepared and validated — solvable
//   failed       : clone/setup/validation failed (provisionError has the reason)
// Absent = registered by hand against an already-prepared path (or pre-dates
// this field); never touched by the provisioner.
export const provisionState = v.union(
  v.literal("requested"),
  v.literal("provisioning"),
  v.literal("ready"),
  v.literal("failed"),
)

export const solverCheckoutFields = {
  host: v.string(), // os.hostname() of the machine that owns the path
  repo: v.string(), // "owner/name"
  path: v.string(), // local checkout path on that host (~ allowed)
  // Free-text operator notes injected into the solve prompt — per-repo setup
  // quirks the agent should know ("copy these .example files you'll need for
  // debugging", "tests need the emulator running", …).
  instructions: v.optional(v.string()),
  updatedAt: v.number(),
  // validation verdict, written back by the solver (see checkoutStatus above)
  status: v.optional(checkoutStatus),
  statusDetail: v.optional(v.string()),
  validatedAt: v.optional(v.number()),
  // autonomous provisioning lifecycle (see provisionState above)
  provision: v.optional(provisionState),
  // a one-line "what the provisioner is doing right now", streamed while provisioning
  provisionProgress: v.optional(v.string()),
  // the setup agent's final report (what it installed/copied, what stays manual)
  provisionReport: v.optional(v.string()),
  provisionError: v.optional(v.string()),
}

// ── autonomous solver (issue → PR) ───────────────────────────────────────────
// A `solveTasks` row is the third half of the loop: when a GitHub issue carries
// the `ready-for-agent` label (set by the follow-ups gate 2, or manually via the
// triage skill), the solver worker spawns an autonomous `/reviewloop-feature` run that
// builds the feature and opens a PR (`Closes #N`). That PR is then reviewed by the
// existing review half for free. The solver NEVER merges — a human does. Lifecycle:
//   queued    : a webhook (`issues:labeled`) or the reconcile saw a ready-for-agent
//               issue with no live solve yet
//   solving   : the solver claimed it and `claude -p /reviewloop-feature` is running
//   pr-opened : the run finished and the solver located the PR it opened (prNumber
//               set) — the success terminus from the solver's point of view
//   done      : that PR was merged by a human (stamped from the pull_request webhook
//               via markMerged) — closes the issue → solve → PR lineage
//   failed    : the run errored, timed out, opened no PR, or no checkout is
//               registered for the repo on this host
export const solveStatus = v.union(
  v.literal("queued"),
  v.literal("solving"),
  v.literal("pr-opened"),
  v.literal("done"),
  v.literal("failed"),
)

// The non-system columns of a `solveTasks` row — reused by query return validators.
export const solveTaskFields = {
  repo: v.string(), // "owner/name"
  issueNumber: v.number(),
  issueTitle: v.string(),
  issueUrl: v.string(),
  status: solveStatus,
  queuedAt: v.number(),
  startedAt: v.optional(v.number()),
  finishedAt: v.optional(v.number()),
  worker: v.optional(v.string()),
  // a one-line "what the agent is doing right now", streamed during solving
  progress: v.optional(v.string()),
  // the worker-assigned branch the reviewloop-feature agent built on. The worker names it
  // (solve/issue-<N>-<slug>) so it can locate the opened PR by head branch after
  // the run, and clean up the local worktree/branch afterward.
  branch: v.optional(v.string()),
  // the PR the solver opened — the issue → solve → PR lineage anchor. Set on
  // pr-opened; the by_pr index lets the pull_request webhook flip this row to
  // `done` when that PR merges.
  prNumber: v.optional(v.number()),
  prUrl: v.optional(v.string()),
  // worker-loop safety: bounded retries + last error for a failed solve, so a
  // persistently failing issue surfaces its reason instead of being retried forever
  // (mirrors reviews' failed-row retry + suggestedIssues' attempts cap).
  attempts: v.optional(v.number()),
  error: v.optional(v.string()),
}

// One commit in a PR push, captured by the worker from GitHub (the dashboard has
// no GitHub auth of its own) — the commits that landed in a single review turn.
export const commitInfo = v.object({
  sha: v.string(),
  message: v.string(),
  author: v.string(), // GitHub login, or the git author name when unlinked
  avatarUrl: v.optional(v.string()),
  additions: v.number(),
  deletions: v.number(),
})

// The non-system columns of a `reviews` row — reused by query return validators.
export const reviewFields = {
  repo: v.string(), // "owner/name"
  prNumber: v.number(),
  headSha: v.string(),
  title: v.string(),
  author: v.string(),
  prUrl: v.string(),
  status: reviewStatus,
  queuedAt: v.number(),
  startedAt: v.optional(v.number()),
  finishedAt: v.optional(v.number()),
  worker: v.optional(v.string()),
  // a one-line "what the agent is doing right now", streamed during reviewing
  progress: v.optional(v.string()),
  // GitHub's own PR lifecycle timestamps (ms), the anchors for "time to merge"
  // and "open for…". Optional because rows queued before this was added, and
  // reconcile-discovered PRs that miss the value, fall back to queuedAt/updatedAt.
  //   prCreatedAt : pull_request.created_at — when the PR was opened
  //   closedAt    : pull_request.merged_at (merged) or closed_at (closed)
  prCreatedAt: v.optional(v.number()),
  closedAt: v.optional(v.number()),
  // PR lifecycle once GitHub closes it: merged, or closed-without-merging
  prState: v.optional(v.union(v.literal("merged"), v.literal("closed"))),
  // Set when a newer head SHA of the same PR was enqueued while this pass was
  // still `reviewing`: the review under way is of a commit that is no longer
  // the PR's head, so its outcome can only mislead. Enqueue stamps it; the
  // worker sees it (reviews.superseded) and kills the in-flight `claude` run.
  // What happens to the row turns on whether the review landed: stopped before
  // posting -> deleted (reviews.discardSuperseded); review already posted ->
  // finished as `reviewed` and kept — a posted review stays on the dashboard.
  // A still-`queued` stale pass is deleted outright by enqueue instead — this
  // field only ever marks a running one. If the worker died before cancelling,
  // requeueStale deletes the row rather than requeuing it.
  supersededAt: v.optional(v.number()),
  // A fix agent's acknowledgement that it has picked up THIS review pass and is
  // working on the findings (stamped by `reviews.ack` / the `reviewloop-ack` CLI). It's
  // the difference the console can't otherwise know: a `reviewed` row with no ack
  // is "Awaiting agent" (nobody's on it), one with an ack is "In progress". Set
  // only on a `reviewed` row; cleared by `clearStaleAcks` when an ack goes stale
  // (the agent never pushed a fix), so the board never shows a false "In progress".
  //   ackedAt : when the agent acked (ms)
  //   ackedBy : who acked — agent/host label, free-form (e.g. "claude@macbook")
  ackedAt: v.optional(v.number()),
  ackedBy: v.optional(v.string()),
  // A human-requested merge of this PR — the final gate, stamped on the latest
  // reviewed pass by the console Merge button (reviews.requestMerge). Convex only
  // records intent; the worker holds gh auth and runs `gh pr merge` when it sees
  // this via pendingMerges, exactly like ack / suggestedIssues. Cleared on success
  // (the merge webhook then flips prState to "merged"); on failure mergeError holds
  // the reason and mergeAttempts bounds the worker's retries.
  //   mergeRequestedAt : when a human clicked Merge (ms)
  //   mergeRequestedBy : who requested it — free-form label (e.g. "dashboard")
  mergeRequestedAt: v.optional(v.number()),
  mergeRequestedBy: v.optional(v.string()),
  mergeError: v.optional(v.string()),
  mergeAttempts: v.optional(v.number()),
  // results, filled by `finish`
  reviewUrl: v.optional(v.string()),
  // what actually ran this pass, stamped by the worker: the model alias and
  // effort level it passed to `claude -p` (`--model` / `--effort`). Plain
  // strings, not the reviewerModel/reviewerEffort unions — they record what
  // *happened*, which may be a config.json fallback model the picker
  // vocabulary doesn't know. `effort` is absent when none was requested (the
  // CLI's default applied). Distinct from `reviewEffort` below, the agent's
  // self-scored "how hard was this review" out of 5.
  model: v.optional(v.string()),
  effort: v.optional(v.string()),
  confidence: v.optional(v.number()),
  reviewEffort: v.optional(v.number()),
  p0: v.optional(v.number()),
  p1: v.optional(v.number()),
  p2: v.optional(v.number()),
  report: v.optional(v.string()),
  error: v.optional(v.string()),
  // the commits that landed in this push, captured by the worker from GitHub
  commits: v.optional(v.array(commitInfo)),
}

export default defineSchema({
  reviews: defineTable(reviewFields)
    // worker subscription + dashboard board, newest-first within a status
    .index("by_status", ["status", "queuedAt"])
    // dedup key: one review per (repo, PR, head SHA). A prefix lookup on
    // (repo, prNumber) finds every SHA of a PR (used by closePr).
    .index("by_pr_sha", ["repo", "prNumber", "headSha"])
    // rows the console still thinks are alive (prState unset). The reconcile
    // self-heal reads these to catch PRs merged/closed while their webhook was
    // dropped — a prefix on repo + eq(prState, undefined) is the whole scan.
    .index("by_repo_prState", ["repo", "prState"]),

  // The cloud-review session's progress log, one row per appended line. Lives in
  // its own table (not an array on the review row) so it grows without rewriting
  // the review doc or hitting the 1MB document cap — see the schema guideline on
  // unbounded lists. `reviews.progress` still holds the *latest* line for
  // back-compat; this table is the complete, durable history. Ordered by the
  // by_review index, which returns a review's lines in insertion (_creationTime)
  // order.
  reviewLogLines: defineTable({
    reviewId: v.id("reviews"),
    // ms timestamp the append mutation stamped (Convex server time) — drives the
    // ticker's clock column. Within ~the throttle interval of the worker's emit.
    ts: v.number(),
    text: v.string(),
    kind: v.optional(logKind),
  }).index("by_review", ["reviewId"]),

  // Append-only debug log of every webhook GitHub delivered, so wiring problems
  // ("did the event even arrive?") are visible without reading Convex logs.
  webhookDeliveries: defineTable({
    deliveryId: v.string(),
    event: v.string(),
    action: v.optional(v.string()),
    prNumber: v.optional(v.number()),
    outcome: v.string(), // enqueued | duplicate | unwatched | ignored | cancelled | closed | merged | bad-signature
    receivedAt: v.number(),
  }).index("by_received", ["receivedAt"]),

  // Repos this console reviews — the single source of truth for the watch list.
  // Owned by the dashboard (convex/repos.ts add/remove); the worker subscribes to
  // it (repos.list) and reconciles/reviews whatever is here. No worker config file.
  watchedRepos: defineTable({
    repo: v.string(),
    updatedAt: v.number(),
  }),

  // The reviewer's model + effort, picked from the console (settings.ts). At
  // most one row, created on the first pick — no row means "nobody has picked
  // yet", and the worker keeps using its config.json model + the CLI's default
  // effort, so deploying this table never silently overrides an operator's
  // existing config.
  reviewerSettings: defineTable({
    model: reviewerModel,
    effort: reviewerEffort,
    updatedAt: v.number(),
  }),

  // House rules the reviewer enforces (rules.ts) — owned by the console's rules
  // editor, read live by the worker and injected into each review's brief at
  // spawn time. Config-scale like watchedRepos: capped by `add` (MAX_RULES),
  // read in insertion order, no index needed.
  reviewRules: defineTable({
    text: v.string(),
    level: ruleLevel,
    // Scope: absent = global (applies to every watched repo), or "owner/name"
    // to apply to that one repo. The worker filters per review at spawn time
    // (case-insensitive, like the watch list — GitHub slugs are).
    repo: v.optional(v.string()),
    updatedAt: v.number(),
  }),

  // One-shot rewrite/shorten jobs for the house-rules composer — see
  // convex/ruleDrafts.ts. Ephemeral and self-bounding: the composer discards its
  // own row once it consumes the output, and `request` prunes any stale row, so
  // the table stays small without a cleanup cron.
  ruleDrafts: defineTable({
    input: v.string(),
    mode: ruleDraftMode,
    status: ruleDraftStatus,
    output: v.optional(v.string()),
    error: v.optional(v.string()),
    worker: v.optional(v.string()),
    createdAt: v.number(),
  }).index("by_status", ["status", "createdAt"]),

  // The inbox's auto-triage switch + model (suggestedIssues.ts autoTriage/
  // setAutoTriage). At most one row, created on the first toggle/pick — no row
  // means "off", exactly like reviewerSettings' no-row-means-config-default, so
  // deploying this table never starts dismissing anyone's inbox unasked. The
  // model shares the reviewer picker's alias vocabulary; absent until first
  // picked, and the worker then uses its own config fallback.
  triageSettings: defineTable({
    enabled: v.boolean(),
    model: v.optional(reviewerModel),
    updatedAt: v.number(),
  }),

  // Follow-up issue proposals from reviewloop-feature agents — see suggestedIssueFields.
  suggestedIssues: defineTable(suggestedIssueFields)
    // inbox (newest-first within a status) + the worker's claimable-style reads
    .index("by_status", ["status", "createdAt"])
    // dedup + lineage: every suggestion for a source PR (prefix on repo)
    .index("by_source_pr", ["repo", "sourcePrNumber"])
    // idempotency: the `suggest` mutation collapses a re-proposal onto its row
    .index("by_dedup", ["dedupKey"]),

  // The solver checkout registry — see solverCheckoutFields. Owned by the
  // console's editor, read live by each solver via forHost (its own hostname's
  // rows only). Config-scale, bounded by solverCheckouts.ts caps.
  solverCheckouts: defineTable(solverCheckoutFields).index("by_host", ["host"]),

  // Solver hosts that have ever announced themselves (solverCheckouts.hello on
  // startup) — how the console knows which hostnames exist to register
  // checkouts under, even before a host has any. lastSeenAt is the last
  // startup, not a heartbeat — it dates the host, it doesn't prove liveness.
  solverHosts: defineTable({
    host: v.string(),
    lastSeenAt: v.number(),
  }),

  // Autonomous solve tasks — see solveTaskFields.
  solveTasks: defineTable(solveTaskFields)
    // worker subscription + board, newest-first within a status
    .index("by_status", ["status", "queuedAt"])
    // dedup/idempotency + lookup: one live solve per (repo, issueNumber)
    .index("by_repo_issue", ["repo", "issueNumber"])
    // lineage: find the solve that opened a given PR, so the pull_request webhook
    // can flip it to `done` on merge. prNumber is set only once a PR is opened;
    // rows without it index as undefined and are simply never matched here.
    .index("by_pr", ["repo", "prNumber"]),
})
