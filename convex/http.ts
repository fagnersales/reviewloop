import { httpRouter } from "convex/server"
import { httpAction, env } from "./_generated/server"
import { internal } from "./_generated/api"

const http = httpRouter()

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })

// GitHub timestamps are ISO-8601 strings ("2026-06-20T12:00:00Z"). Parse to ms,
// or undefined when absent/unparseable so we never store a NaN.
function isoMs(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? undefined : ms
}

// HMAC-SHA256 hex of `payload` keyed by `secret`. GitHub signs the raw request
// body and sends it as `X-Hub-Signature-256: sha256=<hex>`.
async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload))
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

// length-then-XOR compare: no early exit on the first differing byte.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

// Cheap reachability probe.
http.route({
  path: "/health",
  method: "GET",
  handler: httpAction(async () => json({ ok: true })),
})

// GitHub PR webhook. Configure on the repo with content_type=json, the shared
// secret, and the "Pull requests" event. We verify the signature over the raw
// body, then enqueue a review for any open, non-draft PR head SHA.
http.route({
  path: "/github/webhook",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const secret = env.GITHUB_WEBHOOK_SECRET
    if (!secret) return json({ error: "receiver not configured" }, 503)

    const raw = await req.text()
    const expected = `sha256=${await hmacSha256Hex(secret, raw)}`
    const provided = req.headers.get("x-hub-signature-256") ?? ""
    const event = req.headers.get("x-github-event") ?? "unknown"
    const deliveryId = req.headers.get("x-github-delivery") ?? "unknown"

    if (!timingSafeEqual(provided, expected)) {
      await ctx.runMutation(internal.reviews.recordDelivery, {
        deliveryId,
        event,
        outcome: "bad-signature",
      })
      return json({ error: "bad signature" }, 401)
    }

    // GitHub sends `ping` when the webhook is created — answer it so the test passes.
    if (event === "ping") return json({ ok: true, pong: true })

    let body: any
    try {
      body = JSON.parse(raw)
    } catch {
      return json({ error: "body must be JSON" }, 400)
    }

    if (event !== "pull_request") {
      await ctx.runMutation(internal.reviews.recordDelivery, {
        deliveryId,
        event,
        outcome: "ignored",
      })
      return json({ ok: true })
    }

    const action: string = body.action ?? ""
    const pr = body.pull_request ?? {}
    const prNumber: number = body.number ?? pr.number
    const repo: string = body.repository?.full_name ?? ""

    if (action === "closed") {
      const state = pr.merged === true ? "merged" : "closed"
      await ctx.runMutation(internal.reviews.setPrState, {
        repo,
        prNumber,
        state,
        at: isoMs(pr.merged_at) ?? isoMs(pr.closed_at),
      })
      await ctx.runMutation(internal.reviews.recordDelivery, {
        deliveryId,
        event,
        action,
        prNumber,
        outcome: state,
      })
      return json({ ok: true })
    }

    const handled = ["opened", "synchronize", "reopened", "ready_for_review"]
    if (!handled.includes(action) || pr.draft === true) {
      await ctx.runMutation(internal.reviews.recordDelivery, {
        deliveryId,
        event,
        action,
        prNumber,
        outcome: "ignored",
      })
      return json({ ok: true })
    }

    // a reopened PR is alive again — clear any merged/closed stamp before queuing
    if (action === "reopened") {
      await ctx.runMutation(internal.reviews.setPrState, {
        repo,
        prNumber,
        state: "open",
      })
    }

    const outcome = await ctx.runMutation(internal.reviews.enqueue, {
      repo,
      prNumber,
      headSha: pr.head?.sha ?? "",
      title: pr.title ?? "",
      author: pr.user?.login ?? "",
      prUrl: pr.html_url ?? "",
      prCreatedAt: isoMs(pr.created_at),
    })
    await ctx.runMutation(internal.reviews.recordDelivery, {
      deliveryId,
      event,
      action,
      prNumber,
      outcome,
    })
    return json({ ok: true, outcome })
  }),
})

export default http
