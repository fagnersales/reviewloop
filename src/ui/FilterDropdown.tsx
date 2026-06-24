// The list-column filter control shared by all three views: the Reviews repo
// picker, the Follow-ups status filter, and the Solves status filter. A mono
// trigger button that opens a menu of options (label + count) with a check on
// the active one. An invisible full-screen layer behind the menu closes it on an
// outside click — the same pattern the design uses.
import { type ReactNode, useState } from "react"
import { Check, ChevronDown } from "lucide-react"
import { cn } from "../lib/cn"

export type FilterOption<T extends string> = {
  value: T
  label: string
  count: number
}

export function FilterDropdown<T extends string>({
  icon,
  heading,
  options,
  value,
  onChange,
}: {
  icon: ReactNode
  heading: string
  options: FilterOption<T>[]
  value: T
  onChange: (value: T) => void
}) {
  const [open, setOpen] = useState(false)
  const current = options.find((o) => o.value === value) ?? options[0]

  return (
    <div className="relative min-w-0 flex-1">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex w-full items-center gap-2 rounded-[5px] border bg-inset px-2.5 py-[7px] font-mono text-xs text-zinc-300 outline-none transition-colors",
          open ? "border-edgehi" : "border-edge3 hover:border-edge2",
        )}
      >
        <span className="flex text-zinc-500">{icon}</span>
        <span className="min-w-0 flex-1 truncate text-left">{current?.label}</span>
        <ChevronDown className={cn("size-3.5 shrink-0 text-zinc-500 transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <>
          <div onClick={() => setOpen(false)} className="fixed inset-0 z-40" />
          <div className="absolute inset-x-0 top-[calc(100%+6px)] z-50 flex flex-col gap-0.5 rounded-[7px] border border-edge2 bg-elevated p-[5px] shadow-[0_14px_36px_rgba(0,0,0,0.6)]">
            <div className="px-[9px] pb-1.5 pt-1 font-mono text-[9px] uppercase tracking-[0.16em] text-zinc-600">
              {heading}
            </div>
            {options.map((o) => {
              const active = o.value === value
              return (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => {
                    onChange(o.value)
                    setOpen(false)
                  }}
                  className={cn(
                    "flex w-full items-center gap-[9px] rounded-[5px] px-[9px] py-[7px] text-left font-mono text-xs transition-colors",
                    active ? "bg-railsel text-zinc-100" : "text-zinc-400 hover:text-zinc-200",
                  )}
                >
                  <span className="flex w-3.5 justify-center text-accent">
                    {active && <Check className="size-3" strokeWidth={2.4} />}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{o.label}</span>
                  <span className="text-[11px] text-zinc-600">{o.count}</span>
                </button>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
