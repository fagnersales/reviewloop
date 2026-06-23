// Follow-ups kit: the Convex-row type, the label vocabulary, and the
// presentational atoms for the PR-follow-ups inbox. The interactive surfaces
// (rows, detail, actions) live in FollowUps.tsx; this is the shared vocabulary.
import { type FunctionReturnType } from "convex/server"
import {
  AlertTriangle,
  Bug,
  Lightbulb,
  type LucideIcon,
  Sparkles,
  Tag,
  Wrench,
} from "lucide-react"
import { api } from "../../convex/_generated/api"
import { cn } from "../lib/cn"

// One inbox row = one suggested follow-up, with its source-PR context inline.
export type Suggestion = FunctionReturnType<typeof api.suggestedIssues.inbox>[number]
export type TriageLabel = NonNullable<Suggestion["label"]>
export type SugCategory = Suggestion["category"]
export type SugStatus = Suggestion["status"]
export type SugSource = Suggestion["source"]

export const CATEGORY: Record<SugCategory, { label: string; icon: LucideIcon; tone: string; dot: string }> = {
  bug: { label: "Bug", icon: Bug, tone: "border-red-400/25 bg-red-400/10 text-red-200", dot: "bg-red-400" },
  enhancement: {
    label: "Enhancement",
    icon: Lightbulb,
    tone: "border-sky-400/25 bg-sky-400/10 text-sky-200",
    dot: "bg-sky-400",
  },
  chore: {
    label: "Chore",
    icon: Wrench,
    tone: "border-violet-400/25 bg-violet-400/10 text-violet-200",
    dot: "bg-violet-400",
  },
}

// The kebab enum the agent emits → its display label + icon. A disclosed
// limitation / deferred P2 is a warning glyph; a build tangent is a spark.
export const SOURCE_META: Record<SugSource, { label: string; icon: LucideIcon }> = {
  "deferred-p2": { label: "Deferred P2", icon: AlertTriangle },
  "disclosed-limitation": { label: "Disclosed limitation", icon: AlertTriangle },
  "build-tangent": { label: "Build tangent", icon: Sparkles },
}

// The triage state-role labels (gate 2). `needs-triage` is where an opened
// follow-up starts; promoting to `ready-for-agent` is what hands it to the solver.
export const LABELS: { id: TriageLabel; label: string; tone: string }[] = [
  { id: "needs-triage", label: "needs-triage", tone: "border-amber-400/25 bg-amber-400/10 text-amber-200" },
  { id: "ready-for-agent", label: "ready-for-agent", tone: "border-indigo-400/25 bg-indigo-400/10 text-indigo-200" },
  { id: "ready-for-human", label: "ready-for-human", tone: "border-sky-400/25 bg-sky-400/10 text-sky-200" },
  { id: "wontfix", label: "wontfix", tone: "border-zinc-700 bg-zinc-900/80 text-zinc-400" },
]

export const issueUrl = (repo: string, n?: number) => `https://github.com/${repo}/issues/${n}`

export function CategoryChip({ category }: { category: SugCategory }) {
  const c = CATEGORY[category]
  const Icon = c.icon
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium", c.tone)}>
      <Icon className="size-3" />
      {c.label}
    </span>
  )
}

export function SourceTag({ source }: { source: SugSource }) {
  const m = SOURCE_META[source]
  const Icon = m.icon
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-zinc-700 bg-zinc-900/60 px-1.5 py-0.5 text-[11px] text-zinc-400">
      <Icon className="size-3" />
      {m.label}
    </span>
  )
}

// suggested → amber (awaiting you) · approved → sky (worker filing it) ·
// opened → emerald · dismissed → zinc.
export function StateDot({ status }: { status: SugStatus }) {
  const tone =
    status === "opened"
      ? "bg-emerald-400"
      : status === "dismissed"
        ? "bg-zinc-600"
        : status === "approved"
          ? "bg-sky-400"
          : "bg-amber-400"
  return <span className={cn("size-2 shrink-0 rounded-full", tone)} />
}

export function LabelChip({ value }: { value: TriageLabel }) {
  const l = LABELS.find((x) => x.id === value)
  if (!l) return null
  return <span className={cn("rounded border px-1 py-px font-mono text-[10px]", l.tone)}>{l.label}</span>
}

export function CountBadge({ n }: { n: number }) {
  if (n <= 0) return null
  return (
    <span className="inline-flex min-w-[1rem] items-center justify-center rounded-full border border-amber-400/30 bg-amber-400/15 px-1 text-[10px] font-semibold text-amber-200">
      {n}
    </span>
  )
}

export function LabelPicker({ value, onChange }: { value: TriageLabel; onChange: (l: TriageLabel) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="inline-flex items-center gap-1 text-[11px] uppercase tracking-wide text-zinc-600">
        <Tag className="size-3" />
        Label
      </span>
      {LABELS.map((l) => {
        const active = l.id === value
        return (
          <button
            key={l.id}
            type="button"
            onClick={() => onChange(l.id)}
            className={cn(
              "rounded-md border px-1.5 py-0.5 font-mono text-[11px] transition",
              active ? l.tone : "border-zinc-800 text-zinc-500 hover:border-zinc-700 hover:text-zinc-300",
            )}
          >
            {l.label}
          </button>
        )
      })}
    </div>
  )
}

// The portable, self-contained brief — kept byte-for-byte aligned with the issue
// body the worker files (minus the title heading + dedup marker), so a fresh agent
// with no session memory can act on it whether it was copied or opened. The handoff
// pins this format; keep it verbatim.
export function issueBrief(s: Suggestion): string {
  const files = s.files.length
    ? `\n\n**Files to touch:** ${s.files.map((f) => `\`${f}\``).join(", ")}`
    : ""
  return `# ${s.title}

${s.body}${files}

---

## Source PR (context for a fresh agent)

This issue was proposed by an automated agent **while it built the PR below**. You are a fresh session with **no prior knowledge of that work** — read this before implementing.

- Repo: \`${s.repo}\`
- Source PR: #${s.sourcePrNumber} — ${s.sourcePrTitle}
- PR URL: ${s.sourcePrUrl}
- Head commit when proposed: \`${s.sourceHeadSha.slice(0, 7)}\`
- Proposed category: ${s.category} · Flagged as: ${s.source}
`
}
