// The mobile solve detail: status pill, issue heading, the live "Solver session"
// card while building (the worker's streamed one-line progress + elapsed clock),
// the failure banner, and the provenance rows (branch / worker / timing) —
// read-only, per the "reviewloop mobile" design. Solvers never merge; the only
// human action (merging the opened PR) happens on GitHub.
import { useEffect, useState } from "react"
import { AlertTriangle, ArrowUpRight } from "lucide-react"
import { type ReactNode } from "react"
import { cn } from "../lib/cn"
import { ago, clock } from "../lib/format"
import { repoShort } from "../review/kit"
import { type SolveTask, SOLVE_NOTE, SolveStatusPill, solveIssueUrl } from "../solves/kit"

// A 1s tick, only while the solve is live, for the building elapsed clock.
function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [active])
  return now
}

function MetaRow({ label, last, children }: { label: string; last?: boolean; children: ReactNode }) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 px-[13px] py-[11px]",
        !last && "border-b border-[#161619]",
      )}
    >
      <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.1em] text-zinc-600">{label}</span>
      <span className="min-w-0 truncate font-mono text-[11.5px] text-zinc-400">{children}</span>
    </div>
  )
}

export function MobileSolveDetail({ task: t }: { task: SolveTask }) {
  const now = useNow(t.status === "solving")
  const elapsed = t.startedAt ? clock((t.finishedAt ?? now) - t.startedAt) : null
  const note = SOLVE_NOTE[t.status]

  // The provenance rows, in display order, so the last visible one drops its rule.
  const rows: { label: string; value: ReactNode }[] = []
  if (t.branch) rows.push({ label: "Branch", value: t.branch })
  if (t.worker) rows.push({ label: "Worker", value: t.worker })
  rows.push({ label: "Queued", value: ago(t.queuedAt, now) })
  if (t.startedAt != null) rows.push({ label: "Started", value: ago(t.startedAt, now) })
  if (t.finishedAt != null) rows.push({ label: "Finished", value: ago(t.finishedAt, now) })

  return (
    <div>
      <SolveStatusPill status={t.status} />
      <h2 className="mt-[13px] text-[19px] font-semibold leading-[1.3] text-zinc-100">{t.issueTitle}</h2>
      <div className="mt-2.5 flex items-center gap-2.5 font-mono text-[11px] text-[#6e6e78]">
        <span>{repoShort(t.repo)}</span>
        <a
          href={solveIssueUrl(t)}
          target="_blank"
          rel="noreferrer"
          className="text-accent underline-offset-2 active:underline"
        >
          #{t.issueNumber}
        </a>
      </div>

      {t.status === "solving" && (
        <div className="mt-[18px] overflow-hidden rounded-lg border border-[#1a1a1e] bg-sunken">
          <div className="flex items-center justify-between border-b border-line px-3 py-[9px] font-mono text-[10px] uppercase tracking-[0.12em] text-zinc-600">
            <span>Solver session</span>
            {elapsed && <span className="text-[#7dd3fc]">{elapsed}</span>}
          </div>
          <div className="px-[13px] py-2.5 font-mono text-[11px] leading-[1.95]">
            <div className="flex gap-[9px]">
              <span className="rl-pulse mt-[7px] size-[5px] shrink-0 rounded-full bg-[#38bdf8]" />
              <span className="cl-shimmer min-w-0">{t.progress || "Starting…"}</span>
            </div>
          </div>
        </div>
      )}

      {t.status === "failed" && t.error && (
        <div className="mt-[18px] flex items-start gap-[11px] rounded-lg border border-[#f85149]/25 bg-[#f85149]/[0.06] p-3.5">
          <AlertTriangle className="mt-px size-[17px] shrink-0 text-[#fca5a5]" />
          <p className="text-[12.5px] leading-relaxed text-[#fca5a5]">{t.error}</p>
        </div>
      )}

      <div className="mt-[18px] overflow-hidden rounded-lg border border-[#1a1a1e] bg-panel">
        {rows.map((r, i) => (
          <MetaRow key={r.label} label={r.label} last={i === rows.length - 1}>
            {r.value}
          </MetaRow>
        ))}
      </div>

      {t.prNumber != null && t.prUrl && (
        <a
          href={t.prUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-4 inline-flex items-center gap-[7px] rounded-[7px] border border-edge bg-inset px-3.5 py-2.5 text-[13px] text-zinc-300 active:text-zinc-100"
        >
          <ArrowUpRight className="size-3.5" />
          View PR #{t.prNumber} on GitHub
        </a>
      )}

      {note && <p className="mt-4 text-[12.5px] leading-relaxed text-zinc-500">{note}</p>}
    </div>
  )
}
