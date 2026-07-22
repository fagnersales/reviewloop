#!/usr/bin/env node
// Event-driven PR-review worker.
//
// Subscribes to the reviewloop Convex deployment over its sync websocket and
// reacts to changes instead of polling GitHub:
//   - reviews.claimable  -> claim a queued review, then run `claude -p "<review
//                           instructions>"` against a fresh clone of the target
//                           repo, and report the result back.
//   - repos.list         -> the live watch list (owned by the dashboard). Drives
//                           the `gh` reconcile; a change re-reconciles at once.
//   - suggestedIssues.approvedToOpen / .labelToSync -> the GitHub side of the
//                           PR-follow-ups loop: file human-approved proposals as
//                           `needs-triage` issues (gate 1), and propagate a human's
//                           triage-label choice to the real issue (gate 2). The
//                           console only records intent; this worker holds gh auth.
// A long fallback timer reconciles open PRs via `gh` too, so a webhook missed
// while we were down still gets caught. This replaces the old watch.sh poll loop.
//
// Two things this worker deliberately does NOT need anymore:
//   1. A per-repo `workdir`. Each review clones the repo into a throwaway temp
//      dir (blobless partial clone, so history for git log/blame still works) and
//      deletes it when done — so a repo only has to be on the watch list, never
//      checked out on this host.
//   2. The `reviewloop-review` skill installed in the target repo. The review
//      instructions live in this console (.claude/skills/reviewloop-review/SKILL.md) and
//      are passed inline as the prompt, so any watched repo is reviewable as-is.

import { ConvexClient } from "convex/browser"
import { api } from "../convex/_generated/api.js"
import {
  readFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  readdirSync,
  statSync,
} from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { hostname, tmpdir } from "node:os"
import {
  loadConfig,
  resolveConvexUrl,
  run,
  errorReason,
  log,
  clean,
  streamClaude,
  ensureLabel,
  setStateLabel,
} from "./lib.mjs"

const __dirname = dirname(fileURLToPath(import.meta.url))

const cfg = loadConfig()
const CONVEX_URL = resolveConvexUrl(cfg)
const CLAUDE_BIN = process.env.CLAUDE_BIN || cfg.claudeBin || "claude"
// Model for the house-rules composer's rewrite/shorten transforms — a one-line
// rewrite wants speed, not the review model, so this defaults to a fast tier
// independent of the reviewer picker.
const DRAFT_MODEL = process.env.REVIEWLOOP_DRAFT_MODEL || cfg.draftModel || "haiku"
const WORKER = hostname()
const LOG_DIR = join(__dirname, "logs")
mkdirSync(LOG_DIR, { recursive: true })

if (!CONVEX_URL) {
  console.error(
    "[reviewloop-worker] no Convex URL. Set REVIEWLOOP_CONVEX_URL, config.convexUrl, or run `npx convex dev` first.",
  )
  process.exit(1)
}

// Where the inline review instructions come from: this console's own reviewloop-review
// skill body (frontmatter stripped). One source of truth — the target repo no
// longer needs the skill installed for the worker to review it.
const SKILL_FILE = join(__dirname, "..", ".claude", "skills", "reviewloop-review", "SKILL.md")

// Throwaway clones live here, one per review, each dir named `reviewloop-review-*`.
const CLONE_PREFIX = "reviewloop-review-"
const CLONE_BASE = process.env.REVIEWLOOP_CLONE_DIR || cfg.cloneDir || tmpdir()
mkdirSync(CLONE_BASE, { recursive: true })

// The review instructions, loaded once: the reviewloop-review skill body, minus two
// interactive bits that don't apply to an automated, no-human run —
//   - the YAML frontmatter, and
//   - the "## Inputs" section, which resolves *which* PR to review (and may "ask
//     the user which one"). The PR is supplied explicitly by reviewPrompt's
//     "This run" appendix, so leaving Inputs in only creates an instruction
//     conflict. (SKILL.md keeps it for interactive /reviewloop-review use.)
// A loud failure here beats every review silently failing.
let REVIEW_SKILL
try {
  REVIEW_SKILL = readFileSync(SKILL_FILE, "utf8")
    .replace(/^---\n[\s\S]*?\n---\n/, "")
    .replace(/\n## Inputs\n[\s\S]*?(?=\n## )/, "\n")
    .trim()
  if (!REVIEW_SKILL) throw new Error("empty after stripping frontmatter")
} catch (e) {
  console.error(`[reviewloop-worker] cannot read review instructions at ${SKILL_FILE}: ${e}`)
  process.exit(1)
}

const client = new ConvexClient(CONVEX_URL)

// Reviews this worker is currently running or claiming, by row id.
const inflight = new Set()
const claiming = new Set()

// Clone dirs of in-flight reviews, and the signal that kills their `claude`
// children on shutdown. `process.exit` in shutdown() skips runReview's
// `finally`, so those dirs must be removed there — otherwise every graceful
// stop with a review in flight leaks a clone until the next startup sweep.
const activeClones = new Set()
const shutdownController = new AbortController()
let latestClaimable = []

// One AbortController per in-flight run, by review row id — aborting one
// SIGTERMs that run's `claude` child. shutdown() aborts them all; the
// `superseded` subscription aborts a single run whose head SHA a newer push
// replaced mid-review (its post-run path then discards the row).
const runControllers = new Map()
// Row ids currently marked superseded (reviews.superseded), kept as a set so a
// supersede that lands between winning a claim and registering the run's
// controller is still caught at spawn time.
let supersededIds = new Set()

// Suggested-issue rows the worker is mid-side-effect on (creating the GitHub
// issue, or syncing its label), by row id — so a re-fired subscription doesn't
// double-process one. Cheap gh calls, so no concurrency cap is needed.
const processingSuggestions = new Set()

// Review rows we're mid-merge on, by row id — so a re-fired pendingMerges
// subscription doesn't fire a second `gh pr merge` for the same PR.
const processingMerges = new Set()

// House-rule draft transforms (rewrite/shorten) we're mid-run on, by row id — so
// a re-fired ruleDrafts.claimable subscription doesn't spawn a second `claude`.
const processingDrafts = new Set()

// The dashboard-owned watch list, kept live via repos.list (see subscriptions).
// Drives the `gh` reconcile; the queue itself decides what actually gets reviewed.
let watchedRepos = []

// The console-owned reviewer settings (the model + effort picker), kept live via
// settings.get. Null until a human picks in the dashboard — reviews started
// before then use cfg.model and the CLI's default effort. Read at spawn time,
// so a change applies to the next review, never one already running.
let reviewerSettings = null

// The console-owned house rules (the taste editor), kept live via rules.list —
// the full set, global and repo-scoped; rulesForRepo filters per review. The
// applicable rules are injected into the review brief at spawn time — same
// contract as the settings: a change applies to the next review, never one
// already running.
let houseRules = []

log(`worker "${WORKER}" up; convex=${CONVEX_URL} concurrency=${cfg.concurrency}`)

// A crash can leave a clone behind; clear strays before we start making more.
sweepStaleClones()

// ── repo clone + review prompt ───────────────────────────────────────────────
// Blobless partial clone into `dir`: fast, but keeps full commit history so the
// skill's `git log`/`git blame`/`git show origin/<head>:path` all work (blobs are
// fetched lazily as needed). `gh repo clone` carries the user's gh auth, so
// private repos clone too. Returns { ok, error }.
async function cloneRepo(repo, dir) {
  const { code, err } = await run("gh", [
    "repo",
    "clone",
    repo,
    dir,
    "--",
    "--filter=blob:none",
    "--no-tags",
  ])
  if (code === 0) return { ok: true }
  return { ok: false, error: errorReason(err, `gh repo clone exited ${code}`) }
}

// The house rules that apply to one repo: the global ones (no scope) plus the
// ones scoped to it. Case-insensitive, like the watch list — GitHub slugs are.
function rulesForRepo(rules, repo) {
  const target = repo.toLowerCase()
  return rules.filter((r) => !r.repo || r.repo.toLowerCase() === target)
}

// The operator's house rules as a brief section, or "" when none apply.
// Levels ride the skill's existing severity machinery — a [BLOCK] violation is a
// P1 (a merge blocker, so `await` exits 2 and a fix agent picks it up), a [WARN]
// violation is a P2 — so no downstream parsing changes.
function houseRulesSection(rules) {
  if (!rules.length) return ""
  const lines = rules.map((r) => `- [${r.level.toUpperCase()}] ${r.text}`).join("\n")
  return `

---

## House rules

The operator of this review console defined house rules for this codebase. They
are review policy, not suggestions: check every line the PR adds or modifies
against each rule, and flag violations even where you'd personally disagree with
the rule.

${lines}

- A violation of a **[BLOCK]** rule is an inline comment at **P1** — it is a
  merge blocker. A violation of a **[WARN]** rule is an inline comment at
  **P2**. Don't downgrade a violation because the rule seems minor; the operator
  chose the level. Escalate only if the same code is also a real bug in its own
  right.
- Name the rule in the comment title so the author knows policy triggered it,
  e.g. \`House rule "no code comments": explanatory comment added in parseFoo\`.
  Use type Style unless the violation is also a Logic/Syntax problem.
- Only flag code this PR adds or touches — pre-existing violations elsewhere in
  the repo are out of scope.
- Weigh [BLOCK] violations into the confidence score like any other P1.`
}

// The inline review brief: the skill body, plus the specifics of this PR so the
// agent never depends on a skill argument or the local working tree.
function reviewPrompt(row) {
  const prUrl = row.prUrl || `https://github.com/${row.repo}/pull/${row.prNumber}`
  return `${REVIEW_SKILL}

---

## This run

You are running as an automated reviewer inside a fresh, throwaway clone of
**${row.repo}**, checked out at its default branch. There is no human in the loop
and no \`/reviewloop-review\` skill installed — the instructions above are the whole brief.

- Repo: \`${row.repo}\`
- PR to review: **#${row.prNumber}** — ${row.title || "(no title)"}
- PR URL: ${prUrl}
- Head commit under review: \`${row.headSha}\`

The local checkout is the default branch, **not** the PR branch, so read the PR's
actual contents from \`origin\` with \`gh\`/\`git\` as the instructions describe. When a
\`gh\` command needs the repo, it is \`${row.repo}\` (pass \`--repo ${row.repo}\`). Post
exactly one \`COMMENT\` review to GitHub, then close your message with the review
URL, the confidence score, the review-effort score, and the P0/P1/P2 counts.${houseRulesSection(rulesForRepo(houseRules, row.repo))}`
}

// Remove `reviewloop-review-*` clone dirs left in CLONE_BASE by a prior crash. Bounded
// by age so a concurrent worker's *live* clone (always younger than the review
// timeout) is never swept — multiple workers may share CLONE_BASE.
function sweepStaleClones() {
  let entries
  try {
    entries = readdirSync(CLONE_BASE, { withFileTypes: true })
  } catch {
    return
  }
  // Guard the default: a missing/NaN reviewTimeoutMin would make `staleMs` NaN,
  // the age check always false-y, and could sweep a concurrent worker's live clone.
  const timeoutMin = Number.isFinite(cfg.reviewTimeoutMin) ? cfg.reviewTimeoutMin : 25
  const staleMs = (timeoutMin + 30) * 60 * 1000
  const now = Date.now()
  let swept = 0
  for (const e of entries) {
    if (!e.isDirectory() || !e.name.startsWith(CLONE_PREFIX)) continue
    const p = join(CLONE_BASE, e.name)
    try {
      if (now - statSync(p).mtimeMs < staleMs) continue
      rmSync(p, { recursive: true, force: true })
      swept++
    } catch {
      /* best effort */
    }
  }
  if (swept) log(`swept ${swept} stale clone dir(s) from ${CLONE_BASE}`)
}

// ── claim + run loop ─────────────────────────────────────────────────────────
function capacity() {
  return cfg.concurrency - inflight.size - claiming.size
}

function pump() {
  for (const row of latestClaimable) {
    if (capacity() <= 0) break
    const id = row._id
    if (inflight.has(id) || claiming.has(id)) continue
    claimAndRun(row)
  }
}

async function claimAndRun(row) {
  const id = row._id
  claiming.add(id)
  let won = false
  try {
    won = await client.mutation(api.reviews.claim, { id, worker: WORKER })
  } catch (e) {
    log(`claim error #${row.prNumber}:`, String(e))
  }
  claiming.delete(id)
  if (!won) return
  inflight.add(id)
  const controller = new AbortController()
  runControllers.set(id, controller)
  if (supersededIds.has(id) || shutdownController.signal.aborted) controller.abort()
  // Capture this push's commits alongside the review (don't block it on GitHub).
  captureCommits(row).catch((e) => log(`captureCommits error #${row.prNumber}:`, String(e)))
  runReview(row, controller.signal).finally(() => {
    runControllers.delete(id)
    inflight.delete(id)
    pump()
  })
}

// A newer push replaced this pass's head and the run was stopped before its
// review posted: report that upstream, which deletes the row (and its log) so
// the board shows only the live pass. Only review-less runs land here — one
// whose review made it to GitHub is finished and kept instead (see the
// supersede branch in reviewClone).
async function discardSuperseded(row) {
  try {
    await client.mutation(api.reviews.discardSuperseded, { id: row._id })
  } catch (e) {
    log(`discardSuperseded error #${row.prNumber}:`, String(e))
  }
}

// Clone the PR's repo into a throwaway dir, review it there, then delete the dir.
// The clone — not a configured workdir — is the only code-on-disk a review needs.
async function runReview(row, signal) {
  const short = row.headSha.slice(0, 7)
  // Superseded before we even spawned (the claim raced a new push) — skip the
  // clone entirely and drop the pass.
  if (signal.aborted && !shutdownController.signal.aborted) {
    log(`✂ superseded #${row.prNumber} @${short} before start — discarding pass`)
    await discardSuperseded(row)
    return
  }
  const cloneDir = mkdtempSync(join(CLONE_BASE, CLONE_PREFIX))
  activeClones.add(cloneDir)
  try {
    log(`⬇ cloning ${row.repo} for #${row.prNumber} @${short} -> ${cloneDir}`)
    const cloned = await cloneRepo(row.repo, cloneDir)
    if (!cloned.ok) {
      log(`✗ clone failed ${row.repo}#${row.prNumber}: ${cloned.error}`)
      await finish(row, false, { error: `clone failed: ${cloned.error}` })
      return
    }
    await reviewClone(row, short, cloneDir, signal)
  } finally {
    activeClones.delete(cloneDir)
    try {
      rmSync(cloneDir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }
}

async function reviewClone(row, short, cloneDir, signal) {
  const logFile = join(LOG_DIR, `pr-${row.prNumber}-${short}.log`)
  // Local wall-clock start of this run — the "was that review ours?" boundary
  // for the superseded-but-posted check below.
  const startedAt = Date.now()
  // The console picker (settings.get subscription) wins once a human has picked;
  // until then, config.json's model and the CLI's own default effort apply.
  const model = reviewerSettings?.model ?? cfg.model
  const effort = reviewerSettings?.effort
  log(`▶ reviewing ${row.repo}#${row.prNumber} @${short} [${model}${effort ? ` · ${effort}` : ""}] -> ${logFile}`)

  // stream-json (+ --verbose, required) gives us the agent's step-by-step events
  // so we can surface a live "what it's doing" line to the dashboard. The review
  // brief is passed inline (no /reviewloop-review skill needed in the target repo).
  const args = [
    "-p",
    reviewPrompt(row),
    "--permission-mode",
    "bypassPermissions",
    "--model",
    model,
    "--output-format",
    "stream-json",
    "--verbose",
  ]
  if (effort) args.push("--effort", effort)
  const r = await streamClaude({
    claudeBin: CLAUDE_BIN,
    args,
    cwd: cloneDir,
    logFile,
    timeoutMs: cfg.reviewTimeoutMin * 60 * 1000,
    signal,
    onTimeout: () => log(`⏱ timeout #${row.prNumber} after ${cfg.reviewTimeoutMin}m — killing`),
    onProgress: (line) =>
      client.mutation(api.reviews.updateProgress, { id: row._id, line }).catch(() => {}),
  })
  const { code, resultIsError, lastFullText } = r
  const finalText = r.spawnError ? `${r.finalText}\n[spawn error] ${r.spawnError}` : r.finalText

  // A newer push superseded this head mid-run. Whether the pass survives turns
  // on one thing: did the review land? A pass is discarded only when it was
  // stopped before posting anything; a posted review is history the dashboard
  // keeps, so that pass is finished normally instead. Three cases:
  //   - exited cleanly before the kill won the race -> fall through, normal finish
  //   - killed, but a review posted since we started (SIGTERM caught the agent
  //     mid-closing-summary, after `gh` posted) -> finish as reviewed with it
  //   - killed with nothing posted -> discard the pass
  // (Shutdown aborts land here too but exit the process before this matters.)
  if (signal.aborted && !shutdownController.signal.aborted) {
    const completed = code === 0 && !resultIsError
    if (!completed) {
      const postedUrl = await reviewPostedSince(row.repo, row.prNumber, startedAt)
      if (!postedUrl) {
        log(`✂ superseded #${row.prNumber} @${short} — run stopped, pass discarded`)
        await discardSuperseded(row)
        return
      }
      log(`✂ superseded #${row.prNumber} @${short} — run stopped, but its review had posted; keeping the pass`)
      const reportText = finalText || lastFullText
      const parsed = parseReport(reportText)
      await client
        .mutation(api.reviews.updateProgress, {
          id: row._id,
          line: "Review posted (run superseded during wrap-up)",
          kind: "done",
        })
        .catch(() => {})
      await finish(row, true, {
        reviewUrl: postedUrl,
        report: reportText.slice(-4000),
        ...parsed,
        model,
        effort,
      })
      return
    }
    log(`✂ supersede for #${row.prNumber} @${short} arrived after the run finished — keeping the pass`)
  }

  const reviewUrl = await latestReviewUrl(row.repo, row.prNumber, row.headSha)
  const reportText = finalText || lastFullText
  const parsed = parseReport(reportText)
  const report = reportText.slice(-4000)
  const ok = code === 0 && !resultIsError

  // Cap the durable log with a terminal, kinded line. The cloud-log console
  // renders the dot in its severity colour (green "done" / red "error"), so the
  // full log has a clear end marker — and this is the line that makes the
  // ticker's severity rendering live (plain progress lines carry no kind). It
  // must go out *before* `finish` flips the row out of "reviewing", after which
  // updateProgress is a no-op.
  const endLine = ok
    ? `Review posted${parsed.confidence != null ? ` · confidence ${parsed.confidence}/5` : ""}`
    : `Review run did not complete (claude exit ${code}${resultIsError ? ", result error" : ""})`
  await client
    .mutation(api.reviews.updateProgress, {
      id: row._id,
      line: endLine,
      kind: ok ? "done" : "error",
    })
    .catch(() => {})

  if (ok) {
    log(`✓ reviewed #${row.prNumber} (confidence ${parsed.confidence ?? "?"}/5)`)
    await finish(row, true, { reviewUrl, report, ...parsed, model, effort })
  } else {
    log(`✗ failed #${row.prNumber} (claude exit ${code}${resultIsError ? ", result error" : ""})`)
    await finish(row, false, {
      reviewUrl,
      report,
      ...parsed,
      model,
      effort,
      error: `claude exited ${code}${resultIsError ? " (result error)" : ""}`,
    })
  }
}

async function finish(row, ok, fields) {
  try {
    await client.mutation(api.reviews.finish, { id: row._id, ok, ...clean(fields) })
  } catch (e) {
    log(`finish error #${row.prNumber}:`, String(e))
  }
}

// A GitHub review on this PR submitted after `sinceMs` -> its html_url, else
// undefined. Used by the supersede path to ask "did the killed run post its
// review first?" — with supersede in place at most one run reviews a PR at a
// time, so any review newer than our start is ours. Timestamp, not commit_id:
// GitHub stamps a review with the PR head at submission, which is already the
// *new* SHA when a push raced in. The 5s slack absorbs worker/GitHub clock
// skew but stays well under the enqueue->claim->spawn gap that separates this
// run's start from the previous pass's review.
async function reviewPostedSince(repo, prNumber, sinceMs) {
  const { code, out } = await run("gh", ["api", `repos/${repo}/pulls/${prNumber}/reviews`])
  if (code !== 0) return undefined
  try {
    const arr = JSON.parse(out)
    if (!Array.isArray(arr)) return undefined
    const ours = arr.filter((r) => Date.parse(r.submitted_at ?? "") >= sinceMs - 5000)
    return ours.length ? ours[ours.length - 1]?.html_url : undefined
  } catch {
    return undefined
  }
}

// Latest review GitHub holds for this PR at the reviewed SHA -> its html_url.
async function latestReviewUrl(repo, prNumber, headSha) {
  const { code, out } = await run("gh", [
    "api",
    `repos/${repo}/pulls/${prNumber}/reviews`,
  ])
  if (code !== 0) return undefined
  try {
    const arr = JSON.parse(out)
    if (!Array.isArray(arr) || arr.length === 0) return undefined
    const atSha = arr.filter((r) => r.commit_id === headSha)
    const pick = (atSha.length ? atSha : arr)[Math.max(0, (atSha.length ? atSha : arr).length - 1)]
    return pick?.html_url
  } catch {
    return undefined
  }
}

// Capture the commits that landed in this push (this review turn) and store them
// on the row, so the dashboard can show their message/author/LOC without its own
// GitHub auth. One GraphQL call gets the PR's commits with per-commit LOC; we then
// slice to just the commits after the previous pass's head. Best-effort: any
// failure here is logged and dropped — it never blocks or fails the review.
async function captureCommits(row) {
  const [owner, name] = row.repo.split("/")
  if (!owner || !name) return
  const query = `query($owner:String!,$name:String!,$num:Int!){
    repository(owner:$owner,name:$name){
      pullRequest(number:$num){
        commits(last:100){ nodes{ commit{
          oid messageHeadline additions deletions
          author{ name avatarUrl user{ login } }
        }}}
      }
    }
  }`
  const { code, out, err } = await run("gh", [
    "api",
    "graphql",
    "-f",
    `query=${query}`,
    "-f",
    `owner=${owner}`,
    "-f",
    `name=${name}`,
    "-F",
    `num=${row.prNumber}`,
  ])
  if (code !== 0) {
    log(`captureCommits #${row.prNumber}: gh graphql failed:`, errorReason(err, `exit ${code}`))
    return
  }
  let nodes
  try {
    nodes = JSON.parse(out)?.data?.repository?.pullRequest?.commits?.nodes
  } catch {
    return
  }
  if (!Array.isArray(nodes)) return
  const all = nodes.map((n) => n.commit).filter(Boolean)
  if (all.length === 0) return

  // Slice to this turn: everything after the previous pass's head, up to this head.
  let prior = null
  try {
    prior = await client.query(api.reviews.priorHead, {
      repo: row.repo,
      prNumber: row.prNumber,
      headSha: row.headSha,
      queuedAt: row.queuedAt,
    })
  } catch {
    /* no prior boundary -> treat the whole list as this turn */
  }
  let turn = all
  if (prior) {
    const idx = all.findIndex((c) => c.oid === prior)
    if (idx >= 0) turn = all.slice(idx + 1)
  }
  const headIdx = turn.findIndex((c) => c.oid === row.headSha)
  if (headIdx >= 0) turn = turn.slice(0, headIdx + 1)
  if (turn.length === 0) return

  const commits = turn.map((c) => {
    const entry = {
      sha: c.oid,
      message: c.messageHeadline || "(no message)",
      author: c.author?.user?.login || c.author?.name || "unknown",
      additions: c.additions ?? 0,
      deletions: c.deletions ?? 0,
    }
    if (c.author?.avatarUrl) entry.avatarUrl = c.author.avatarUrl
    return entry
  })
  try {
    await client.mutation(api.reviews.setCommits, { id: row._id, commits })
    log(`captured ${commits.length} commit(s) for #${row.prNumber} @${row.headSha.slice(0, 7)}`)
  } catch (e) {
    log(`setCommits error #${row.prNumber}:`, String(e))
  }
}

// Best-effort scrape of the skill's closing chat report (it reports confidence,
// review-effort, and P0/P1/P2 counts). The wording isn't fixed, so we try both
// adjacency orders for the counts ("3 P0" and "P0: 3"). Missing fields stay
// undefined — the authoritative signal is the GitHub review link, not this.
function parseReport(text) {
  const num = (re) => {
    const m = text.match(re)
    return m ? Number(m[1]) : undefined
  }
  // count adjacent to a label, either side: "3 P0" / "3× P0" / "P0: 3" / "P0 (3)"
  const count = (label) =>
    num(new RegExp(`(\\d+)\\s*(?:×|x)?\\s*${label}\\b`, "i")) ??
    num(new RegExp(`\\b${label}\\b[^\\dA-Za-z]{0,6}(\\d+)`, "i"))
  return {
    confidence: num(/confidence(?:\s*score)?[^0-9]{0,12}(\d(?:\.\d)?)\s*\/\s*5/i),
    reviewEffort: num(/review[\s-]*effort[^0-9]{0,12}(\d(?:\.\d)?)\s*\/\s*5/i),
    p0: count("P0"),
    p1: count("P1"),
    p2: count("P2"),
  }
}

// ── rescan: enqueue any open, non-draft PR missing from the queue ────────────
// Iterates the live, dashboard-owned watch list (watchedRepos), not a file.
async function reconcile(reason) {
  const repos = watchedRepos
  if (repos.length === 0) {
    log(`reconcile (${reason}): watch list empty — nothing to scan`)
    return
  }
  for (const repo of repos) {
    const { code, out, err } = await run("gh", [
      "pr",
      "list",
      "--repo",
      repo,
      "--state",
      "open",
      "--json",
      "number,headRefOid,title,author,url,isDraft,createdAt",
    ])
    if (code !== 0) {
      log(`reconcile ${repo} failed:`, err.trim())
      continue
    }
    let prs = []
    try {
      prs = JSON.parse(out)
    } catch {
      continue
    }
    let enqueued = 0
    for (const pr of prs) {
      if (pr.isDraft) continue
      try {
        const createdMs = Date.parse(pr.createdAt ?? "")
        const r = await client.mutation(api.reviews.enqueueMissing, {
          repo,
          prNumber: pr.number,
          headSha: pr.headRefOid,
          title: pr.title ?? "",
          author: pr.author?.login ?? "",
          prUrl: pr.url ?? "",
          prCreatedAt: Number.isNaN(createdMs) ? undefined : createdMs,
        })
        if (r === "enqueued") enqueued++
      } catch (e) {
        log(`enqueue error ${repo}#${pr.number}:`, String(e))
      }
    }

    // Self-heal dropped *close* webhooks: any PR the console still thinks is
    // alive but GitHub no longer lists as open was merged/closed while its
    // `closed` delivery was lost. Stamp the real state so it stops showing
    // VERIFIED forever. (Mirrors the enqueueMissing self-heal for dropped
    // `synchronize` deliveries, on the other side of the lifecycle.)
    const openSet = new Set(prs.map((p) => p.number))
    let healed = 0
    try {
      const live = await client.query(api.reviews.livePrNumbers, { repo })
      for (const prNumber of live) {
        if (openSet.has(prNumber)) continue
        const { code: vc, out: vout } = await run("gh", [
          "pr",
          "view",
          String(prNumber),
          "--repo",
          repo,
          "--json",
          "state,mergedAt,closedAt",
        ])
        if (vc !== 0) continue
        let info
        try {
          info = JSON.parse(vout)
        } catch {
          continue
        }
        // OPEN here means the open-list fetch simply raced a just-opened PR —
        // leave it for a delivered webhook / the next tick.
        const state = info.state === "MERGED" ? "merged" : info.state === "CLOSED" ? "closed" : null
        if (!state) continue
        const stamp = Date.parse((state === "merged" ? info.mergedAt : info.closedAt) ?? "")
        await client.mutation(api.reviews.markPrState, {
          repo,
          prNumber,
          state,
          at: Number.isNaN(stamp) ? undefined : stamp,
        })
        healed++
      }
    } catch (e) {
      log(`reconcile ${repo} close-heal error:`, String(e))
    }
    log(
      `reconcile ${repo} (${reason}): ${prs.length} open, ${enqueued} newly queued` +
        (healed ? `, ${healed} close-healed` : ""),
    )
  }
}

// ── suggested-issue side-effects (gate 1: open · gate 2: label) ──────────────
// The console only records *intent* (Convex has no GitHub auth — the worker does,
// exactly like reviews). The worker watches two claimable-style queries and does
// the GitHub side: file approved proposals as issues, and propagate the human's
// triage-label choice to the real issue (which the solver loop reads).

// The state-role label vocabulary and swap logic live in ./lib.mjs
// (STATE_LABELS / setStateLabel) — shared with worker/solver.mjs so the two
// workers can never disagree on the mutually-exclusive label set.

// The GitHub issue body for an opened proposal: the brief a *fresh* agent reads
// (no prior knowledge of the source PR), plus a machine-readable dedup marker so
// a re-run / a crash between create and markOpened can't double-file. The issue
// *title* is row.title (passed to `gh issue create --title`), so it's not repeated
// here — this is just the body.
function suggestedIssueBody(row) {
  const files =
    row.files && row.files.length
      ? `\n\n**Files to touch:** ${row.files.map((f) => `\`${f}\``).join(", ")}`
      : ""
  return `${row.body}${files}

---

## Source PR (context for a fresh agent)

This issue was proposed by an automated agent **while it built the PR below**. You are a fresh session with **no prior knowledge of that work** — read this before implementing.

- Repo: \`${row.repo}\`
- Source PR: #${row.sourcePrNumber} — ${row.sourcePrTitle}
- PR URL: ${row.sourcePrUrl}
- Head commit when proposed: \`${row.sourceHeadSha.slice(0, 7)}\`
- Proposed category: ${row.category} · Flagged as: ${row.source}

<!-- reviewloop-suggest:${row.dedupKey} -->
`
}

// `gh issue create` prints the new issue's URL; pull the number out of it.
function parseIssueNumber(out) {
  const m = (out || "").match(/\/issues\/(\d+)/)
  return m ? Number(m[1]) : undefined
}

// Crash-safety dedup: if an issue carrying this proposal's marker already exists
// on GitHub (we created it but died before markOpened), adopt its number instead
// of filing a second one. Best-effort — a miss just falls through to create, and
// the in-Convex dedupKey already prevents duplicate rows.
async function findIssueByMarker(repo, dedupKey) {
  const { code, out } = await run("gh", [
    "issue",
    "list",
    "--repo",
    repo,
    "--state",
    "all",
    "--search",
    dedupKey,
    "--json",
    "number,body",
    "--limit",
    "20",
  ])
  if (code !== 0) return undefined
  try {
    const arr = JSON.parse(out)
    return arr.find(
      (i) => typeof i.body === "string" && i.body.includes(`reviewloop-suggest:${dedupKey}`),
    )?.number
  } catch {
    return undefined
  }
}

async function recordSuggestionError(row, error) {
  await client
    .mutation(api.suggestedIssues.recordWorkerError, { id: row._id, error })
    .catch((e) => log(`recordWorkerError error #${row.sourcePrNumber}:`, String(e)))
}

// Gate 1: file an approved proposal as a needs-triage GitHub issue, then mark it
// opened (which stamps the issue number + needs-triage as the applied label).
async function openSuggestedIssue(row) {
  const id = row._id
  if (processingSuggestions.has(id)) return
  processingSuggestions.add(id)
  try {
    const existing = await findIssueByMarker(row.repo, row.dedupKey)
    if (existing != null) {
      log(`↺ proposal already on GitHub as ${row.repo}#${existing} — adopting`)
      await client.mutation(api.suggestedIssues.markOpened, { id, issueNumber: existing })
      return
    }
    await ensureLabel(row.repo, "needs-triage")
    const { code, out, err } = await run("gh", [
      "issue",
      "create",
      "--repo",
      row.repo,
      "--title",
      row.title,
      "--body",
      suggestedIssueBody(row),
      "--label",
      "needs-triage",
    ])
    if (code !== 0) {
      const reason = errorReason(err, `gh issue create exited ${code}`)
      log(`✗ open issue failed ${row.repo} «${row.title}»: ${reason}`)
      await recordSuggestionError(row, `gh issue create: ${reason}`)
      return
    }
    const issueNumber = parseIssueNumber(out)
    if (issueNumber == null) {
      await recordSuggestionError(row, `could not parse issue number from: ${(out || "").trim().slice(0, 200)}`)
      return
    }
    log(`✓ opened ${row.repo}#${issueNumber} (needs-triage) from PR #${row.sourcePrNumber}`)
    await client.mutation(api.suggestedIssues.markOpened, { id, issueNumber })
  } catch (e) {
    await recordSuggestionError(row, String(e))
  } finally {
    processingSuggestions.delete(id)
  }
}

// Gate 2: propagate the human's triage-label choice to the real GitHub issue —
// add the desired label, remove whichever other state labels are present, then
// mark it applied. This is what hands a follow-up to the solver (ready-for-agent).
async function syncSuggestedLabel(row) {
  const id = row._id
  if (processingSuggestions.has(id)) return
  if (row.issueNumber == null || row.label == null) return
  processingSuggestions.add(id)
  try {
    const desired = row.label
    const r = await setStateLabel(row.repo, row.issueNumber, desired)
    if (!r.ok) {
      log(`✗ label sync failed ${row.repo}#${row.issueNumber}: ${r.reason}`)
      await recordSuggestionError(row, `gh issue edit: ${r.reason}`)
      return
    }
    log(`✓ ${row.repo}#${row.issueNumber} label → ${desired}`)
    await client.mutation(api.suggestedIssues.markLabelApplied, { id, label: desired })
  } catch (e) {
    await recordSuggestionError(row, String(e))
  } finally {
    processingSuggestions.delete(id)
  }
}

// ── PR merge (the final human gate, via the console Merge button) ────────────
// The console records intent (reviews.requestMerge); this worker holds gh auth and
// runs the actual merge. `gh pr merge` enforces branch protection / required checks
// server-side, so an unmergeable PR fails here with a reason (surfaced in the
// console) rather than being force-merged. Squash + delete-branch mirrors the
// reviewloop-feature merge convention.
async function doMerge(row) {
  const id = row._id
  if (processingMerges.has(id)) return
  processingMerges.add(id)
  try {
    const { code, err } = await run("gh", [
      "pr",
      "merge",
      String(row.prNumber),
      "--repo",
      row.repo,
      "--squash",
      "--delete-branch",
    ])
    if (code !== 0) {
      const reason = errorReason(err, `gh pr merge exited ${code}`)
      log(`✗ merge failed ${row.repo}#${row.prNumber}: ${reason}`)
      await client
        .mutation(api.reviews.recordMergeError, { id, error: reason })
        .catch((e) => log(`recordMergeError #${row.prNumber}:`, String(e)))
      return
    }
    log(`✓ merged ${row.repo}#${row.prNumber} (squash + delete branch)`)
    await client
      .mutation(api.reviews.markMergeDone, { id })
      .catch((e) => log(`markMergeDone #${row.prNumber}:`, String(e)))
  } catch (e) {
    await client.mutation(api.reviews.recordMergeError, { id, error: String(e) }).catch(() => {})
  } finally {
    processingMerges.delete(id)
  }
}

// ── house-rule draft transforms (the composer's rewrite/shorten buttons) ─────
// Convex can't spawn `claude`, so the composer queues a one-shot text transform
// (ruleDrafts) and this worker — which holds the CLI — runs it and writes the new
// text back. A pure text rewrite: no clone, no tools, just a prompt in and one
// clean line out.
const DRAFT_INSTRUCTION = {
  rewrite:
    "Rewrite the house rule below to be more concise and direct while preserving its exact meaning, scope, and any specific names, values, or examples it mentions.",
  shorten:
    "Shorten the house rule below to the fewest words that still preserve its meaning, scope, and any specific names, values, or examples it mentions.",
}

function draftPrompt(mode, input) {
  return `You are editing a single house rule for an automated code reviewer. ${DRAFT_INSTRUCTION[mode]}

Output ONLY the resulting rule as one line of plain text — no markdown, no surrounding quotes, no bullet, no label, no preamble, and no trailing commentary.

Rule:
${input}`
}

// Collapse the model's answer to the single clean line the composer expects:
// strip a wrapping pair of quotes it may have added, and flatten any whitespace.
function cleanDraft(text) {
  let s = (text || "").trim()
  const first = s[0]
  if (s.length >= 2 && (first === '"' || first === "'") && s.at(-1) === first) {
    s = s.slice(1, -1).trim()
  }
  return s.replace(/\s+/g, " ").trim()
}

async function processDraft(row) {
  const id = row.id
  if (processingDrafts.has(id)) return
  processingDrafts.add(id)
  try {
    let won = false
    try {
      won = await client.mutation(api.ruleDrafts.claim, { id, worker: WORKER })
    } catch (e) {
      log(`draft claim error:`, String(e))
    }
    if (!won) return
    log(`✎ ${row.mode} house-rule draft (${row.input.length} chars) [${DRAFT_MODEL}]`)
    const { code, out, err } = await run(
      CLAUDE_BIN,
      ["-p", draftPrompt(row.mode, row.input), "--output-format", "text", "--model", DRAFT_MODEL],
      { timeout: 90_000 },
    )
    const output = cleanDraft(out)
    if (code === 0 && output) {
      log(`✓ ${row.mode} draft → ${output.length} chars`)
      await client
        .mutation(api.ruleDrafts.finish, { id, ok: true, output })
        .catch((e) => log(`draft finish error:`, String(e)))
    } else {
      const reason = code === 0 ? "produced no text" : errorReason(err, `claude exited ${code}`)
      log(`✗ ${row.mode} draft failed: ${reason}`)
      await client
        .mutation(api.ruleDrafts.finish, { id, ok: false, error: reason })
        .catch((e) => log(`draft finish error:`, String(e)))
    }
  } finally {
    processingDrafts.delete(id)
  }
}

// ── subscriptions ────────────────────────────────────────────────────────────
client.onUpdate(api.reviews.claimable, {}, (rows) => {
  latestClaimable = rows
  pump()
})

// Reviewing passes a newer push has superseded. Abort the matching in-flight
// run — its post-run path discards the row. Rows we don't hold belong to
// another (possibly dead) worker; requeueStale cleans those up server-side.
client.onUpdate(api.reviews.superseded, {}, (rows) => {
  supersededIds = new Set(rows.map((r) => r._id))
  for (const row of rows) {
    const controller = runControllers.get(row._id)
    if (controller && !controller.signal.aborted) {
      log(`✂ new push on ${row.repo}#${row.prNumber} — stopping review of @${row.headSha.slice(0, 7)}`)
      controller.abort()
    }
  }
})

// Human-requested merges to execute on GitHub. The in-flight guard means a re-fire
// while one is mid-merge is a no-op.
client.onUpdate(api.reviews.pendingMerges, {}, (rows) => {
  for (const row of rows) {
    doMerge(row).catch((e) => log(`doMerge error #${row.prNumber}:`, String(e)))
  }
})

// Approved proposals to file on GitHub (gate 1), and opened issues whose label the
// human changed and we haven't propagated yet (gate 2). The in-flight guard means
// a re-fire while one is mid-create/mid-edit is a no-op.
client.onUpdate(api.suggestedIssues.approvedToOpen, {}, (rows) => {
  for (const row of rows) {
    openSuggestedIssue(row).catch((e) => log(`openSuggestedIssue error #${row.sourcePrNumber}:`, String(e)))
  }
})
client.onUpdate(api.suggestedIssues.labelToSync, {}, (rows) => {
  for (const row of rows) {
    syncSuggestedLabel(row).catch((e) => log(`syncSuggestedLabel error #${row.sourcePrNumber}:`, String(e)))
  }
})

// The house-rules composer's rewrite/shorten requests. The in-flight guard means
// a re-fire while one is mid-run is a no-op.
client.onUpdate(api.ruleDrafts.claimable, {}, (rows) => {
  for (const row of rows) {
    processDraft(row).catch((e) => log(`processDraft error:`, String(e)))
  }
})

// The dashboard-owned watch list. Each change refreshes our copy and, when the
// set actually changed (including the first load), kicks an immediate reconcile
// so a newly added repo's open PRs are queued at once — not up to a fallback
// interval later. `repos.list` returns a sorted array, so index compare is sound.
client.onUpdate(api.repos.list, {}, (repos) => {
  const next = repos ?? []
  const changed =
    next.length !== watchedRepos.length ||
    next.some((r, i) => r !== watchedRepos[i])
  watchedRepos = next
  if (changed) {
    log(`watch list (${next.length}): ${next.length ? next.join(", ") : "(empty)"}`)
    reconcile("watch-change")
  }
})

// The console's reviewer model/effort picker. Applied per spawn (see
// reviewClone), so no re-pump is needed here — in-flight reviews keep the
// model they started with.
client.onUpdate(api.settings.get, {}, (s) => {
  const next = s ?? null
  const changed = next?.model !== reviewerSettings?.model || next?.effort !== reviewerSettings?.effort
  reviewerSettings = next
  if (changed && next) log(`reviewer settings: model=${next.model} effort=${next.effort}`)
})

// The console's house-rules editor. Applied per spawn (reviewPrompt), so like
// the settings no re-pump is needed — in-flight reviews keep the brief they
// started with.
client.onUpdate(api.rules.list, {}, (rules) => {
  const next = rules ?? []
  const changed =
    next.length !== houseRules.length ||
    next.some(
      (r, i) =>
        r.text !== houseRules[i].text || r.level !== houseRules[i].level || r.repo !== houseRules[i].repo,
    )
  houseRules = next
  if (changed)
    log(
      `house rules (${next.length}): ${next.map((r) => `[${r.level}${r.repo ? `@${r.repo}` : ""}] ${r.text}`).join(" · ") || "(none)"}`,
    )
})

if (cfg.fallbackReconcileMin > 0) {
  setInterval(
    () => reconcile("fallback"),
    cfg.fallbackReconcileMin * 60 * 1000,
  )
}

async function shutdown() {
  log("shutting down")
  // Kill in-flight `claude` children (via each run's spawn signal) and remove
  // their clone dirs — their rows stay `reviewing` and the stale-review cron
  // requeues them, but the dirs would otherwise leak past this process's
  // lifetime. shutdownController is aborted first so the runs' post-abort
  // checks read this as a shutdown, not a supersede.
  shutdownController.abort()
  for (const controller of runControllers.values()) controller.abort()
  for (const dir of activeClones) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }
  await client.close().catch(() => {})
  process.exit(0)
}
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
