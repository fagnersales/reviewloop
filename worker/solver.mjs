#!/usr/bin/env node
// Event-driven autonomous "solver" worker — the third half of the prr-console loop.
//
// The review half reviews PRs; the follow-ups half turns agent proposals into
// `ready-for-agent` issues. This worker closes the loop: when a GitHub issue carries
// the `ready-for-agent` label, it spawns an autonomous `claude -p "/pr-feature …"`
// run that builds the feature and opens a PR (`Closes #N`). That PR is then reviewed
// by the review half **for free**. The solver NEVER merges — a human does.
//
// It subscribes to the prr-console Convex deployment over its sync websocket and
// reacts to changes instead of polling:
//   - solveTasks.claimable -> claim a queued solve, spawn `/pr-feature` against a
//                             configured checkout, capture the PR it opened, report.
//   - repos.list           -> the live watch list (owned by the dashboard). Drives
//                             the `gh issue list --label ready-for-agent` reconcile.
// A long fallback timer reconciles ready-for-agent issues via `gh` too, so a label
// applied while we were down (or with the `issues` webhook event not configured) is
// still caught.
//
// Why this is a SEPARATE process from worker/index.mjs (the review worker):
//   1. Building needs what git does NOT carry — `.env.local` (secrets, the live
//      backend URL), `node_modules`, build caches — so a solve must run in a REAL,
//      configured local checkout, not the review worker's throwaway clone. The
//      repo→path registry is host-specific local config (worker/solver.config.json),
//      never Convex (the dashboard stays host-agnostic).
//   2. A solve runs for tens of minutes to hours; its own process + budget keeps a
//      long solve from starving the fast, cheap reviews.
//
// The elegance: the solver does NOT reimplement build/review/fix. The global
// `pr-feature` skill already does all of it (worktree -> build -> open PR ->
// prr-await loop -> auto-fix -> stop clean). The solver just: find a ready-for-agent
// issue -> claim -> spawn pr-feature in the right folder -> track status -> clean up.

import { ConvexClient } from "convex/browser"
import { api } from "../convex/_generated/api.js"
import { spawn } from "node:child_process"
import {
  readFileSync,
  existsSync,
  statSync,
  mkdirSync,
  appendFileSync,
} from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { hostname, homedir } from "node:os"

const __dirname = dirname(fileURLToPath(import.meta.url))

// ── config ───────────────────────────────────────────────────────────────────
// Solver-specific config lives in its own file (worker/solver.config.json,
// gitignored) — the repo→checkout registry is host-specific, so it must not live
// in Convex. A committed worker/solver.config.example.json documents the shape.
function loadConfig() {
  const defaults = {
    convexUrl: "",
    model: "opus",
    claudeBin: "claude",
    concurrency: 1, // strictly serial by default — see the header note
    solveTimeoutMin: 180, // a whole build + internal review/auto-fix loop
    maxFixRounds: 3,
    fallbackReconcileMin: 20,
    checkouts: {}, // { "owner/name": "/abs/path/to/dedicated-checkout" }
  }
  let cfg = { ...defaults }
  try {
    Object.assign(cfg, JSON.parse(readFileSync(join(__dirname, "solver.config.json"), "utf8")))
  } catch {
    console.warn(
      "[prr-solver] no worker/solver.config.json found — starting with no checkouts.\n" +
        "[prr-solver] copy worker/solver.config.example.json to worker/solver.config.json and add your repo→path map.",
    )
  }
  // Env override for the checkout registry (JSON map), e.g. for CI/host injection.
  if (process.env.PRR_SOLVER_CHECKOUTS) {
    try {
      cfg.checkouts = { ...cfg.checkouts, ...JSON.parse(process.env.PRR_SOLVER_CHECKOUTS) }
    } catch (e) {
      console.warn(`[prr-solver] ignoring invalid PRR_SOLVER_CHECKOUTS JSON: ${e}`)
    }
  }
  return cfg
}

// Pull VITE_CONVEX_URL / CONVEX_URL out of ../.env.local (written by `convex dev`).
function envLocalUrl() {
  try {
    const txt = readFileSync(join(__dirname, "..", ".env.local"), "utf8")
    const get = (k) => txt.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim()
    return get("VITE_CONVEX_URL") || get("CONVEX_URL")
  } catch {
    return undefined
  }
}

// Expand a leading ~ to the home dir; leave the rest of the path untouched.
function expandHome(p) {
  if (typeof p !== "string") return p
  if (p === "~") return homedir()
  if (p.startsWith("~/")) return join(homedir(), p.slice(2))
  return p
}

const cfg = loadConfig()
const CONVEX_URL = process.env.PRR_CONVEX_URL || cfg.convexUrl || envLocalUrl()
const CLAUDE_BIN = process.env.CLAUDE_BIN || cfg.claudeBin || "claude"
const WORKER = `solver@${hostname()}`
const LOG_DIR = join(__dirname, "logs")
mkdirSync(LOG_DIR, { recursive: true })

if (!CONVEX_URL) {
  console.error(
    "[prr-solver] no Convex URL. Set PRR_CONVEX_URL, solver.config.convexUrl, or run `npx convex dev` first.",
  )
  process.exit(1)
}

const ts = () => new Date().toISOString().slice(11, 19)
const log = (...a) => console.log(`[${ts()}]`, ...a)

// Build a case-insensitive registry: lowercased slug -> { slug (canonical), path }.
// GitHub slugs are case-insensitive (matched the same way as convex/repos.ts).
const CHECKOUTS = new Map()
for (const [slug, p] of Object.entries(cfg.checkouts || {})) {
  CHECKOUTS.set(slug.toLowerCase(), { slug, path: expandHome(p) })
}
function checkoutFor(repo) {
  return CHECKOUTS.get(repo.toLowerCase())
}

const client = new ConvexClient(CONVEX_URL)

// Solves this worker is currently running or claiming, by row id.
const inflight = new Set()
const claiming = new Set()
let latestClaimable = []

// The dashboard-owned watch list, kept live via repos.list (see subscriptions).
let watchedRepos = []

log(
  `solver "${WORKER}" up; convex=${CONVEX_URL} concurrency=${cfg.concurrency} ` +
    `checkouts=${CHECKOUTS.size}`,
)

// ── run a shell command, capture output ──────────────────────────────────────
function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env: process.env, ...opts })
    let out = "",
      err = ""
    child.stdout.on("data", (d) => (out += d))
    child.stderr.on("data", (d) => (err += d))
    child.on("error", (e) => resolve({ code: -1, out, err: String(e) }))
    child.on("close", (code) => resolve({ code, out, err }))
  })
}

// ── checkout validation (fail loud) ──────────────────────────────────────────
// Two gates decide whether a ready-for-agent issue is solvable: Convex
// `watchedRepos` ("in the system") and this local checkout registry ("solvable on
// THIS machine"). A repo in the first but not the second fails the task with a
// clear reason rather than silently stalling. Returns { ok, error, warnings }.
async function validateCheckout(slug, path) {
  const warnings = []
  if (!path || !existsSync(path)) return { ok: false, error: `checkout path does not exist: ${path}` }
  try {
    if (!statSync(path).isDirectory()) return { ok: false, error: `checkout path is not a directory: ${path}` }
  } catch (e) {
    return { ok: false, error: `cannot stat checkout path ${path}: ${e}` }
  }
  const gitDir = await run("git", ["-C", path, "rev-parse", "--git-dir"])
  if (gitDir.code !== 0) return { ok: false, error: `not a git repo: ${path}` }
  // The origin remote MUST resolve to the mapped slug — never worktree off the
  // wrong repo. Parse owner/name out of either https or ssh remote URLs.
  const remote = await run("git", ["-C", path, "remote", "get-url", "origin"])
  if (remote.code !== 0) {
    warnings.push("no `origin` remote — cannot confirm it matches the mapped repo")
  } else {
    const got = repoSlugFromUrl((remote.out || "").trim())
    if (got && got.toLowerCase() !== slug.toLowerCase()) {
      return {
        ok: false,
        error: `checkout ${path} origin is ${got}, not the mapped ${slug} — refusing to solve in the wrong repo`,
      }
    }
  }
  if (!existsSync(join(path, ".env.local")))
    warnings.push("no .env.local — a build needing secrets/the live backend URL may fail")
  if (!existsSync(join(path, "node_modules")))
    warnings.push("no node_modules — a build needing deps may fail (run npm install in the checkout)")
  return { ok: true, warnings }
}

// owner/name out of a git remote URL (https or ssh, with/without .git suffix).
function repoSlugFromUrl(url) {
  const m = url.match(/[:/]([^/]+)\/([^/]+?)(?:\.git)?$/)
  return m ? `${m[1]}/${m[2]}` : undefined
}

// Validate every configured checkout at startup; warn loudly, don't exit (a bad
// entry only fails its own repo's solves, not the whole worker).
async function validateAllCheckouts() {
  if (CHECKOUTS.size === 0) {
    log("⚠ no checkouts registered — every ready-for-agent issue will fail with 'no checkout'. Add them to worker/solver.config.json.")
    return
  }
  for (const { slug, path } of CHECKOUTS.values()) {
    const v = await validateCheckout(slug, path)
    if (!v.ok) {
      log(`⚠ checkout ${slug} -> ${path}: ${v.error}`)
    } else {
      const w = v.warnings.length ? ` (warnings: ${v.warnings.join("; ")})` : ""
      log(`✓ checkout ${slug} -> ${path}${w}`)
    }
  }
}

// ── branch naming + the pr-feature brief ─────────────────────────────────────
// A git-ref-safe, length-clamped slug of an issue title.
function slug(s) {
  return (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "")
}

// The worker decides the branch name (rather than letting the skill auto-name it)
// so it can locate the PR by head branch after the run, and clean up the local
// worktree/branch afterward. Also future-proofs per-repo parallelism (unique per
// issue).
function branchFor(issueNumber, title) {
  const s = slug(title)
  return `solve/issue-${issueNumber}${s ? `-${s}` : ""}`
}

// The prompt handed to `/pr-feature`. Self-contained: the issue context, the
// solver-specific overrides (exact branch name, Closes #N, the fix-round cap, the
// never-merge rule), and the unattended framing. `pr-feature` is a global skill, so
// `claude -p "/pr-feature …"` resolves it on this host.
function solvePrompt(row, branch, issueBody, maxFixRounds) {
  return `/pr-feature Solve issue #${row.issueNumber} in ${row.repo} and open a PR for it.

You are running UNATTENDED (no human is watching this turn) as the prr-console
autonomous solver. Build the change the issue asks for, open a PR that closes the
issue, and let the existing review loop review it. Do NOT merge — a human merges.

## The issue you are solving
- Repo: \`${row.repo}\`
- Issue: #${row.issueNumber} — ${row.issueTitle || "(no title)"}
- Issue URL: ${row.issueUrl || `https://github.com/${row.repo}/issues/${row.issueNumber}`}

--- issue body ---
${issueBody && issueBody.trim() ? issueBody.trim() : "(no body)"}
--- end issue body ---

## Solver requirements (these override the skill's defaults where they conflict)
- When you call **EnterWorktree**, name the worktree/branch **exactly** \`${branch}\`
  — do not auto-name it. The solver locates the PR you open by this head branch.
- Put a \`Closes #${row.issueNumber}\` line in the **PR body** (use \`gh pr create --body\`,
  not a bare \`--fill\`) so the merge auto-closes the issue.
- Pass \`--repo ${row.repo}\` on \`gh\` commands.
- Auto-fix review blockers for **at most ${maxFixRounds} round(s)**, then stop and
  leave the PR for a human even if it isn't fully clean — do not loop indefinitely.
- **NEVER merge**, and never push to the default branch. Stop once the PR is open and
  the review has settled (clean, or the fix-round cap is reached).
- At wrap-up, flush any out-of-scope follow-ups via \`prr-suggest\` as usual.`
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
    won = await client.mutation(api.solveTasks.claim, { id, worker: WORKER })
  } catch (e) {
    log(`claim error #${row.issueNumber}:`, String(e))
  }
  claiming.delete(id)
  if (!won) return
  inflight.add(id)
  runSolve(row).finally(() => {
    inflight.delete(id)
    pump()
  })
}

async function progress(row, line) {
  client.mutation(api.solveTasks.setProgress, { id: row._id, line }).catch(() => {})
}

async function finish(row, outcome, fields = {}) {
  try {
    await client.mutation(api.solveTasks.finish, {
      id: row._id,
      outcome,
      ...clean(fields),
    })
  } catch (e) {
    log(`finish error #${row.issueNumber}:`, String(e))
  }
}

// drop undefined keys so optional validators are happy
function clean(o) {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined))
}

// Best-effort note on the issue when a solve attempt ran but stalled (timeout / no
// PR / claude error) — so a human sees *where* it stopped without digging through
// worker logs. Not for config failures (no checkout) — those are an operator
// concern, surfaced in the logs, not the issue thread.
async function commentStall(repo, issueNumber, body) {
  await run("gh", ["issue", "comment", String(issueNumber), "--repo", repo, "--body", body])
}

// The heart: spawn `/pr-feature` against the configured checkout for this repo.
async function runSolve(row) {
  const co = checkoutFor(row.repo)
  if (!co) {
    log(`✗ no checkout registered for ${row.repo} (#${row.issueNumber}) — failing task`)
    await finish(row, "failed", {
      error: `no solver checkout registered for ${row.repo} on this host (add it to worker/solver.config.json)`,
    })
    return
  }

  // Re-validate this checkout right before use (it may have moved/been deleted
  // since startup). A bad checkout fails the task with the reason, not silently.
  const valid = await validateCheckout(co.slug, co.path)
  if (!valid.ok) {
    log(`✗ checkout invalid for ${row.repo} (#${row.issueNumber}): ${valid.error}`)
    await finish(row, "failed", { error: `checkout invalid: ${valid.error}` })
    return
  }
  if (valid.warnings?.length) log(`⚠ ${row.repo} checkout: ${valid.warnings.join("; ")}`)

  const branch = branchFor(row.issueNumber, row.issueTitle)
  const logFile = join(LOG_DIR, `solve-${row.issueNumber}-${branch.replace(/[^a-z0-9]+/gi, "-")}.log`)
  log(`▶ solving ${row.repo}#${row.issueNumber} on ${branch} (cwd ${co.path}) -> ${logFile}`)

  try {
    // Fetch latest so the worktree branches off the freshest origin/<default>.
    await progress(row, "Fetching latest from origin")
    const fetched = await run("git", ["-C", co.path, "fetch", "origin", "--prune"])
    if (fetched.code !== 0) {
      log(`⚠ git fetch failed in ${co.path}: ${(fetched.err || "").trim().split("\n").pop()}`)
    }

    // Fetch the issue body for the brief.
    const issueBody = await fetchIssueBody(row.repo, row.issueNumber)

    const prompt = solvePrompt(row, branch, issueBody, cfg.maxFixRounds)
    const ok = await spawnPrFeature(row, co.path, prompt, logFile)

    // The agent opened (or failed to open) the PR internally; find it by head branch.
    await progress(row, "Locating the opened PR")
    const pr = await capturePr(row.repo, branch, row.issueNumber)

    if (pr) {
      log(`✓ ${row.repo}#${row.issueNumber} -> PR #${pr.number} (${branch})`)
      await finish(row, "pr-opened", { branch, prNumber: pr.number, prUrl: pr.url })
    } else {
      const why = ok
        ? "the solve run finished but no PR was found for the issue"
        : "the solve run did not complete (claude errored or timed out)"
      log(`✗ ${row.repo}#${row.issueNumber}: ${why}`)
      await finish(row, "failed", { branch, error: why })
      await commentStall(
        row.repo,
        row.issueNumber,
        `🤖 prr-console solver could not finish this autonomously: ${why}. ` +
          `Branch \`${branch}\` may hold partial work. A human can take it from here.`,
      ).catch(() => {})
    }
  } finally {
    // Always clean up the local worktree + local branch in the dedicated checkout.
    // The remote branch (and its PR, if opened) is left intact for the human.
    await cleanupWorktree(co.path, branch).catch((e) =>
      log(`cleanup error ${row.repo}#${row.issueNumber}:`, String(e)),
    )
  }
}

// Spawn `claude -p "/pr-feature …"` in the checkout, stream a live "what it's doing"
// line to the dashboard, enforce the solve timeout. Returns true on a clean exit.
function spawnPrFeature(row, cwd, prompt, logFile) {
  const args = [
    "-p",
    prompt,
    "--permission-mode",
    "bypassPermissions",
    "--model",
    cfg.model,
    "--output-format",
    "stream-json",
    "--verbose",
  ]
  // PRR_UNATTENDED=1 is the spawn contract: it tells pr-feature it's headless, so it
  // flushes follow-ups via prr-suggest without waiting for a human and skips
  // human-facing chatter. PRR_MAX_FIX_ROUNDS forwards the cap (the prompt also states
  // it, which is authoritative).
  const env = {
    ...process.env,
    PRR_UNATTENDED: "1",
    PRR_MAX_FIX_ROUNDS: String(cfg.maxFixRounds),
  }
  const child = spawn(CLAUDE_BIN, args, { cwd, env })

  let resultIsError = false
  let lastLine = ""
  let pushedLine = ""

  // throttle progress writes to ~1/s
  const flushTimer = setInterval(() => {
    if (lastLine && lastLine !== pushedLine) {
      pushedLine = lastLine
      progress(row, lastLine)
    }
  }, 1000)

  const onEvent = (evt) => {
    if (evt.type === "assistant" && evt.message?.content) {
      for (const block of evt.message.content) {
        if (block.type === "text" && block.text?.trim()) {
          lastLine = firstLine(block.text)
        } else if (block.type === "tool_use") {
          lastLine = describeTool(block.name, block.input)
        }
      }
    } else if (evt.type === "result") {
      resultIsError = evt.is_error === true || (evt.subtype && evt.subtype !== "success")
    }
  }

  let pending = ""
  child.stdout.on("data", (d) => {
    const s = d.toString()
    try {
      appendFileSync(logFile, s)
    } catch {
      /* best effort */
    }
    pending += s
    let nl
    while ((nl = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, nl)
      pending = pending.slice(nl + 1)
      if (!line.trim()) continue
      try {
        onEvent(JSON.parse(line))
      } catch {
        /* non-JSON noise */
      }
    }
  })
  child.stderr.on("data", (d) => {
    try {
      appendFileSync(logFile, d)
    } catch {
      /* best effort */
    }
  })

  const timeout = setTimeout(
    () => {
      log(`⏱ timeout #${row.issueNumber} after ${cfg.solveTimeoutMin}m — killing`)
      child.kill("SIGTERM")
    },
    cfg.solveTimeoutMin * 60 * 1000,
  )

  return new Promise((resolve) => {
    child.on("error", (e) => {
      log(`spawn error #${row.issueNumber}: ${e}`)
      clearTimeout(timeout)
      clearInterval(flushTimer)
      resolve(false)
    })
    child.on("close", (code) => {
      clearTimeout(timeout)
      clearInterval(flushTimer)
      resolve(code === 0 && !resultIsError)
    })
  })
}

// ── PR capture (issue -> PR lineage) ─────────────────────────────────────────
// Primary: the PR whose head branch is the one we assigned. Fallback: scan recent
// PRs for one that references this issue (head-branch match or a Closes/Fixes line),
// in case the agent named the branch differently than asked.
async function capturePr(repo, branch, issueNumber) {
  const byHead = await run("gh", [
    "pr", "list", "--repo", repo, "--head", branch,
    "--state", "all", "--json", "number,url,state", "--limit", "10",
  ])
  const pick = (arr) => {
    if (!Array.isArray(arr) || arr.length === 0) return undefined
    const open = arr.find((p) => p.state === "OPEN")
    const chosen = open ?? arr[arr.length - 1]
    return chosen?.number != null ? { number: chosen.number, url: chosen.url } : undefined
  }
  if (byHead.code === 0) {
    try {
      const found = pick(JSON.parse(byHead.out))
      if (found) return found
    } catch {
      /* fall through */
    }
  }

  // Fallback: recent PRs referencing the issue.
  const recent = await run("gh", [
    "pr", "list", "--repo", repo, "--state", "all",
    "--json", "number,url,headRefName,body", "--limit", "50",
  ])
  if (recent.code !== 0) return undefined
  try {
    const arr = JSON.parse(recent.out)
    const ref = new RegExp(`\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+#${issueNumber}\\b`, "i")
    const hit = arr.find(
      (p) => p.headRefName === branch || (typeof p.body === "string" && ref.test(p.body)),
    )
    return hit?.number != null ? { number: hit.number, url: hit.url } : undefined
  } catch {
    return undefined
  }
}

async function fetchIssueBody(repo, issueNumber) {
  const r = await run("gh", [
    "issue", "view", String(issueNumber), "--repo", repo, "--json", "body",
  ])
  if (r.code !== 0) return ""
  try {
    return JSON.parse(r.out)?.body ?? ""
  } catch {
    return ""
  }
}

// ── worktree / branch cleanup ────────────────────────────────────────────────
// After each solve, remove the local worktree + local branch in the dedicated
// checkout (the remote branch + PR live on GitHub for the human). Targeted by
// branch via `git worktree list --porcelain`, so it works whatever path
// EnterWorktree chose.
async function cleanupWorktree(checkout, branch) {
  const list = await run("git", ["-C", checkout, "worktree", "list", "--porcelain"])
  if (list.code === 0) {
    for (const path of worktreePathsForBranch(list.out, branch)) {
      const rm = await run("git", ["-C", checkout, "worktree", "remove", "--force", path])
      if (rm.code === 0) log(`🧹 removed worktree ${path}`)
    }
  }
  await run("git", ["-C", checkout, "worktree", "prune"])
  // Delete the LOCAL branch only — never the remote (it backs the PR).
  await run("git", ["-C", checkout, "branch", "-D", branch])
}

// Parse `git worktree list --porcelain` into the worktree dirs on a given branch.
function worktreePathsForBranch(porcelain, branch) {
  const want = `refs/heads/${branch}`
  const paths = []
  let curPath
  for (const line of (porcelain || "").split("\n")) {
    if (line.startsWith("worktree ")) curPath = line.slice("worktree ".length).trim()
    else if (line.startsWith("branch ") && line.slice("branch ".length).trim() === want && curPath)
      paths.push(curPath)
    else if (line.trim() === "") curPath = undefined
  }
  return paths
}

// Crash backstop: at startup, sweep stale `solve/issue-*` worktrees in every
// configured checkout (a crash can leave one behind). Age-bounded by the solve
// timeout + margin so a concurrent/live solve's worktree is never swept.
async function sweepStaleWorktrees() {
  const staleMs = (Number(cfg.solveTimeoutMin) + 60) * 60 * 1000
  const now = Date.now()
  for (const { path: checkout } of CHECKOUTS.values()) {
    const list = await run("git", ["-C", checkout, "worktree", "list", "--porcelain"])
    if (list.code !== 0) continue
    let swept = 0
    for (const { dir, branch } of solveWorktrees(list.out)) {
      try {
        if (now - statSync(dir).mtimeMs < staleMs) continue
      } catch {
        continue
      }
      const rm = await run("git", ["-C", checkout, "worktree", "remove", "--force", dir])
      if (rm.code === 0) {
        await run("git", ["-C", checkout, "branch", "-D", branch])
        swept++
      }
    }
    await run("git", ["-C", checkout, "worktree", "prune"])
    if (swept) log(`swept ${swept} stale solve worktree(s) from ${checkout}`)
  }
}

// All worktrees whose branch is a solve branch, as { dir, branch }.
function solveWorktrees(porcelain) {
  const out = []
  let curPath
  for (const line of (porcelain || "").split("\n")) {
    if (line.startsWith("worktree ")) curPath = line.slice("worktree ".length).trim()
    else if (line.startsWith("branch ")) {
      const ref = line.slice("branch ".length).trim()
      if (curPath && ref.startsWith("refs/heads/solve/issue-"))
        out.push({ dir: curPath, branch: ref.slice("refs/heads/".length) })
    } else if (line.trim() === "") curPath = undefined
  }
  return out
}

// ── reconcile: enqueue any open ready-for-agent issue missing from the queue ──
async function reconcile(reason) {
  const repos = watchedRepos
  if (repos.length === 0) {
    log(`reconcile (${reason}): watch list empty — nothing to scan`)
    return
  }
  for (const repo of repos) {
    const r = await run("gh", [
      "issue", "list", "--repo", repo, "--state", "open",
      "--label", "ready-for-agent", "--json", "number,title,url", "--limit", "50",
    ])
    if (r.code !== 0) {
      log(`reconcile ${repo} failed:`, (r.err || "").trim().split("\n").pop())
      continue
    }
    let issues = []
    try {
      issues = JSON.parse(r.out)
    } catch {
      continue
    }
    let enqueued = 0
    for (const issue of issues) {
      try {
        const res = await client.mutation(api.solveTasks.enqueueMissing, {
          repo,
          issueNumber: issue.number,
          issueTitle: issue.title ?? "",
          issueUrl: issue.url ?? "",
        })
        if (res === "enqueued") enqueued++
      } catch (e) {
        log(`enqueue error ${repo}#${issue.number}:`, String(e))
      }
    }
    log(`reconcile ${repo} (${reason}): ${issues.length} ready-for-agent, ${enqueued} newly queued`)
  }
}

// ── subscriptions ────────────────────────────────────────────────────────────
client.onUpdate(api.solveTasks.claimable, {}, (rows) => {
  latestClaimable = rows
  pump()
})

// The dashboard-owned watch list. A change refreshes our copy and, when the set
// actually changed (including first load), kicks an immediate reconcile.
client.onUpdate(api.repos.list, {}, (repos) => {
  const next = repos ?? []
  const changed =
    next.length !== watchedRepos.length || next.some((r, i) => r !== watchedRepos[i])
  watchedRepos = next
  if (changed) {
    log(`watch list (${next.length}): ${next.length ? next.join(", ") : "(empty)"}`)
    reconcile("watch-change")
  }
})

if (cfg.fallbackReconcileMin > 0) {
  setInterval(() => reconcile("fallback"), cfg.fallbackReconcileMin * 60 * 1000)
}

// One-time startup: validate checkouts + sweep crash leftovers.
validateAllCheckouts()
sweepStaleWorktrees().catch((e) => log("sweep error:", String(e)))

async function shutdown() {
  log("shutting down")
  await client.close().catch(() => {})
  process.exit(0)
}
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
