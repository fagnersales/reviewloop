// Follow-ups kit: the Convex-row type, the label vocabulary, the design-palette
// metas, and the console-intent actions hook — shared by the desktop two-pane
// (FollowUps.tsx) and the mobile console (src/mobile). The interactive surfaces
// live in the views; this is the shared vocabulary.
import { useMemo } from "react"
import { type FunctionReturnType } from "convex/server"
import { useMutation } from "convex/react"
import { api } from "../../convex/_generated/api"

// One inbox row = one suggested follow-up, with its source-PR context inline.
export type Suggestion = FunctionReturnType<typeof api.suggestedIssues.inbox>[number]
export type TriageLabel = NonNullable<Suggestion["label"]>
export type SugCategory = Suggestion["category"]
export type SugStatus = Suggestion["status"]
export type SugSource = Suggestion["source"]

// The kebab enum the agent emits → its display label.
export const SOURCE_LABEL: Record<SugSource, string> = {
  "deferred-p2": "Deferred P2",
  "disclosed-limitation": "Disclosed limitation",
  "build-tangent": "Build tangent",
}

// The console's design palette: status as a coloured uppercase mono label/pill.
// suggested → amber (awaiting you) · approved → green (worker filing it) ·
// opened → sky · dismissed → zinc.
export const FU_STATUS: Record<SugStatus, { label: string; text: string; bg: string; border: string }> = {
  suggested: { label: "SUGGESTED", text: "text-[#fcd34d]", bg: "bg-[#e3b341]/10", border: "border-[#e3b341]/30" },
  approved: { label: "APPROVED", text: "text-[#86efac]", bg: "bg-[#3fb950]/10", border: "border-[#3fb950]/30" },
  opened: { label: "OPENED", text: "text-[#7dd3fc]", bg: "bg-[#38bdf8]/10", border: "border-[#38bdf8]/30" },
  dismissed: { label: "DISMISSED", text: "text-zinc-400", bg: "bg-inset", border: "border-edge2" },
}

export const FU_CAT_TEXT: Record<SugCategory, string> = {
  bug: "text-[#fca5a5]",
  enhancement: "text-[#7dd3fc]",
  chore: "text-zinc-400",
}

export const FU_CAT_CHIP: Record<SugCategory, { text: string; bg: string; border: string }> = {
  bug: { text: "text-[#fca5a5]", bg: "bg-[#f85149]/10", border: "border-[#f85149]/30" },
  enhancement: { text: "text-[#7dd3fc]", bg: "bg-[#38bdf8]/10", border: "border-[#38bdf8]/30" },
  chore: { text: "text-zinc-400", bg: "bg-rowsel", border: "border-edge2" },
}

// The triage state-role labels (gate 2) as mono toggle chips. `needs-triage` is
// where an opened follow-up starts; promoting to `ready-for-agent` is what hands
// it to the solver. Deliberately the human-settable subset of the full 6-label
// vocabulary in worker/lib.mjs (STATE_LABELS); the solver-set labels aren't
// pickable here.
export const TRIAGE: { id: TriageLabel; text: string; border: string }[] = [
  { id: "needs-triage", text: "text-[#fcd34d]", border: "border-[#e3b341]/40" },
  { id: "ready-for-agent", text: "text-[#86efac]", border: "border-[#3fb950]/50" },
  { id: "ready-for-human", text: "text-[#7dd3fc]", border: "border-[#38bdf8]/40" },
  { id: "wontfix", text: "text-zinc-400", border: "border-edgehi" },
]

export const issueUrl = (repo: string, n?: number) => `https://github.com/${repo}/issues/${n}`

// The actor label stamped on a console decision (decidedBy). The console has no
// per-user identity, so it's just "dashboard" — distinct from a CLI's $USER@$HOST.
const ACTOR = "dashboard"

// The console records *intent* (approve / dismiss / undo / set-label); the
// worker does the GitHub side.
export function useFollowUpActions() {
  const approve = useMutation(api.suggestedIssues.approve)
  const dismiss = useMutation(api.suggestedIssues.dismiss)
  const undo = useMutation(api.suggestedIssues.undo)
  const setLabel = useMutation(api.suggestedIssues.setLabel)
  return useMemo(
    () => ({
      open: (s: Suggestion) => void approve({ id: s._id, by: ACTOR }),
      dismiss: (s: Suggestion) => void dismiss({ id: s._id, by: ACTOR }),
      undo: (s: Suggestion) => void undo({ id: s._id }),
      setLabel: (s: Suggestion, label: TriageLabel) => void setLabel({ id: s._id, label }),
    }),
    [approve, dismiss, undo, setLabel],
  )
}

export type FollowUpActions = ReturnType<typeof useFollowUpActions>

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
