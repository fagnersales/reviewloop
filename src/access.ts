// Access mode + passcode plumbing for the console.
//
// Two builds, one codebase:
//   • Local/admin build — has VITE_ACCESS_PASSCODE set (in .env.local). It skips
//     the passcode gate entirely, runs with full write access, and renders the
//     SharePanel (passcode + deep link + QR) so you can hop to the hosted site
//     already authenticated, including from your phone.
//   • Public build (Vercel) — has NO VITE_ACCESS_PASSCODE. It shows the passcode
//     gate, verifies the passcode server-side via api.access.verify, and runs
//     read-only.
//
// VITE_ env vars are inlined into the bundle at build time, so we deliberately
// do NOT set VITE_ACCESS_PASSCODE on Vercel — the real secret only ever lives in
// the local build and in the Convex deployment's ACCESS_PASSCODE env var.

const rawPasscode = import.meta.env.VITE_ACCESS_PASSCODE as string | undefined
export const LOCAL_PASSCODE = rawPasscode?.trim() || undefined

// Presence of a baked-in passcode is what marks this as the local/admin build.
export const IS_LOCAL_CONSOLE = Boolean(LOCAL_PASSCODE)

// The public (Vercel) origin, set in .env.local so the local console can build a
// deep link / QR that points at the hosted site rather than at localhost. Falls
// back to the current origin so the link still works when previewing locally.
const rawPublicUrl = import.meta.env.VITE_PUBLIC_CONSOLE_URL as string | undefined
export const PUBLIC_CONSOLE_URL = rawPublicUrl?.trim().replace(/\/+$/, "") || undefined

const STORAGE_KEY = "reviewloop.passcode"
// Pre-rename key — read-only fallback so visitors who unlocked the console
// before the reviewloop rename aren't asked for the passcode again.
const LEGACY_STORAGE_KEY = "prr-console.passcode"
const URL_PARAM = "key"

export function getStoredPasscode(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEY)
  } catch {
    return null
  }
}

export function setStoredPasscode(passcode: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, passcode)
  } catch {
    // Private-mode / disabled storage: the session just won't persist.
  }
}

export function clearStoredPasscode(): void {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // ignore
  }
}

// Reads a passcode handed in via ?key=… (or #key=…) for the pre-authenticated
// deep link, then strips it from the visible URL/history so the secret doesn't
// linger in the address bar or get shared by accident.
export function consumeUrlPasscode(): string | null {
  if (typeof window === "undefined") return null
  const url = new URL(window.location.href)
  let value = url.searchParams.get(URL_PARAM)

  if (value) {
    url.searchParams.delete(URL_PARAM)
  } else if (url.hash.includes(`${URL_PARAM}=`)) {
    // Support #key=… too (kept out of server logs / Referer headers).
    const hashParams = new URLSearchParams(url.hash.replace(/^#/, ""))
    value = hashParams.get(URL_PARAM)
    if (value) {
      hashParams.delete(URL_PARAM)
      const rest = hashParams.toString()
      url.hash = rest ? `#${rest}` : ""
    }
  }

  if (value) {
    window.history.replaceState(null, "", url.toString())
    return value.trim() || null
  }
  return null
}

// The pre-authenticated link the local console shows / encodes as a QR. Points
// at the public origin when configured, otherwise the current origin.
export function buildDeepLink(passcode: string): string {
  const base = PUBLIC_CONSOLE_URL ?? window.location.origin
  return `${base}/?${URL_PARAM}=${encodeURIComponent(passcode)}`
}
