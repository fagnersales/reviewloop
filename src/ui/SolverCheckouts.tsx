// The solver checkout registry editor, on the nav rail beside the other config
// controls (admin build only). A folder-git button whose popover grows sideways
// out of the rail (same motion as AutoReview) and holds the whole registry:
// per-host groups of repo → path rows, each wearing the verdict dot the live
// solver wrote back (green ok / amber ok-with-warnings / red invalid / grey
// not-yet-validated; hover for the detail), a row click opening the inline
// editor (path + per-repo agent instructions), and an add-form per host.
// Deliberately prose-free. Hosts come from solvers announcing themselves on
// startup (solverCheckouts.hello) — a host with no live solver still lists, its
// rows just stay grey until one runs there. The rail icon wears a red corner
// dot when any registered checkout is invalid, so a broken path is visible
// without opening the popover.
import { useEffect, useState } from "react"
import { useMutation } from "convex/react"
import { useQuery } from "convex-helpers/react/cache/hooks"
import { FolderGit2, Loader2, Plus, RotateCw, Trash2 } from "lucide-react"
import { api } from "../../convex/_generated/api"
import type { Id } from "../../convex/_generated/dataModel"
import { cn } from "../lib/cn"
import { useReadOnly } from "../read-only"

type Checkout = {
  _id: Id<"solverCheckouts">
  host: string
  repo: string
  path: string
  instructions?: string
  status?: "ok" | "invalid"
  statusDetail?: string
  provision?: "requested" | "provisioning" | "ready" | "failed"
  provisionProgress?: string
  provisionReport?: string
  provisionError?: string
}

// Hostnames read cleaner without the mDNS suffix; collisions are the operator's
// own naming problem at this scale.
const hostShort = (h: string) => h.replace(/\.local$/, "")

function VerdictDot({ c }: { c: Checkout }) {
  // In-flight provisioning outranks the (stale or absent) validation verdict.
  if (c.provision === "provisioning")
    return <Loader2 className="size-3 shrink-0 animate-spin text-[#7dd3fc]" />
  if (c.provision === "requested")
    return (
      <span
        title="queued — waiting for the solver on this host to provision it"
        className="size-[7px] shrink-0 animate-pulse rounded-full bg-zinc-500"
      />
    )
  if (c.provision === "failed")
    return (
      <span
        title={c.provisionError || "provisioning failed"}
        className="size-[7px] shrink-0 rounded-full bg-[#f85149]"
      />
    )
  const tone =
    c.status === "ok"
      ? c.statusDetail
        ? "bg-[#e3b341]"
        : "bg-[#86efac]"
      : c.status === "invalid"
        ? "bg-[#f85149]"
        : "bg-zinc-600"
  const title =
    c.status === "ok"
      ? c.statusDetail || "validated"
      : c.status === "invalid"
        ? c.statusDetail || "invalid"
        : "not validated yet — is the solver running on this host?"
  return <span title={title} className={cn("size-[7px] shrink-0 rounded-full", tone)} />
}

// The row's second line: live provisioning activity when there is any, the
// registered path otherwise.
function rowSub(c: Checkout): { text: string; cls: string } {
  if (c.provision === "provisioning")
    return { text: c.provisionProgress || "Provisioning…", cls: "text-[#7dd3fc]" }
  if (c.provision === "requested") return { text: "Queued for provisioning…", cls: "text-zinc-500" }
  if (c.provision === "failed")
    return { text: c.provisionError || "Provisioning failed", cls: "text-[#fca5a5]" }
  return { text: c.path, cls: "text-zinc-600" }
}

// The inline editor for one checkout (existing row → repo fixed, remove
// offered; add form → repo editable). Save funnels to the same upsert.
function CheckoutForm({
  host,
  existing,
  onDone,
}: {
  host: string
  existing: Checkout | null
  onDone: () => void
}) {
  const upsert = useMutation(api.solverCheckouts.upsert)
  const removeRow = useMutation(api.solverCheckouts.remove)
  const reprovision = useMutation(api.solverCheckouts.requestProvision)
  const [repo, setRepo] = useState(existing?.repo ?? "")
  const [path, setPath] = useState(existing?.path ?? "")
  const [instructions, setInstructions] = useState(existing?.instructions ?? "")
  const [error, setError] = useState<string | null>(null)

  // The whole point of provisioning: the repo alone is enough. An empty path
  // falls back to the solver-owned convention.
  const defaultPath = repo.includes("/") ? `~/solver-checkouts/${repo.split("/")[1]}` : ""

  const save = async () => {
    let result: "saved" | "invalid" | "full"
    try {
      result = await upsert({
        host,
        repo,
        path: path.trim() || defaultPath,
        ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
      })
    } catch {
      setError("Couldn’t save — try again")
      return
    }
    if (result === "saved") onDone()
    else setError(result === "full" ? "Host is full" : "Use owner/name")
  }

  const FIELD =
    "w-full rounded-[5px] border border-edge3 bg-inset px-2 py-1.5 font-mono text-[11px] text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-edgehi"

  return (
    <div className="flex flex-col gap-1.5 rounded-[6px] border border-edge2 bg-inset/60 p-2">
      <input
        autoFocus={!existing}
        value={repo}
        disabled={!!existing}
        onChange={(e) => {
          setRepo(e.target.value)
          setError(null)
        }}
        placeholder="owner/repo"
        className={cn(FIELD, existing && "text-zinc-500")}
      />
      <input
        autoFocus={!!existing}
        value={path}
        onChange={(e) => {
          setPath(e.target.value)
          setError(null)
        }}
        placeholder={defaultPath || "~/solver-checkouts/repo (auto)"}
        className={FIELD}
      />
      <textarea
        value={instructions}
        onChange={(e) => setInstructions(e.target.value)}
        placeholder="Agent instructions for this repo (optional)"
        rows={3}
        className={cn(FIELD, "resize-none leading-relaxed")}
      />
      {existing?.provisionError && (
        <div className="rounded-[5px] border border-[#f85149]/25 bg-[#f85149]/[0.06] px-2 py-1.5 font-mono text-[10px] leading-relaxed text-[#fecaca]">
          {existing.provisionError}
        </div>
      )}
      {existing?.provisionReport && (
        <div className="max-h-32 overflow-y-auto whitespace-pre-wrap rounded-[5px] border border-edge bg-inset px-2 py-1.5 font-mono text-[10px] leading-relaxed text-zinc-400">
          {existing.provisionReport}
        </div>
      )}
      {error && (
        <span className="text-[10.5px] text-[#fca5a5]" role="alert">
          {error}
        </span>
      )}
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => void save()}
          className="rounded-[5px] border border-edge bg-[#0d0d0f] px-2.5 py-1 text-[11px] text-zinc-200 transition-colors hover:border-edge2"
        >
          Save
        </button>
        <button
          type="button"
          onClick={onDone}
          className="rounded-[5px] px-2 py-1 text-[11px] text-zinc-500 transition-colors hover:text-zinc-300"
        >
          Cancel
        </button>
        {existing && existing.provision !== "provisioning" && existing.provision !== "requested" && (
          <button
            type="button"
            title="Provision again — re-clone/re-prepare this checkout"
            aria-label="Provision again"
            onClick={() => {
              void reprovision({ id: existing._id })
              onDone()
            }}
            className="ml-auto flex size-6 items-center justify-center rounded-[5px] text-zinc-600 transition-colors hover:bg-railsel/60 hover:text-zinc-300"
          >
            <RotateCw className="size-3" />
          </button>
        )}
        {existing && (
          <button
            type="button"
            title="Remove checkout"
            aria-label="Remove checkout"
            onClick={() => {
              void removeRow({ id: existing._id })
              onDone()
            }}
            className={cn(
              "flex size-6 items-center justify-center rounded-[5px] text-zinc-600 transition-colors hover:bg-[#f85149]/10 hover:text-[#fca5a5]",
              (existing.provision === "provisioning" || existing.provision === "requested") && "ml-auto",
            )}
          >
            <Trash2 className="size-3" />
          </button>
        )}
      </div>
    </div>
  )
}

export function SolverCheckouts() {
  const readOnly = useReadOnly()
  const [open, setOpen] = useState(false)
  // Which editor is open: a row id, or `add:<host>` for that host's add form.
  const [editing, setEditing] = useState<string | null>(null)
  const board = useQuery(api.solverCheckouts.board)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false)
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [open])

  if (readOnly) return null

  const hosts = board?.hosts ?? []
  const checkouts = (board?.checkouts ?? []) as Checkout[]
  const broken = checkouts.some((c) => c.status === "invalid")
  const close = () => {
    setOpen(false)
    setEditing(null)
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => (open ? close() : setOpen(true))}
        title={broken ? "Solver checkouts — one is invalid" : "Solver checkouts"}
        aria-label="Solver checkouts"
        className={cn(
          "relative flex size-10 items-center justify-center rounded-md border transition-colors",
          open
            ? "border-edge2 bg-railsel text-zinc-100"
            : "border-transparent text-zinc-500 hover:bg-railsel/60 hover:text-zinc-300",
        )}
      >
        <FolderGit2 className="size-[18px]" />
        {broken && <span className="absolute right-2 top-1.5 size-[5px] rounded-full bg-[#f85149]" />}
      </button>

      {open && <div onClick={close} className="fixed inset-0 z-40" />}
      {/* Always mounted so the width transition runs both ways (see AutoReview). */}
      <div
        className={cn(
          "absolute bottom-0 left-[calc(100%+12px)] z-50 overflow-hidden rounded-[9px] border bg-elevated py-3 shadow-[0_18px_44px_rgba(0,0,0,0.6)] transition-[width,opacity,padding] duration-200 ease-out motion-reduce:transition-none",
          open
            ? "w-[336px] border-edge2 px-3 opacity-100"
            : "pointer-events-none w-0 border-transparent px-0 opacity-0",
        )}
      >
        <div className="max-h-[70vh] w-[310px] overflow-y-auto">
          <div className="mb-2 flex items-center gap-1.5">
            <FolderGit2 className="size-3.5 text-zinc-400" />
            <span className="font-mono text-[10.5px] text-zinc-400">Solver checkouts</span>
          </div>

          {hosts.length === 0 && (
            <div className="rounded-md border border-dashed border-edge p-3 text-center text-[11px] text-zinc-600">
              No solver has announced itself yet.
            </div>
          )}

          {hosts.map(({ host }) => {
            const rows = checkouts
              .filter((c) => c.host === host)
              .sort((a, b) => a.repo.toLowerCase().localeCompare(b.repo.toLowerCase()))
            const addKey = `add:${host}`
            return (
              <div key={host} className="mb-2.5 last:mb-0">
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-zinc-600">
                    {hostShort(host)}
                  </span>
                  <button
                    type="button"
                    title={`Add checkout on ${hostShort(host)}`}
                    aria-label={`Add checkout on ${hostShort(host)}`}
                    onClick={() => setEditing(editing === addKey ? null : addKey)}
                    className="flex size-5 items-center justify-center rounded-[4px] text-zinc-600 transition-colors hover:bg-railsel/60 hover:text-zinc-300"
                  >
                    <Plus className="size-3" />
                  </button>
                </div>
                <div className="flex flex-col gap-1">
                  {rows.map((c) =>
                    editing === c._id ? (
                      <CheckoutForm key={c._id} host={host} existing={c} onDone={() => setEditing(null)} />
                    ) : (
                      <button
                        key={c._id}
                        type="button"
                        onClick={() => setEditing(c._id)}
                        className="flex w-full items-center gap-2 rounded-[6px] border border-transparent px-2 py-1.5 text-left transition-colors hover:border-edge hover:bg-white/[0.02]"
                      >
                        <VerdictDot c={c} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-mono text-[11px] text-zinc-300">
                            {c.repo.split("/")[1] || c.repo}
                          </span>
                          <span className={cn("block truncate font-mono text-[9.5px]", rowSub(c).cls)}>
                            {rowSub(c).text}
                          </span>
                        </span>
                      </button>
                    ),
                  )}
                  {editing === addKey && <CheckoutForm host={host} existing={null} onDone={() => setEditing(null)} />}
                  {rows.length === 0 && editing !== addKey && (
                    <div className="rounded-[6px] border border-dashed border-edge px-2 py-2 text-center font-mono text-[10px] text-zinc-600">
                      No checkouts
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
