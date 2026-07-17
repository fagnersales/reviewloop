// The top-level view (Reviews / Solves / Follow-ups). Persisted in localStorage
// so a reload — and the desktop ⇄ mobile handoff at the narrow breakpoint —
// lands on the same tab. Shared by App.tsx (rail) and the mobile shell (tabs).
import { useEffect, useState } from "react"

export type View = "reviews" | "solves" | "follow-ups"
export const VIEWS: readonly View[] = ["reviews", "solves", "follow-ups"]
const VIEW_KEY = "prr.view"

export function useView() {
  const [view, setView] = useState<View>(() => {
    if (typeof window === "undefined") return "reviews"
    const stored = window.localStorage.getItem(VIEW_KEY)
    return (VIEWS as readonly string[]).includes(stored ?? "") ? (stored as View) : "reviews"
  })
  useEffect(() => {
    if (typeof window !== "undefined") window.localStorage.setItem(VIEW_KEY, view)
  }, [view])
  return [view, setView] as const
}
