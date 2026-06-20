import { v } from "convex/values"
import { query } from "./_generated/server"
import { env } from "./_generated/server"

// Gate for the public (Vercel-hosted) read-only console. The passcode lives
// only in the deployment's ACCESS_PASSCODE env var — never in the client
// bundle — so the public site has to ask the server whether a passcode is
// right. The local/admin console doesn't call this at all; it short-circuits
// the gate with VITE_ACCESS_PASSCODE (see src/access.ts).
//
// Note: this gates the *console UI*, not the underlying Convex data. The data
// functions (reviews.board, etc.) remain public, exactly as they are today, so
// anyone with the raw deployment URL can still query them — this just keeps the
// hosted page itself behind a passcode. Harden the data functions separately if
// that ever matters.

// Length-independent constant-time-ish compare so a wrong passcode doesn't leak
// its correct length through timing. Overkill for a personal tool, but free.
function timingSafeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length
  const max = Math.max(a.length, b.length)
  for (let i = 0; i < max; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0)
  }
  return diff === 0
}

export const verify = query({
  args: { passcode: v.string() },
  returns: v.boolean(),
  handler: async (_ctx, args) => {
    const expected = env.ACCESS_PASSCODE
    // Fail closed: with no passcode configured, reject everything so a
    // misconfigured public deploy stays locked instead of wide open.
    if (!expected) return false
    return timingSafeEqual(args.passcode, expected)
  },
})
