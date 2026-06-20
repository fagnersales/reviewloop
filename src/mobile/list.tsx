// Shared list-surface pieces: a touch-sized PR card, the horizontal repo filter
// chips, and a compact status-glance strip. Reused across the mobile variants.
import { Clock3, ListFilter, RotateCw } from "lucide-react"
import { cn } from "../lib/cn"
import { type Pr, ScoreBadge, StatusBadge, prTiming, repoShort, roundCount } from "../review/kit"

// A single tappable PR row. The whole row is the tap target that opens the PR's
// detail screen. `now` is supplied by the list so a single clock drives every
// card, rather than each card spinning up its own interval.
export function PrCard({
  pr,
  now,
  onTap,
  showRepo = true,
  active = false,
}: {
  pr: Pr
  now: number
  onTap: (pr: Pr) => void
  showRepo?: boolean
  active?: boolean
}) {
  const timing = prTiming(pr, now)
  const rounds = roundCount(pr)
  return (
    <button
      type="button"
      onClick={() => onTap(pr)}
      className={cn(
        "flex w-full items-center gap-3 rounded-xl border px-3 py-3 text-left transition",
        active
          ? "border-zinc-700 bg-zinc-900"
          : "border-zinc-800/80 bg-zinc-950/60 active:bg-zinc-900",
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-zinc-100">{pr.title}</span>
          <ScoreBadge score={pr.confidence} />
        </div>
        <div className="mt-1.5 flex items-center justify-between gap-2 text-[11px] text-zinc-500">
          <span className="flex min-w-0 items-center gap-2">
            {showRepo && <span className="truncate">{repoShort(pr.repo)}</span>}
            <span className="shrink-0 font-mono">#{pr.prNumber}</span>
            {timing && (
              <span className="inline-flex shrink-0 items-center gap-1" title={timing.title}>
                <Clock3 className="size-3" />
                {timing.span}
              </span>
            )}
            {rounds > 1 && (
              <span className="inline-flex shrink-0 items-center gap-1" title={`${rounds} review rounds`}>
                <RotateCw className="size-3" />
                {rounds}
              </span>
            )}
          </span>
          <StatusBadge pr={pr} />
        </div>
      </div>
    </button>
  )
}

export function RepoChips({
  repos,
  active,
  onChange,
}: {
  repos: string[]
  active: string
  onChange: (repo: string) => void
}) {
  const chip = (key: string, label: string, icon?: boolean) => {
    const on = active.toLowerCase() === key.toLowerCase()
    return (
      <button
        key={key}
        type="button"
        onClick={() => onChange(key)}
        className={cn(
          "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition",
          on
            ? "border-zinc-600 bg-zinc-200 text-zinc-900"
            : "border-zinc-800 bg-zinc-950 text-zinc-400 active:bg-zinc-900",
        )}
      >
        {icon && <ListFilter className="size-3.5" />}
        {label}
      </button>
    )
  }
  return (
    <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {chip("all", "All", true)}
      {repos.map((r) => chip(r, repoShort(r)))}
    </div>
  )
}
