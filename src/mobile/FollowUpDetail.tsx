// The mobile follow-up detail: category/source/status chips, the proposal body,
// the files-to-touch chips, then the action area — on the read-only phone build
// a status banner explains what happens next (decisions are made from the
// desktop console); on the local/admin build the same approve / dismiss / undo /
// triage-label controls as desktop, sized for touch.
import {
  ArrowUpRight,
  Check,
  Clock3,
  Loader2,
  type LucideIcon,
  XCircle,
} from "lucide-react"
import { cn } from "../lib/cn"
import { repoShort, ReviewReport } from "../review/kit"
import {
  type FollowUpActions,
  FU_CAT_CHIP,
  FU_STATUS,
  SOURCE_LABEL,
  type SugStatus,
  type Suggestion,
  TRIAGE,
} from "../follow-ups/kit"

// The read-only state banner: tone + icon + one line of "what happens next".
const BANNER: Record<
  SugStatus,
  { icon: LucideIcon; text: string; bg: string; border: string; line: (s: Suggestion) => string }
> = {
  suggested: {
    icon: Clock3,
    text: "text-[#fcd34d]",
    bg: "bg-[#e3b341]/[0.08]",
    border: "border-[#e3b341]/[0.28]",
    line: (s) =>
      s.triage === "kept" && s.triageReason
        ? `Auto-review kept this — ${s.triageReason}`
        : "Awaiting your decision. Approve or dismiss this proposal from the desktop console.",
  },
  approved: {
    icon: Check,
    text: "text-[#86efac]",
    bg: "bg-[#3fb950]/[0.07]",
    border: "border-[#3fb950]/[0.28]",
    line: () => "Queued — a worker will file this issue on GitHub.",
  },
  opened: {
    icon: ArrowUpRight,
    text: "text-[#7dd3fc]",
    bg: "bg-[#38bdf8]/[0.07]",
    border: "border-[#38bdf8]/[0.28]",
    line: (s) => (s.issueNumber != null ? `Issue #${s.issueNumber} filed on GitHub.` : "Issue filed on GitHub."),
  },
  dismissed: {
    icon: XCircle,
    text: "text-zinc-400",
    bg: "bg-inset",
    border: "border-edge2",
    line: (s) =>
      s.triage === "dropped" && s.triageReason
        ? `Dropped by auto-review — ${s.triageReason}`
        : "Dismissed — kept as history, never opened.",
  },
}

const UNDO_BTN =
  "rounded-[7px] border border-edge2 px-4 py-[9px] text-[13px] font-medium text-zinc-400 active:text-zinc-200"

function TriageKicker() {
  return (
    <div className="mb-[9px] font-mono text-[9.5px] uppercase tracking-[0.14em] text-zinc-600">
      Triage label
    </div>
  )
}

export function MobileFollowUpDetail({
  s,
  actions,
  readOnly,
}: {
  s: Suggestion
  actions: FollowUpActions
  readOnly: boolean
}) {
  const st = FU_STATUS[s.status]
  const chip = FU_CAT_CHIP[s.category]
  const banner = BANNER[s.status]
  const BannerIcon = banner.icon
  const currentLabel = s.label ?? "needs-triage"
  const currentTriage = TRIAGE.find((t) => t.id === currentLabel) ?? TRIAGE[0]

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn("rounded-[5px] border px-[9px] py-1 font-mono text-[10px]", chip.text, chip.bg, chip.border)}>
          {s.category}
        </span>
        <span className="font-mono text-[10px] text-[#6e6e78]">{SOURCE_LABEL[s.source]}</span>
        {s.status !== "suggested" && (
          <span className={cn("rounded-[5px] border px-[9px] py-1 font-mono text-[10px] font-medium", st.text, st.bg, st.border)}>
            {st.label}
          </span>
        )}
      </div>
      <h2 className="mt-[13px] text-[19px] font-semibold leading-[1.3] text-zinc-100">{s.title}</h2>
      <div className="mt-2.5 font-mono text-[11px] text-[#6e6e78]">
        {repoShort(s.repo)}  #{s.sourcePrNumber}
      </div>

      <div className="mt-4">
        <ReviewReport report={s.body} />
      </div>

      {s.files.length > 0 && (
        <>
          <div className="mb-[9px] mt-5 font-mono text-[9.5px] uppercase tracking-[0.14em] text-zinc-600">
            Files to touch
          </div>
          <div className="flex flex-wrap gap-[7px]">
            {s.files.map((f) => (
              <span key={f} className="rounded-[5px] border border-edge bg-inset px-[9px] py-[5px] font-mono text-[11px] text-zinc-400">
                {f}
              </span>
            ))}
          </div>
        </>
      )}

      <div className="mb-4 mt-5 h-px bg-line" />

      {readOnly ? (
        <>
          <div className={cn("flex items-start gap-[11px] rounded-lg border p-3.5", banner.bg, banner.border)}>
            <BannerIcon className={cn("mt-px size-4 shrink-0", banner.text)} />
            <p className={cn("text-[13px] leading-relaxed", banner.text)}>{banner.line(s)}</p>
          </div>
          {s.status === "opened" && (
            <div className="mt-4">
              <TriageKicker />
              <span
                className={cn(
                  "inline-flex rounded-[5px] border bg-white/[0.05] px-2.5 py-[5px] font-mono text-[11px]",
                  currentTriage.text,
                  currentTriage.border,
                )}
              >
                {currentLabel}
              </span>
            </div>
          )}
        </>
      ) : (
        <>
          {s.status === "suggested" && s.triage === "kept" && s.triageReason && (
            <p className="mb-3 text-[12.5px] leading-relaxed text-[#86efac]">
              Auto-review kept this — {s.triageReason}
            </p>
          )}
          {s.status === "suggested" && (
            <div className="flex items-center gap-[9px]">
              <button
                type="button"
                onClick={() => actions.dismiss(s)}
                className="flex-1 rounded-[7px] border border-edge2 py-[11px] text-[13px] font-medium text-zinc-400 active:text-zinc-200"
              >
                Dismiss
              </button>
              <button
                type="button"
                onClick={() => actions.open(s)}
                className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-[7px] border border-accent-strong bg-accent py-[11px] text-[13px] font-medium text-[#08160c] active:bg-accent-strong"
              >
                <Check className="size-3.5" strokeWidth={2.4} />
                Open it
              </button>
            </div>
          )}
          {s.status === "approved" && (
            <div className="flex items-center justify-between gap-2.5">
              <span className="inline-flex items-center gap-2 text-[13px] text-[#86efac]">
                <Loader2 className="size-3.5 animate-spin" />
                Queued
              </span>
              <button type="button" onClick={() => actions.undo(s)} className={UNDO_BTN}>
                Undo
              </button>
            </div>
          )}
          {s.status === "dismissed" && (
            <div className="flex items-center justify-between gap-2.5">
              <span className="min-w-0 text-[13px] text-zinc-600">
                {s.triage === "dropped" ? "Dropped by auto-review" : "Dismissed"}
              </span>
              <button type="button" onClick={() => actions.undo(s)} className={UNDO_BTN}>
                Restore
              </button>
            </div>
          )}
          {s.status === "opened" && (
            <div>
              <TriageKicker />
              <div className="flex flex-wrap gap-[7px]">
                {TRIAGE.map((t) => {
                  const active = currentLabel === t.id
                  return (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => actions.setLabel(s, t.id)}
                      aria-pressed={active}
                      className={cn(
                        "whitespace-nowrap rounded-[5px] border px-2.5 py-[6px] font-mono text-[11px] transition-colors",
                        active
                          ? cn("bg-white/[0.05]", t.text, t.border)
                          : "border-line2 bg-[#0d0d0f] text-zinc-600 active:text-zinc-400",
                      )}
                    >
                      {t.id}
                    </button>
                  )
                })}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
