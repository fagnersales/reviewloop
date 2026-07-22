// The house-rules editor behind the gavel at the foot of the nav rail (admin
// build only — the read-only console hides it). Operator taste the reviewer
// enforces, e.g. "no code comments": each rule is a sentence plus a level —
// block (violations post at P1, a merge blocker) or warn (P2, a note) — and a
// scope: every watched repo (global) or one repo. The button opens a full-page
// editor (not a popover — rules deserve room to be written well): a multi-line
// composer with a live character budget on the left, the rules grouped by
// scope with inline text editing on the right. Writes go straight to Convex
// (rules.add / setText / setLevel / remove); the worker subscribes and injects
// the applicable rules into the next review's brief.
import { useEffect, useRef, useState } from "react"
import { useMutation } from "convex/react"
import { useQuery } from "convex-helpers/react/cache/hooks"
import { Gavel, Globe, Pencil, Scissors, Sparkles, Target, X } from "lucide-react"
import { api } from "../../convex/_generated/api"
import type { Id } from "../../convex/_generated/dataModel"
import { cn } from "../lib/cn"
import { ago } from "../lib/format"
import { useReadOnly } from "../read-only"
import { FilterDropdown, type FilterOption } from "./FilterDropdown"

type Level = "block" | "warn"
type DraftMode = "rewrite" | "shorten"

type Rule = {
  id: Id<"reviewRules">
  text: string
  level: Level
  repo?: string
  updatedAt: number
}

const LEVELS: { value: Level; hint: string }[] = [
  { value: "block", hint: "P1 · blocks merge" },
  { value: "warn", hint: "P2 · noted" },
]

// Level badge tones, matching the console's severity palette (block reads like
// FAILED-red, warn like AWAITING-amber).
const LEVEL_TONE: Record<Level, string> = {
  block: "border-[#f85149]/30 bg-[#f85149]/10 text-[#fca5a5]",
  warn: "border-[#e3b341]/30 bg-[#e3b341]/10 text-[#fcd34d]",
}

// Mirror the backend caps (convex/rules.ts MAX_RULE_LENGTH / MAX_RULES) so the
// composer can show the budget before the mutation rejects.
const MAX_LEN = 300
const MAX_RULES = 50

// "" is the global scope in the select and the draft state; Convex stores
// global as an absent `repo`.
const ALL_REPOS = ""

const ADD_NOTICE: Record<string, string> = {
  exists: "Already a rule in that scope.",
  full: "Rule list is full.",
  invalid: "Rule is empty or too long.",
}

// Rewrite/shorten failure notices (the reject codes from ruleDrafts.request).
const DRAFT_NOTICE: Record<string, string> = {
  busy: "The rewriter is busy — try again in a moment.",
  invalid: "Nothing to rewrite.",
}

// Gerund shown in the busy scrim while the transform runs.
const DRAFT_GERUND: Record<DraftMode, string> = {
  rewrite: "Rewriting",
  shorten: "Shortening",
}

// Character-reveal pacing for the type-in finish (matches the approved
// treatment): a couple of glyphs every ~22ms, a ~240ms scrim fade before typing
// starts, and a ~1s accent glow after the text lands.
const TYPE_TICK_MS = 22
const TYPE_CHARS_PER_TICK = 2
const CLOSE_MS = 240
const GLOW_MS = 1000

// Watchdog for a run that never resolves — the worker is down, so the queued job
// row is never claimed and no done/failed ever arrives. Without this the scrim
// spins forever. A hair above the worker's own 90s CLI timeout so a slow-but-live
// transform still wins the race and types in.
const DRAFT_TIMEOUT_MS = 95_000

// The centered pulsing status inside the busy scrim: three bouncing accent dots
// plus the gerund. The text pulse reuses the global .rl-pulse; the dots bounce
// via hr-bounce (index.css) with staggered delays.
function TransformStatus({ mode }: { mode: DraftMode }) {
  return (
    <span className="flex items-center gap-2 rl-pulse">
      <span className="flex gap-1">
        <span className="size-1.5 rounded-full bg-accent" style={{ animation: "hr-bounce 1s ease-in-out infinite" }} />
        <span
          className="size-1.5 rounded-full bg-accent"
          style={{ animation: "hr-bounce 1s ease-in-out infinite", animationDelay: "0.15s" }}
        />
        <span
          className="size-1.5 rounded-full bg-accent"
          style={{ animation: "hr-bounce 1s ease-in-out infinite", animationDelay: "0.3s" }}
        />
      </span>
      <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-zinc-300">{DRAFT_GERUND[mode]}…</span>
    </span>
  )
}

function CharBudget({ len }: { len: number }) {
  return (
    <span className={cn("shrink-0 font-mono text-[10px]", len > MAX_LEN ? "text-[#fca5a5]" : "text-zinc-600")}>
      {len}/{MAX_LEN}
    </span>
  )
}

// The badge that shows a rule's level and flips it on click.
function LevelBadge({ rule, onToggle }: { rule: Rule; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      title={`Switch to ${rule.level === "block" ? "warn" : "block"}`}
      className={cn(
        "mt-[3px] shrink-0 rounded border px-1.5 py-0.5 font-mono text-[9.5px] uppercase tracking-[0.08em] transition-colors",
        LEVEL_TONE[rule.level],
      )}
    >
      {rule.level}
    </button>
  )
}

// One rule in the list. Clicking the text (or the pencil) swaps the row for an
// inline textarea; Esc cancels without closing the page, ⌘/Ctrl+Enter saves.
function RuleRow({ rule }: { rule: Rule }) {
  const setText = useMutation(api.rules.setText)
  const setLevel = useMutation(api.rules.setLevel)
  const remove = useMutation(api.rules.remove)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(rule.text)
  const [error, setError] = useState<string | null>(null)

  const startEdit = () => {
    setDraft(rule.text)
    setError(null)
    setEditing(true)
  }

  const save = async () => {
    const text = draft.trim()
    if (!text || text.length > MAX_LEN) return
    if (text === rule.text) {
      setEditing(false)
      return
    }
    const result = await setText({ id: rule.id, text })
    if (result === "exists") setError("Already a rule in that scope.")
    else setEditing(false)
  }

  if (editing) {
    return (
      <li className="rounded-md border border-edge2 bg-inset p-2.5">
        <textarea
          autoFocus
          rows={3}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value)
            setError(null)
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation()
              setEditing(false)
            }
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void save()
          }}
          className="w-full resize-y rounded-[5px] border border-edge bg-sunken px-2.5 py-2 font-mono text-[12px] leading-relaxed text-zinc-200 focus:border-edgehi focus:outline-none"
        />
        <div className="mt-1.5 flex items-center gap-2">
          {error && <span className="text-[10.5px] text-[#fca5a5]">{error}</span>}
          <span className="flex-1" />
          <CharBudget len={draft.length} />
          <button
            type="button"
            onClick={() => setEditing(false)}
            className="rounded-[5px] border border-edge px-2 py-1 font-mono text-[10px] text-zinc-500 transition-colors hover:border-edge2 hover:text-zinc-300"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!draft.trim() || draft.length > MAX_LEN}
            onClick={() => void save()}
            className="rounded-[5px] border border-edge bg-railsel px-2 py-1 font-mono text-[10px] text-zinc-200 transition-colors hover:border-edge2 disabled:opacity-40"
          >
            Save
          </button>
        </div>
      </li>
    )
  }

  return (
    <li className="group flex items-start gap-2.5 rounded-md border border-transparent px-2.5 py-2 transition-colors hover:border-edge hover:bg-white/[0.015]">
      <LevelBadge
        rule={rule}
        onToggle={() => void setLevel({ id: rule.id, level: rule.level === "block" ? "warn" : "block" })}
      />
      <button
        type="button"
        onClick={startEdit}
        title="Edit rule"
        className="min-w-0 flex-1 break-words text-left text-[13px] leading-relaxed text-zinc-300"
      >
        {rule.text}
        <span
          title={new Date(rule.updatedAt).toLocaleString()}
          className="ml-2 font-mono text-[9.5px] text-zinc-700"
        >
          {ago(rule.updatedAt, Date.now())}
        </span>
      </button>
      <span className="mt-[3px] flex shrink-0 items-center gap-1.5 opacity-0 transition-opacity group-hover:opacity-100">
        <button
          type="button"
          onClick={startEdit}
          title="Edit rule"
          aria-label={`Edit rule: ${rule.text}`}
          className="text-zinc-600 transition-colors hover:text-zinc-300"
        >
          <Pencil className="size-3" />
        </button>
        <button
          type="button"
          onClick={() => void remove({ id: rule.id })}
          title="Remove rule"
          aria-label={`Remove rule: ${rule.text}`}
          className="text-zinc-600 transition-colors hover:text-zinc-300"
        >
          <X className="size-3.5" />
        </button>
      </span>
    </li>
  )
}

// The composer card: a real textarea (rules deserve more than one input line),
// character budget, scope picker, level picker, Add. ⌘/Ctrl+Enter submits; Esc
// with a non-empty draft is swallowed so it never eats your writing.
function Composer({ rules, repos }: { rules: Rule[]; repos: string[] }) {
  const add = useMutation(api.rules.add)
  const requestDraft = useMutation(api.ruleDrafts.request)
  const discardDraft = useMutation(api.ruleDrafts.discard)
  const [draft, setDraft] = useState("")
  const [level, setLevel] = useState<Level>("block")
  const [repo, setRepo] = useState(ALL_REPOS)
  const [notice, setNotice] = useState<string | null>(null)
  // A rewrite/shorten in flight, run as a real backend job with variable latency.
  // `phase` drives the "Typewriter" treatment: running (busy scrim over the field)
  // → closing (scrim fades) → typing (the finished text is typed in char-by-char
  // behind an accent caret) → glow (accent settle) → idle. `mode` is the button
  // that spawned it (for the scrim label), `jobId` the row we subscribe to, and
  // `typed` the growing substring shown during the reveal.
  const [phase, setPhase] = useState<"idle" | "running" | "closing" | "typing" | "glow">("idle")
  const [mode, setMode] = useState<DraftMode>("rewrite")
  const [jobId, setJobId] = useState<Id<"ruleDrafts"> | null>(null)
  const [typed, setTyped] = useState("")
  const job = useQuery(api.ruleDrafts.get, jobId ? { id: jobId } : "skip")

  // The field is locked and the buttons disabled for the whole run, up to the
  // glow settle (which is editable again — the glow is a pure decoration).
  const busy = phase === "running" || phase === "closing" || phase === "typing"

  // Timer hygiene: every setTimeout goes in this array and the reveal setInterval
  // in its own ref, so a new run and unmount can clear all of them. The composer
  // unmounts when the House Rules page closes; a leaked interval that calls
  // setState after unmount is a bug.
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])
  const interval = useRef<ReturnType<typeof setInterval> | undefined>(undefined)
  const clearAll = () => {
    timers.current.forEach(clearTimeout)
    timers.current = []
    if (interval.current !== undefined) {
      clearInterval(interval.current)
      interval.current = undefined
    }
  }
  useEffect(() => () => clearAll(), [])

  // Act only on the job's terminal states, and only once: the guard on
  // phase === "running" means the intermediate queued/running updates are ignored
  // and — because the terminal branch immediately moves phase off "running" (and
  // clears jobId) — the effect can't double-fire for the same job.
  useEffect(() => {
    if (!jobId || !job || phase !== "running") return
    if (job.status === "done") {
      clearAll() // cancel the watchdog timeout — the run resolved in time
      const full = job.output ?? ""
      setPhase("closing")
      timers.current.push(
        setTimeout(() => {
          setPhase("typing")
          let i = 0
          interval.current = setInterval(() => {
            i = Math.min(full.length, i + TYPE_CHARS_PER_TICK)
            setTyped(full.slice(0, i))
            if (i >= full.length) {
              if (interval.current !== undefined) {
                clearInterval(interval.current)
                interval.current = undefined
              }
              setDraft(full)
              setPhase("glow")
              timers.current.push(setTimeout(() => setPhase("idle"), GLOW_MS))
            }
          }, TYPE_TICK_MS)
        }, CLOSE_MS),
      )
      void discardDraft({ id: jobId })
      setJobId(null)
    } else if (job.status === "failed") {
      clearAll() // cancel the watchdog timeout — the run resolved in time
      setNotice(job.error ? `Couldn’t ${job.mode} — ${job.error}` : "Rewrite failed.")
      setPhase("idle")
      void discardDraft({ id: jobId })
      setJobId(null)
    }
  }, [job, jobId, phase, discardDraft])

  // Queue a rewrite/shorten of the current draft; the worker runs `claude` and
  // the effect above types the result in when it lands. The scrim stays up for
  // the whole (variable) worker latency.
  const runTransform = async (m: DraftMode) => {
    const text = draft.trim()
    if (!text || phase !== "idle") return
    clearAll()
    setNotice(null)
    setTyped("")
    setMode(m)
    setPhase("running")
    const result = await requestDraft({ input: text, mode: m })
    if (result === "busy" || result === "invalid") {
      setPhase("idle")
      setNotice(DRAFT_NOTICE[result])
      return
    }
    setJobId(result)
    // Arm the watchdog: if the job never reaches done/failed (worker down, so the
    // row is never claimed), drop the scrim, discard the orphan row, and say so.
    // The terminal branches above clearAll() this on a normal resolve.
    timers.current.push(
      setTimeout(() => {
        setPhase("idle")
        setNotice("The rewriter isn’t responding — is the worker running?")
        void discardDraft({ id: result })
        setJobId(null)
      }, DRAFT_TIMEOUT_MS),
    )
  }

  // Scope picker options — the count column shows how many rules each scope
  // already has. Options are labelled by short repo name (the owner prefix is
  // pure noise in a control this narrow), except when two watched repos share a
  // name and only the full slug disambiguates.
  const shortName = (r: string) => r.split("/")[1] || r
  const shortNames = repos.map(shortName)
  const scopeOptions: FilterOption<string>[] = [
    { value: ALL_REPOS, label: "all repos", count: rules.filter((r) => !r.repo).length },
    ...repos.map((r) => ({
      value: r,
      label: shortNames.filter((s) => s === shortName(r)).length > 1 ? r : shortName(r),
      count: rules.filter((x) => x.repo?.toLowerCase() === r.toLowerCase()).length,
    })),
  ]

  const submit = async () => {
    const text = draft.trim()
    if (!text || text.length > MAX_LEN) return
    const result = await add({ text, level, repo: repo || undefined })
    if (result === "added") {
      setDraft("")
      setNotice(null)
    } else {
      setNotice(ADD_NOTICE[result] ?? "Couldn’t add the rule.")
    }
  }

  return (
    <div className="rounded-lg border border-line2 bg-panel p-4">
      <div className="mb-2.5 font-mono text-[10px] uppercase tracking-[0.14em] text-zinc-600">New rule</div>
      <div className="relative">
        <textarea
          autoFocus
          rows={4}
          value={phase === "closing" ? "" : phase === "typing" ? typed : draft}
          readOnly={busy}
          onChange={(e) => {
            setDraft(e.target.value)
            setNotice(null)
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape" && draft.trim()) e.stopPropagation()
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !busy) void submit()
          }}
          placeholder='e.g. "No code comments that narrate what the next line does — comment only constraints the code can’t express."'
          className={cn(
            "w-full resize-y rounded-[6px] border border-edge bg-inset px-3 py-2.5 font-mono text-[12px] leading-relaxed text-zinc-200 placeholder:text-zinc-600 focus:border-edgehi focus:outline-none",
            // While typing, the mirror overlay draws the text (so the caret can
            // trail the last glyph inline); hide the textarea's own text but keep
            // it for sizing. Settle with the accent glow.
            phase === "typing" && "text-transparent",
            phase === "glow" && "hr-glow",
          )}
        />
        {/* Mirror overlay: same box/padding/font as the textarea, drawing the
            revealed substring in accent green with a blinking caret inline after
            the last character — so the caret always trails the text. */}
        {phase === "typing" && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words rounded-[6px] px-3 py-2.5 font-mono text-[12px] leading-relaxed"
            style={{ color: "#d7f7dc", textShadow: "0 0 8px rgba(63,185,80,0.55), 0 0 18px rgba(63,185,80,0.28)" }}
          >
            {typed}
            <span
              className="ml-px inline-block h-[13px] w-[2px] translate-y-[2px] bg-accent align-baseline"
              style={{ boxShadow: "0 0 6px 1px rgba(63,185,80,0.8)", animation: "hr-caret 1s step-end infinite" }}
            />
          </div>
        )}
        {/* The busy scrim: pops in, holds the pulsing status for the whole worker
            latency, then fades out on closing before the type-in begins. */}
        {(phase === "running" || phase === "closing") && (
          <div
            className="absolute inset-0 flex items-center justify-center rounded-[6px] border border-edgehi bg-sunken/70 backdrop-blur-[2px]"
            style={{ animation: phase === "closing" ? "hr-scrim-out 0.24s ease-in both" : "hr-scrim-in 0.18s ease-out both" }}
          >
            <span style={phase === "running" ? { animation: "hr-pop-in 0.24s ease-out both" } : undefined}>
              <TransformStatus mode={mode} />
            </span>
          </div>
        )}
      </div>
      <div className="mt-1 flex items-center justify-between gap-2">
        <span className="text-[10.5px] text-[#fca5a5]">{notice}</span>
        <CharBudget len={draft.length} />
      </div>

      <div className="mt-2 flex items-stretch gap-2">
        <button
          type="button"
          disabled={busy || !draft.trim()}
          onClick={() => void runTransform("rewrite")}
          title="Rewrite more concisely (AI)"
          className="flex flex-1 items-center justify-center gap-1.5 rounded-[6px] border border-edge2 bg-inset px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.08em] text-zinc-300 transition-colors enabled:hover:border-edgehi enabled:hover:text-zinc-100 disabled:opacity-40"
        >
          <Sparkles className="size-3" />
          Rewrite
        </button>
        <button
          type="button"
          disabled={busy || !draft.trim()}
          onClick={() => void runTransform("shorten")}
          title="Shorten to the fewest words (AI)"
          className="flex flex-1 items-center justify-center gap-1.5 rounded-[6px] border border-edge2 bg-inset px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.08em] text-zinc-300 transition-colors enabled:hover:border-edgehi enabled:hover:text-zinc-100 disabled:opacity-40"
        >
          <Scissors className="size-3" />
          Shorten
        </button>
      </div>

      <div className="mt-2.5 flex items-center">
        <FilterDropdown
          icon={<Target className="size-3.5" />}
          heading="Rule applies to"
          options={scopeOptions}
          value={repo}
          onChange={setRepo}
        />
      </div>

      <div className="mt-2 flex items-stretch gap-2">
        {LEVELS.map((l) => (
          <button
            key={l.value}
            type="button"
            onClick={() => setLevel(l.value)}
            className={cn(
              "flex-1 rounded-[6px] border px-2.5 py-2 text-left transition-colors",
              level === l.value ? LEVEL_TONE[l.value] : "border-edge bg-inset text-zinc-600 hover:text-zinc-400",
            )}
          >
            <span className="block font-mono text-[10px] uppercase tracking-[0.08em]">{l.value}</span>
            <span className={cn("mt-0.5 block font-mono text-[9.5px]", level === l.value ? "opacity-70" : "text-zinc-600")}>
              {l.hint}
            </span>
          </button>
        ))}
      </div>

      <button
        type="button"
        disabled={!draft.trim() || draft.length > MAX_LEN}
        onClick={() => void submit()}
        title="Add rule (⌘↵)"
        className="mt-2.5 w-full rounded-[6px] border border-edge bg-inset px-3 py-2 font-mono text-[11px] text-zinc-300 transition-colors hover:border-edge2 hover:text-zinc-100 disabled:opacity-40"
      >
        Add rule
      </button>
    </div>
  )
}

// The full-page editor. Fixed overlay over the whole console; Esc or the ×
// closes it. Left: the composer. Right: rules grouped by scope, global first.
function RulesPage({ onClose }: { onClose: () => void }) {
  const rules = useQuery(api.rules.list)
  const repos = useQuery(api.repos.list)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [onClose])

  // Global rules first, then one group per repo (alphabetical). Labels use the
  // short repo name unless two group repos share one and the slug must
  // disambiguate.
  const groups: { repo?: string; rules: Rule[] }[] = []
  if (rules) {
    const global = rules.filter((r) => !r.repo)
    if (global.length) groups.push({ rules: global })
    const byRepo = new Map<string, Rule[]>()
    for (const r of rules) {
      if (!r.repo) continue
      const key = r.repo.toLowerCase()
      byRepo.set(key, [...(byRepo.get(key) ?? []), r])
    }
    for (const key of [...byRepo.keys()].sort()) {
      const list = byRepo.get(key)!
      groups.push({ repo: list[0].repo, rules: list })
    }
  }
  const shortName = (r: string) => r.split("/")[1] || r
  const groupShorts = groups.filter((g) => g.repo).map((g) => shortName(g.repo!))
  const groupLabel = (repo: string) =>
    groupShorts.filter((s) => s === shortName(repo)).length > 1 ? repo : shortName(repo)

  const count = rules?.length ?? 0

  return (
    <div role="dialog" aria-modal="true" aria-label="House rules" className="fixed inset-0 z-50 flex flex-col bg-canvas">
      <header className="flex shrink-0 items-center gap-3.5 border-b border-line bg-panel px-6 py-4">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-edge2 bg-gradient-to-b from-[#141417] to-[#0d0d0f]">
          <Gavel className="size-4 text-accent" />
        </span>
        <div className="min-w-0">
          <h1 className="m-0 font-mono text-[13px] font-semibold uppercase tracking-[0.14em] text-zinc-100">
            House rules
          </h1>
          <p className="m-0 mt-0.5 text-xs text-zinc-500">
            Taste the reviewer enforces — on every repo or one. Applies from the next review.
          </p>
        </div>
        <span className="flex-1" />
        <span title={`Up to ${MAX_RULES} rules`} className="shrink-0 font-mono text-[11px] text-zinc-600">
          {count}/{MAX_RULES}
        </span>
        <button
          type="button"
          onClick={onClose}
          title="Close (Esc)"
          aria-label="Close house rules"
          className="flex size-8 shrink-0 items-center justify-center rounded-md border border-edge text-zinc-500 transition-colors hover:border-edge2 hover:text-zinc-200"
        >
          <X className="size-4" />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid w-full max-w-[1080px] grid-cols-[340px_minmax(0,1fr)] items-start gap-5 px-6 py-6">
          <aside className="sticky top-0">
            <Composer rules={rules ?? []} repos={repos ?? []} />
          </aside>

          <section className="min-w-0">
            {rules === undefined ? (
              <p className="m-0 text-xs text-zinc-600">Loading…</p>
            ) : rules.length === 0 ? (
              <div className="rounded-lg border border-dashed border-edge p-8 text-center text-[13px] text-zinc-600">
                No rules yet — reviews run on the standard brief alone.
              </div>
            ) : (
              <div className="flex flex-col gap-6">
                {groups.map((g) => (
                  <div key={g.repo?.toLowerCase() ?? "all"}>
                    <div className="mb-1.5 flex items-center gap-2 px-2.5 font-mono text-[10px] uppercase tracking-[0.14em] text-zinc-600">
                      {g.repo ? <Target className="size-3" /> : <Globe className="size-3" />}
                      <span title={g.repo}>{g.repo ? groupLabel(g.repo) : "All repos"}</span>
                      <span className="text-zinc-700">{g.rules.length}</span>
                    </div>
                    <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
                      {g.rules.map((r) => (
                        <RuleRow key={r.id} rule={r} />
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}

export function HouseRules() {
  const readOnly = useReadOnly()
  const [open, setOpen] = useState(false)
  const rules = useQuery(api.rules.list)

  if (readOnly) return null

  const count = rules?.length ?? 0

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="House rules"
        aria-label="House rules"
        className={cn(
          "relative flex size-10 items-center justify-center rounded-md border transition-colors",
          open
            ? "border-edge2 bg-railsel text-zinc-100"
            : "border-transparent text-zinc-500 hover:bg-railsel/60 hover:text-zinc-300",
        )}
      >
        <Gavel className="size-[18px]" />
        {count > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-railsel px-0.5 font-mono text-[8px] text-zinc-400">
            {count}
          </span>
        )}
      </button>

      {open && <RulesPage onClose={() => setOpen(false)} />}
    </>
  )
}
