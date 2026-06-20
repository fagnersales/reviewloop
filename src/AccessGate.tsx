import { type ReactNode, useEffect, useState } from "react"
import { useQuery } from "convex/react"
import { GitPullRequest, Loader2, Lock } from "lucide-react"
import { api } from "../convex/_generated/api"
import {
  IS_LOCAL_CONSOLE,
  clearStoredPasscode,
  consumeUrlPasscode,
  getStoredPasscode,
  setStoredPasscode,
} from "./access"
import { ReadOnlyContext } from "./read-only"
import { cn } from "./lib/cn"

// Read any deep-link passcode exactly once at module load. consumeUrlPasscode
// strips the secret from the URL as a side effect, so it must not run inside a
// render path that StrictMode (or a remount) can re-invoke. The local/admin
// build never gates, so it doesn't touch the URL at all.
const initialPasscode = IS_LOCAL_CONSOLE
  ? null
  : (consumeUrlPasscode() ?? getStoredPasscode())

export function AccessGate({ children }: { children: ReactNode }) {
  // Local/admin build: no gate, full write access.
  if (IS_LOCAL_CONSOLE) {
    return <ReadOnlyContext.Provider value={false}>{children}</ReadOnlyContext.Provider>
  }
  return <PublicGate>{children}</PublicGate>
}

function PublicGate({ children }: { children: ReactNode }) {
  const [passcode, setPasscode] = useState<string | null>(initialPasscode)
  // "skip" until we have a passcode to check, so the gate doesn't fire a query
  // with empty args.
  const verdict = useQuery(api.access.verify, passcode ? { passcode } : "skip")

  useEffect(() => {
    if (!passcode) return
    if (verdict === true) setStoredPasscode(passcode)
    else if (verdict === false) clearStoredPasscode()
  }, [passcode, verdict])

  if (passcode && verdict === undefined) {
    return (
      <Shell>
        <div className="flex items-center gap-2 text-sm text-zinc-500">
          <Loader2 className="size-4 animate-spin" />
          Checking access…
        </div>
      </Shell>
    )
  }

  if (passcode && verdict === true) {
    return <ReadOnlyContext.Provider value={true}>{children}</ReadOnlyContext.Provider>
  }

  // No passcode yet, or the one we have was rejected.
  return (
    <PasscodePrompt
      wrong={passcode != null && verdict === false}
      onSubmit={(value) => setPasscode(value.trim() || null)}
    />
  )
}

function PasscodePrompt({
  wrong,
  onSubmit,
}: {
  wrong: boolean
  onSubmit: (value: string) => void
}) {
  const [value, setValue] = useState("")
  return (
    <Shell>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          onSubmit(value)
        }}
        className="w-full max-w-xs rounded-xl border border-zinc-800 bg-zinc-950/80 p-6 shadow-xl"
      >
        <div className="mb-4 flex items-center gap-2">
          <div className="flex size-8 items-center justify-center rounded-md border border-zinc-800 bg-zinc-950">
            <Lock className="size-4 text-sky-300" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-semibold text-zinc-100">PR Review Console</div>
            <div className="text-xs text-zinc-600">Enter passcode to view</div>
          </div>
        </div>
        <input
          autoFocus
          type="password"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="Passcode"
          className={cn(
            "h-9 w-full rounded-md border bg-zinc-900 px-3 text-sm text-zinc-100 outline-none placeholder:text-zinc-600",
            wrong
              ? "border-red-500/60 focus:border-red-500/60"
              : "border-zinc-700 focus:border-zinc-500",
          )}
        />
        {wrong && (
          <p className="mt-2 text-xs text-red-300" role="alert">
            Wrong passcode — try again.
          </p>
        )}
        <button
          type="submit"
          className="mt-4 inline-flex h-9 w-full items-center justify-center rounded-md border border-zinc-700 bg-zinc-900 text-sm font-medium text-zinc-100 transition hover:border-zinc-500"
        >
          Unlock
        </button>
      </form>
    </Shell>
  )
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-dvh flex-col items-center justify-center gap-6 bg-[#080809] px-4 text-zinc-100">
      <div className="flex items-center gap-2 text-zinc-600">
        <GitPullRequest className="size-4 text-sky-300" />
        <span className="text-xs">read-only console</span>
      </div>
      {children}
    </div>
  )
}
