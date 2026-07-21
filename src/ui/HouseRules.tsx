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
import { useEffect, useState } from "react"
import { useMutation } from "convex/react"
import { useQuery } from "convex-helpers/react/cache/hooks"
import { Gavel, Globe, Pencil, Target, X } from "lucide-react"
import { api } from "../../convex/_generated/api"
import type { Id } from "../../convex/_generated/dataModel"
import { cn } from "../lib/cn"
import { ago } from "../lib/format"
import { useReadOnly } from "../read-only"
import { FilterDropdown, type FilterOption } from "./FilterDropdown"

type Level = "block" | "warn"

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
  const [draft, setDraft] = useState("")
  const [level, setLevel] = useState<Level>("block")
  const [repo, setRepo] = useState(ALL_REPOS)
  const [notice, setNotice] = useState<string | null>(null)

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
      <textarea
        autoFocus
        rows={4}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value)
          setNotice(null)
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape" && draft.trim()) e.stopPropagation()
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit()
        }}
        placeholder='e.g. "No code comments that narrate what the next line does — comment only constraints the code can’t express."'
        className="w-full resize-y rounded-[6px] border border-edge bg-inset px-3 py-2.5 font-mono text-[12px] leading-relaxed text-zinc-200 placeholder:text-zinc-600 focus:border-edgehi focus:outline-none"
      />
      <div className="mt-1 flex items-center justify-between gap-2">
        <span className="text-[10.5px] text-[#fca5a5]">{notice}</span>
        <CharBudget len={draft.length} />
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
