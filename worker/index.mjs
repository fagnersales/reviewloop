#!/usr/bin/env node
// Event-driven PR-review worker.
//
// Subscribes to the prr-console Convex deployment over its sync websocket and
// reacts to changes instead of polling GitHub:
//   - reviews.claimable  -> claim a queued review, then run `claude -p /pr-review N`
//                           in the target repo, and report the result back.
// A long fallback timer reconciles open PRs via `gh` too, so a webhook missed
// while we were down still gets caught. This replaces the old watch.sh poll loop.

import { ConvexClient } from "convex/browser"
import { api } from "../convex/_generated/api.js"
import { spawn } from "node:child_process"
import { readFileSync, mkdirSync, appendFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { hostname } from "node:os"

const __dirname = dirname(fileURLToPath(import.meta.url))

function loadConfig() {
  const base = JSON.parse(readFileSync(join(__dirname, "config.json"), "utf8"))
  try {
    const local = JSON.parse(
      readFileSync(join(__dirname, "config.local.json"), "utf8"),
    )
    Object.assign(base, local)
  } catch {
    /* no local override */
  }
  return base
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

const cfg = loadConfig()
const CONVEX_URL = process.env.PRR_CONVEX_URL || cfg.convexUrl || envLocalUrl()
const CLAUDE_BIN = process.env.CLAUDE_BIN || cfg.claudeBin || "claude"
const WORKER = hostname()
const LOG_DIR = join(__dirname, "logs")
mkdirSync(LOG_DIR, { recursive: true })

if (!CONVEX_URL) {
  console.error(
    "[prr-worker] no Convex URL. Set PRR_CONVEX_URL, config.convexUrl, or run `npx convex dev` first.",
  )
  process.exit(1)
}

const repoMap = new Map(cfg.repos.map((r) => [r.repo, r.workdir]))
const ts = () => new Date().toISOString().slice(11, 19)
const log = (...a) => console.log(`[${ts()}]`, ...a)

const client = new ConvexClient(CONVEX_URL)

// Reviews this worker is currently running or claiming, by row id.
const inflight = new Set()
const claiming = new Set()
let latestClaimable = []

log(`worker "${WORKER}" up; convex=${CONVEX_URL} concurrency=${cfg.concurrency}`)

// publish the watched repos so the dashboard lists them before any review exists
client
  .mutation(api.repos.setWatched, { repos: cfg.repos.map((r) => r.repo) })
  .catch((e) => log("setWatched failed:", String(e)))

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
  runReview(row).finally(() => {
    inflight.delete(id)
    pump()
  })
}

async function runReview(row) {
  const workdir = repoMap.get(row.repo)
  const short = row.headSha.slice(0, 7)
  if (!workdir) {
    log(`no workdir configured for ${row.repo} — failing #${row.prNumber}`)
    await finish(row, false, { error: `no workdir configured for ${row.repo}` })
    return
  }
  const logFile = join(LOG_DIR, `pr-${row.prNumber}-${short}.log`)
  log(`▶ reviewing ${row.repo}#${row.prNumber} @${short} -> ${logFile}`)

  // stream-json (+ --verbose, required) gives us the agent's step-by-step events
  // so we can surface a live "what it's doing" line to the dashboard.
  const args = [
    "-p",
    `/pr-review ${row.prNumber}`,
    "--permission-mode",
    "bypassPermissions",
    "--model",
    cfg.model,
    "--output-format",
    "stream-json",
    "--verbose",
  ]
  const child = spawn(CLAUDE_BIN, args, { cwd: workdir, env: process.env })

  let finalText = "" // the agent's closing summary (from the result event)
  let lastFullText = "" // fallback report source if no result event
  let resultIsError = false
  let lastLine = "" // newest activity line
  let pushedLine = ""

  // throttle progress writes to ~1/s so a chatty stream doesn't spam mutations
  const flushTimer = setInterval(() => {
    if (lastLine && lastLine !== pushedLine) {
      pushedLine = lastLine
      const line = lastLine
      client.mutation(api.reviews.updateProgress, { id: row._id, line }).catch(() => {})
    }
  }, 1000)

  const onEvent = (evt) => {
    if (evt.type === "assistant" && evt.message?.content) {
      for (const block of evt.message.content) {
        if (block.type === "text" && block.text?.trim()) {
          lastFullText = block.text
          lastLine = firstLine(block.text)
        } else if (block.type === "tool_use") {
          lastLine = describeTool(block.name, block.input)
        }
      }
    } else if (evt.type === "result") {
      if (typeof evt.result === "string") finalText = evt.result
      resultIsError = evt.is_error === true || (evt.subtype && evt.subtype !== "success")
    }
  }

  // stdout is newline-delimited JSON; buffer partial lines across chunks
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
      log(`⏱ timeout #${row.prNumber} after ${cfg.reviewTimeoutMin}m — killing`)
      child.kill("SIGTERM")
    },
    cfg.reviewTimeoutMin * 60 * 1000,
  )

  const code = await new Promise((resolve) => {
    child.on("error", (e) => {
      finalText += `\n[spawn error] ${e}`
      resolve(-1)
    })
    child.on("close", resolve)
  })
  clearTimeout(timeout)
  clearInterval(flushTimer)

  const reviewUrl = await latestReviewUrl(row.repo, row.prNumber, row.headSha)
  const reportText = finalText || lastFullText
  const parsed = parseReport(reportText)
  const report = reportText.slice(-4000)
  const ok = code === 0 && !resultIsError

  if (ok) {
    log(`✓ reviewed #${row.prNumber} (confidence ${parsed.confidence ?? "?"}/5)`)
    await finish(row, true, { reviewUrl, report, ...parsed })
  } else {
    log(`✗ failed #${row.prNumber} (claude exit ${code}${resultIsError ? ", result error" : ""})`)
    await finish(row, false, {
      reviewUrl,
      report,
      ...parsed,
      error: `claude exited ${code}${resultIsError ? " (result error)" : ""}`,
    })
  }
}

// path basename, for compact "Reading <file>" lines
function base(p) {
  return (p || "").split("/").pop() || p || ""
}

// first non-empty line of a block of text, trimmed + clamped
function firstLine(t) {
  const line = (t || "").split("\n").map((s) => s.trim()).find(Boolean) || ""
  return line.slice(0, 240)
}

// a short human label for what a tool call is doing
function describeTool(name, input = {}) {
  switch (name) {
    case "Bash":
      return `$ ${(input.command || "").replace(/\s+/g, " ").slice(0, 180)}`
    case "Read":
      return `Reading ${base(input.file_path)}`
    case "Edit":
    case "MultiEdit":
    case "Write":
      return `Editing ${base(input.file_path)}`
    case "Grep":
      return `Searching "${(input.pattern || "").slice(0, 80)}"`
    case "Glob":
      return `Finding ${input.pattern || ""}`
    case "WebFetch":
      return `Fetching ${input.url || ""}`
    case "WebSearch":
      return `Web search: ${input.query || ""}`
    case "Task":
      return `Subagent: ${input.description || "task"}`
    case "TodoWrite":
      return "Updating its plan"
    default:
      return name?.startsWith("mcp__")
        ? name.replace(/^mcp__/, "").replace(/__/g, " · ")
        : name || "working…"
  }
}

async function finish(row, ok, fields) {
  try {
    await client.mutation(api.reviews.finish, { id: row._id, ok, ...clean(fields) })
  } catch (e) {
    log(`finish error #${row.prNumber}:`, String(e))
  }
}

// drop undefined keys so optional validators are happy
function clean(o) {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined))
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
async function reconcile(reason) {
  for (const { repo } of cfg.repos) {
    const { code, out, err } = await run("gh", [
      "pr",
      "list",
      "--repo",
      repo,
      "--state",
      "open",
      "--json",
      "number,headRefOid,title,author,url,isDraft",
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
        const r = await client.mutation(api.reviews.enqueueMissing, {
          repo,
          prNumber: pr.number,
          headSha: pr.headRefOid,
          title: pr.title ?? "",
          author: pr.author?.login ?? "",
          prUrl: pr.url ?? "",
        })
        if (r === "enqueued") enqueued++
      } catch (e) {
        log(`enqueue error ${repo}#${pr.number}:`, String(e))
      }
    }
    log(`reconcile ${repo} (${reason}): ${prs.length} open, ${enqueued} newly queued`)
  }
}

// ── subscriptions ────────────────────────────────────────────────────────────
client.onUpdate(api.reviews.claimable, {}, (rows) => {
  latestClaimable = rows
  pump()
})

if (cfg.fallbackReconcileMin > 0) {
  setInterval(
    () => reconcile("fallback"),
    cfg.fallbackReconcileMin * 60 * 1000,
  )
}

async function shutdown() {
  log("shutting down")
  await client.close().catch(() => {})
  process.exit(0)
}
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
