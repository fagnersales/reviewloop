// Tests for the shared worker runtime (worker/lib.mjs) — everything runs
// against the module's real interface, with no live gh or claude:
//   - pure helpers are called directly
//   - the label state machine talks to a fake `gh` shell script on PATH
//   - streamClaude drives real child processes that speak stream-json
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest"
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  errorReason,
  firstLine,
  describeTool,
  clean,
  resolveConvexUrl,
  run,
  ghText,
  ghJson,
  currentStateLabels,
  setStateLabel,
  streamClaude,
  STATE_LABELS,
  LABEL_COLORS,
} from "./lib.mjs"

// ── pure helpers ─────────────────────────────────────────────────────────────

describe("errorReason", () => {
  it("returns the last non-empty stderr line", () => {
    expect(errorReason("first\nsecond\nthe reason\n", "fb")).toBe("the reason")
  })
  it("falls back when stderr is empty or whitespace", () => {
    expect(errorReason("", "fb")).toBe("fb")
    expect(errorReason("   \n  \n", "fb")).toBe("fb")
    expect(errorReason(undefined, "fb")).toBe("fb")
  })
})

describe("firstLine", () => {
  it("returns the first non-empty line, trimmed", () => {
    expect(firstLine("\n\n   hello there  \nsecond")).toBe("hello there")
  })
  it("clamps to 240 chars", () => {
    expect(firstLine("x".repeat(500))).toHaveLength(240)
  })
  it("returns empty string for empty input", () => {
    expect(firstLine("")).toBe("")
    expect(firstLine(undefined)).toBe("")
  })
})

describe("describeTool", () => {
  it("labels the common tools", () => {
    expect(describeTool("Read", { file_path: "/a/b/c.ts" })).toBe("Reading c.ts")
    expect(describeTool("Write", { file_path: "/a/b/c.ts" })).toBe("Editing c.ts")
    expect(describeTool("Grep", { pattern: "foo" })).toBe('Searching "foo"')
    expect(describeTool("Task", { description: "scan logs" })).toBe("Subagent: scan logs")
  })
  it("collapses and truncates Bash commands", () => {
    expect(describeTool("Bash", { command: "ls   -la\n  /tmp" })).toBe("$ ls -la /tmp")
    expect(describeTool("Bash", { command: "x".repeat(400) })).toHaveLength(2 + 180)
  })
  it("prettifies mcp__ tool names and passes unknown names through", () => {
    expect(describeTool("mcp__github__create_issue")).toBe("github · create_issue")
    expect(describeTool("SomeNewTool")).toBe("SomeNewTool")
    expect(describeTool(undefined)).toBe("working…")
  })
})

describe("clean", () => {
  it("drops undefined values but keeps null/false/0", () => {
    expect(clean({ a: 1, b: undefined, c: null, d: false, e: 0 })).toEqual({
      a: 1,
      c: null,
      d: false,
      e: 0,
    })
  })
})

describe("resolveConvexUrl", () => {
  const saved = process.env.REVIEWLOOP_CONVEX_URL
  afterAll(() => {
    if (saved === undefined) delete process.env.REVIEWLOOP_CONVEX_URL
    else process.env.REVIEWLOOP_CONVEX_URL = saved
  })
  it("prefers the REVIEWLOOP_CONVEX_URL env var over config", () => {
    process.env.REVIEWLOOP_CONVEX_URL = "https://env.example"
    expect(resolveConvexUrl({ convexUrl: "https://cfg.example" })).toBe("https://env.example")
  })
  it("falls back to config when the env var is unset", () => {
    delete process.env.REVIEWLOOP_CONVEX_URL
    expect(resolveConvexUrl({ convexUrl: "https://cfg.example" })).toBe("https://cfg.example")
  })
})

// ── run ──────────────────────────────────────────────────────────────────────

describe("run", () => {
  it("captures stdout, stderr, and the exit code", async () => {
    const r = await run("node", [
      "-e",
      "process.stdout.write('out'); process.stderr.write('err'); process.exit(3)",
    ])
    expect(r).toEqual({ code: 3, out: "out", err: "err" })
  })
  it("resolves with code -1 instead of rejecting on a spawn failure", async () => {
    const r = await run("/definitely/not/a/binary", [])
    expect(r.code).toBe(-1)
    expect(r.err).toMatch(/ENOENT/)
  })
})

// ── gh helpers + label state machine (via a fake `gh` on PATH) ───────────────

describe("gh-backed helpers", () => {
  let dir
  let callLog
  const savedPath = process.env.PATH
  const GH_ENV = ["GH_CALL_LOG", "GH_FAIL", "GH_EDIT_FAIL", "GH_ISSUE_VIEW_JSON", "GH_DEFAULT_OUT"]

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "reviewloop-fake-gh-"))
    const script = `#!/bin/sh
[ -n "$GH_CALL_LOG" ] && echo "$*" >> "$GH_CALL_LOG"
if [ -n "$GH_FAIL" ]; then echo "gh blew up" >&2; exit 1; fi
case "$1 $2" in
  "issue view") printf '%s' "$GH_ISSUE_VIEW_JSON"; exit 0 ;;
  "issue edit")
    if [ -n "$GH_EDIT_FAIL" ]; then
      echo "boring first line" >&2
      echo "the real reason" >&2
      exit 1
    fi
    exit 0 ;;
  "label create") exit 0 ;;
esac
printf '%s' "$GH_DEFAULT_OUT"
exit 0
`
    writeFileSync(join(dir, "gh"), script)
    chmodSync(join(dir, "gh"), 0o755)
    process.env.PATH = `${dir}:${savedPath}`
  })
  afterAll(() => {
    process.env.PATH = savedPath
    rmSync(dir, { recursive: true, force: true })
  })
  beforeEach(() => {
    for (const k of GH_ENV) delete process.env[k]
    callLog = join(dir, `calls-${Math.random().toString(36).slice(2)}.log`)
    process.env.GH_CALL_LOG = callLog
  })
  const calls = () => readFileSync(callLog, "utf8").trim().split("\n")

  it("ghText trims stdout and returns undefined on failure or empty output", async () => {
    process.env.GH_DEFAULT_OUT = "  owner/name \n"
    expect(await ghText(["repo", "view"])).toBe("owner/name")
    process.env.GH_DEFAULT_OUT = ""
    expect(await ghText(["repo", "view"])).toBeUndefined()
    process.env.GH_FAIL = "1"
    expect(await ghText(["repo", "view"])).toBeUndefined()
  })

  it("ghJson parses stdout and returns undefined on failure or bad JSON", async () => {
    process.env.GH_DEFAULT_OUT = '{"n": 7}'
    expect(await ghJson(["pr", "view"])).toEqual({ n: 7 })
    process.env.GH_DEFAULT_OUT = "not json"
    expect(await ghJson(["pr", "view"])).toBeUndefined()
    process.env.GH_FAIL = "1"
    expect(await ghJson(["pr", "view"])).toBeUndefined()
  })

  it("currentStateLabels keeps only state-role labels", async () => {
    process.env.GH_ISSUE_VIEW_JSON = JSON.stringify({
      labels: [{ name: "ready-for-agent" }, { name: "bug" }, { name: "wontfix" }],
    })
    expect(await currentStateLabels("o/r", 12)).toEqual(["ready-for-agent", "wontfix"])
  })

  it("currentStateLabels returns [] on gh failure", async () => {
    process.env.GH_FAIL = "1"
    expect(await currentStateLabels("o/r", 12)).toEqual([])
  })

  it("setStateLabel ensures the label, adds it, and removes only the other present state labels", async () => {
    process.env.GH_ISSUE_VIEW_JSON = JSON.stringify({
      labels: [{ name: "ready-for-agent" }, { name: "bug" }, { name: "wontfix" }],
    })
    const r = await setStateLabel("o/r", 12, "agent-in-progress")
    expect(r).toEqual({ ok: true })
    expect(calls()).toEqual([
      `label create agent-in-progress --repo o/r --color ${LABEL_COLORS["agent-in-progress"]} --force`,
      "issue view 12 --repo o/r --json labels",
      "issue edit 12 --repo o/r --add-label agent-in-progress --remove-label ready-for-agent --remove-label wontfix",
    ])
  })

  it("setStateLabel is a no-remove add when the desired label is already the only state label", async () => {
    process.env.GH_ISSUE_VIEW_JSON = JSON.stringify({ labels: [{ name: "ready-for-human" }] })
    const r = await setStateLabel("o/r", 3, "ready-for-human")
    expect(r).toEqual({ ok: true })
    expect(calls().at(-1)).toBe("issue edit 3 --repo o/r --add-label ready-for-human")
  })

  it("setStateLabel surfaces the last stderr line as the failure reason", async () => {
    process.env.GH_ISSUE_VIEW_JSON = JSON.stringify({ labels: [] })
    process.env.GH_EDIT_FAIL = "1"
    const r = await setStateLabel("o/r", 12, "agent-failed")
    expect(r).toEqual({ ok: false, reason: "the real reason" })
  })

  it("every state label has a color", () => {
    for (const l of STATE_LABELS) expect(LABEL_COLORS[l]).toMatch(/^[0-9a-f]{6}$/)
  })
})

// ── streamClaude (via scripted node child processes) ─────────────────────────

// Run streamClaude against `node -e <script>` standing in for the claude CLI.
function stream(script, extra = {}) {
  const logFile = join(mkdtempSync(join(tmpdir(), "reviewloop-stream-")), "run.log")
  return {
    logFile,
    done: streamClaude({
      claudeBin: "node",
      args: ["-e", script],
      logFile,
      timeoutMs: 10_000,
      ...extra,
    }),
  }
}
const evt = (o) => `console.log(${JSON.stringify(JSON.stringify(o))})`

describe("streamClaude", () => {
  it("captures the final result, the last full text, and appends raw output to the log file", async () => {
    const script = [
      evt({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "/x/y.ts" } }] } }),
      evt({ type: "assistant", message: { content: [{ type: "text", text: "Working on it\nmore detail" }] } }),
      evt({ type: "result", result: "All done", is_error: false, subtype: "success" }),
    ].join(";")
    const { logFile, done } = stream(script)
    const r = await done
    expect(r.code).toBe(0)
    expect(r.resultIsError).toBe(false)
    expect(r.finalText).toBe("All done")
    expect(r.lastFullText).toBe("Working on it\nmore detail")
    expect(r.spawnError).toBeUndefined()
    expect(readFileSync(logFile, "utf8")).toContain("All done")
  })

  it("reassembles JSON lines split across stdout chunks", async () => {
    const line = JSON.stringify({ type: "result", result: "split ok", subtype: "success" })
    const script = `
      const line = ${JSON.stringify(line)}
      process.stdout.write(line.slice(0, 10))
      setTimeout(() => { process.stdout.write(line.slice(10) + "\\n") }, 100)
    `
    const r = await stream(script).done
    expect(r.finalText).toBe("split ok")
  })

  it("flags a non-success result subtype as an error", async () => {
    const script = evt({ type: "result", result: "hit the turn cap", subtype: "error_max_turns" })
    const r = await stream(script).done
    expect(r.code).toBe(0)
    expect(r.resultIsError).toBe(true)
  })

  it("pushes throttled, deduped progress labels", async () => {
    const script = [
      evt({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "/x/y.ts" } }] } }),
      "setTimeout(() => {}, 1500)",
    ].join(";")
    const seen = []
    const r = await stream(script, { onProgress: (l) => seen.push(l) }).done
    expect(r.code).toBe(0)
    expect(seen).toEqual(["Reading y.ts"])
  })

  it("fires onTimeout and kills the child when the timeout elapses", async () => {
    const onTimeout = vi.fn()
    const r = await stream("setTimeout(() => {}, 60000)", { timeoutMs: 300, onTimeout }).done
    expect(onTimeout).toHaveBeenCalledOnce()
    expect(r.code).not.toBe(0) // killed by SIGTERM, not a clean exit
  })

  it("resolves with code -1 and the spawn error when the binary is missing", async () => {
    const logFile = join(mkdtempSync(join(tmpdir(), "reviewloop-stream-")), "run.log")
    const r = await streamClaude({
      claudeBin: "/definitely/not/claude",
      args: [],
      logFile,
      timeoutMs: 1000,
    })
    expect(r.code).toBe(-1)
    expect(String(r.spawnError)).toMatch(/ENOENT/)
  })
})
