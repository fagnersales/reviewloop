// Shared runtime for the worker set (index/solver daemons, await/ack/suggest
// CLIs). Everything here used to be copy-pasted per script; a convention change
// (config shape, spawn idiom, stream-json parsing, label vocabulary) now edits
// this one module.

import { spawn } from "node:child_process"
import { readFileSync, appendFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import os from "node:os"

const __dirname = dirname(fileURLToPath(import.meta.url))

// ── config + convex url ──────────────────────────────────────────────────────

// worker/config.json with an optional gitignored config.local.json overlay.
// (The solver's config is genuinely different — its own file, defaults, and env
// override — so it keeps its own loader and shares only the URL resolution.)
export function loadConfig() {
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
export function envLocalUrl() {
  try {
    const txt = readFileSync(join(__dirname, "..", ".env.local"), "utf8")
    const get = (k) => txt.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim()
    return get("VITE_CONVEX_URL") || get("CONVEX_URL")
  } catch {
    return undefined
  }
}

// The one precedence order every script agrees on: env var > config > .env.local.
export function resolveConvexUrl(cfg) {
  // PRR_CONVEX_URL is the pre-rename (prr-console) name, honored for compat.
  return process.env.REVIEWLOOP_CONVEX_URL || process.env.PRR_CONVEX_URL || cfg.convexUrl || envLocalUrl()
}

// ── child processes: run / gh ────────────────────────────────────────────────

// Run a command, capture output. Never rejects — a spawn failure resolves with
// code -1 and the error text in `err`.
export function run(cmd, args, opts = {}) {
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

export function gh(args, opts = {}) {
  return run("gh", args, opts)
}

// `gh ...` -> trimmed stdout, or undefined on any failure.
export async function ghText(args) {
  const { code, out } = await gh(args)
  if (code !== 0) return undefined
  return (out || "").trim() || undefined
}

// `gh ... --json <fields>` parsed to an object (undefined on any failure).
export async function ghJson(args) {
  const { code, out } = await gh(args)
  if (code !== 0) return undefined
  try {
    return JSON.parse(out || "")
  } catch {
    return undefined
  }
}

// The last non-empty stderr line — the human-readable reason a CLI failed.
export function errorReason(err, fallback) {
  return (err || "").trim().split("\n").pop() || fallback
}

// ── misc shared helpers ──────────────────────────────────────────────────────

// The trailing Z marks these as UTC, so log lines correlate with GitHub/Convex
// timestamps without guessing the machine's offset.
export const ts = () => new Date().toISOString().slice(11, 19) + "Z"
export const log = (...a) => console.log(`[${ts()}]`, ...a)

// drop undefined keys so optional Convex validators are happy
export function clean(o) {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined))
}

// Default actor label for ack/suggest: who's doing this. Free-form; display only.
export function defaultBy() {
  const user = process.env.USER || os.userInfo?.().username
  const host = os.hostname?.()
  if (user && host) return `${user}@${host}`
  return user || host || "agent"
}

// ── stream-json labeling ─────────────────────────────────────────────────────

// path basename, for compact "Reading <file>" lines
function base(p) {
  return (p || "").split("/").pop() || p || ""
}

// first non-empty line of a block of text, trimmed + clamped
export function firstLine(t) {
  const line = (t || "").split("\n").map((s) => s.trim()).find(Boolean) || ""
  return line.slice(0, 240)
}

// a short human label for what a tool call is doing — drives the live progress line
export function describeTool(name, input = {}) {
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

// ── claude stream runner ─────────────────────────────────────────────────────

// Spawn a `claude -p … --output-format stream-json` run and drive its whole
// lifecycle: append raw output to `logFile`, parse the newline-delimited JSON,
// keep a live "what it's doing" label (throttled to ~1/s through `onProgress`,
// deduped), enforce a timeout (SIGTERM after `onTimeout`), and resolve with the
// outcome. Never rejects — a spawn failure resolves with code -1 and the error
// in `spawnError`.
//
// Returns { code, resultIsError, finalText, lastFullText, spawnError }:
//   - finalText     the agent's closing summary (from the result event)
//   - lastFullText  the last full assistant text block, a fallback report source
//   - resultIsError the result event carried is_error / a non-success subtype
export function streamClaude({
  claudeBin,
  args,
  cwd,
  env,
  logFile,
  timeoutMs,
  onTimeout,
  onProgress,
  signal,
}) {
  // `signal` (optional AbortSignal) SIGTERMs the child when aborted — the
  // worker's shutdown path uses it so an orphaned `claude -p` doesn't keep
  // reviewing (and posting) after the worker is gone.
  const child = spawn(claudeBin, args, { cwd, env: env ?? process.env, signal })

  let finalText = ""
  let lastFullText = ""
  let resultIsError = false
  let spawnError
  let lastLine = "" // newest activity line
  let pushedLine = ""

  // throttle progress pushes to ~1/s so a chatty stream doesn't spam mutations
  const flushTimer = setInterval(() => {
    if (lastLine && lastLine !== pushedLine) {
      pushedLine = lastLine
      onProgress?.(lastLine)
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

  const timeout = setTimeout(() => {
    onTimeout?.()
    child.kill("SIGTERM")
  }, timeoutMs)

  return new Promise((resolve) => {
    const finish = (code) => {
      clearTimeout(timeout)
      clearInterval(flushTimer)
      resolve({ code, resultIsError, finalText, lastFullText, spawnError })
    }
    child.on("error", (e) => {
      spawnError = e
      finish(-1)
    })
    child.on("close", finish)
  })
}

// ── GitHub issue label state machine ─────────────────────────────────────────

// The state-role labels (mutually exclusive — an issue carries exactly one).
// This is the CANONICAL 6-label vocabulary; both workers drive transitions
// through it. The human-set triage subset (needs-triage / ready-for-agent /
// ready-for-human / wontfix) is restated as `triageLabel` in convex/schema.ts
// and as the console picker in src/follow-ups/kit.tsx — those are the
// console-settable subset, deliberately narrower than this list.
//
// Lifecycle: needs-triage →(human)→ ready-for-agent →(solver claims)→
// agent-in-progress →(PR opened)→ ready-for-human, or →(failed)→ agent-failed.
// `ready-for-agent` only ever means "waiting, claimable".
export const STATE_LABELS = [
  "needs-triage",
  "ready-for-agent",
  "agent-in-progress",
  "ready-for-human",
  "agent-failed",
  "wontfix",
]
export const LABEL_COLORS = {
  "needs-triage": "fbca04",
  "ready-for-agent": "5319e7",
  "agent-in-progress": "1d76db",
  "ready-for-human": "0e8a16",
  "agent-failed": "d73a4a",
  wontfix: "ffffff",
}

// Best-effort: make sure the label exists on the repo before we add it. `--force`
// creates it if missing and is a no-op-ish update if present, so this never errors
// the caller on "already exists".
export async function ensureLabel(repo, name) {
  await gh([
    "label",
    "create",
    name,
    "--repo",
    repo,
    "--color",
    LABEL_COLORS[name] ?? "ededed",
    "--force",
  ])
}

// The state-role labels currently on a GitHub issue (so a swap only removes the
// ones actually present — `gh issue edit --remove-label` errors on an absent one).
export async function currentStateLabels(repo, issueNumber) {
  const { code, out } = await gh([
    "issue",
    "view",
    String(issueNumber),
    "--repo",
    repo,
    "--json",
    "labels",
  ])
  if (code !== 0) return []
  try {
    return (JSON.parse(out).labels ?? [])
      .map((l) => l.name)
      .filter((n) => STATE_LABELS.includes(n))
  } catch {
    return []
  }
}

// Move the issue to exactly one state-role label: add `desired`, remove any other
// state labels present. Returns { ok: true } or { ok: false, reason } — the
// caller decides the error policy (the solver logs and moves on; the review
// worker records the failure on the Convex row).
export async function setStateLabel(repo, issueNumber, desired) {
  await ensureLabel(repo, desired)
  const present = await currentStateLabels(repo, issueNumber)
  const remove = present.filter((l) => l !== desired)
  const args = [
    "issue",
    "edit",
    String(issueNumber),
    "--repo",
    repo,
    "--add-label",
    desired,
  ]
  for (const l of remove) args.push("--remove-label", l)
  const { code, err } = await gh(args)
  if (code !== 0) return { ok: false, reason: errorReason(err, `gh issue edit exited ${code}`) }
  return { ok: true }
}
