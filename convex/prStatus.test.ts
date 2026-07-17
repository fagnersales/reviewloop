// Tests for the PR-status module — the pure rules behind "what state is this
// PR in?", exercised through the module's interface (no database needed).
import { describe, it, expect } from "vitest"
import { groupByPr, latestPass, passVerdict, preferredPass, statusKey } from "./prStatus"

describe("latestPass", () => {
  it("picks the newest pass by queuedAt", () => {
    const rows = [{ queuedAt: 1 }, { queuedAt: 3 }, { queuedAt: 2 }]
    expect(latestPass(rows)).toBe(rows[1])
  })
  it("prefers the later row on a tie only if strictly newer (first wins on equal)", () => {
    const rows = [{ queuedAt: 5, tag: "a" }, { queuedAt: 5, tag: "b" }]
    expect(latestPass(rows).tag).toBe("a")
  })
})

describe("preferredPass", () => {
  it("prefers a reviewed row over a newer failed retry", () => {
    const reviewed = { queuedAt: 1, status: "reviewed" as const }
    const failed = { queuedAt: 2, status: "failed" as const }
    expect(preferredPass([failed, reviewed])).toBe(reviewed)
  })
  it("falls back to the newest row when nothing is reviewed", () => {
    const a = { queuedAt: 1, status: "failed" as const }
    const b = { queuedAt: 2, status: "queued" as const }
    expect(preferredPass([a, b])).toBe(b)
  })
})

describe("groupByPr", () => {
  it("groups rows by repo#prNumber, preserving order within a group", () => {
    const r1 = { repo: "o/r", prNumber: 1, tag: "x" }
    const r2 = { repo: "o/r", prNumber: 2, tag: "y" }
    const r3 = { repo: "o/r", prNumber: 1, tag: "z" }
    const groups = groupByPr([r1, r2, r3])
    expect([...groups.keys()]).toEqual(["o/r#1", "o/r#2"])
    expect(groups.get("o/r#1")!.map((r) => r.tag)).toEqual(["x", "z"])
  })
})

describe("passVerdict", () => {
  it("is clean only when both counts are present and zero", () => {
    expect(passVerdict({ p0: 0, p1: 0 })).toBe("clean")
  })
  it("reports blockers when either count is positive", () => {
    expect(passVerdict({ p0: 1, p1: 0 })).toBe("blockers")
    expect(passVerdict({ p0: 0, p1: 2 })).toBe("blockers")
  })
  it("treats a missing count as unknown, never clean (a parse miss must not read as clean)", () => {
    expect(passVerdict({ p0: 0 })).toBe("unknown")
    expect(passVerdict({ p1: 0 })).toBe("unknown")
    expect(passVerdict({})).toBe("unknown")
  })
})

describe("statusKey", () => {
  it("lets the GitHub PR state win over everything", () => {
    expect(statusKey({ prState: "merged", status: "reviewing" })).toBe("merged")
    expect(statusKey({ prState: "closed", status: "reviewed", p0: 0, p1: 0 })).toBe("closed")
  })
  it("passes queued / reviewing / failed straight through", () => {
    expect(statusKey({ status: "queued" })).toBe("queued")
    expect(statusKey({ status: "reviewing" })).toBe("reviewing")
    expect(statusKey({ status: "failed" })).toBe("failed")
  })
  it("resolves a reviewed pass to inprogress when acked — even with blockers", () => {
    expect(statusKey({ status: "reviewed", ackedAt: 123, p0: 3, p1: 1 })).toBe("inprogress")
  })
  it("resolves a clean, unacked reviewed pass to verified", () => {
    expect(statusKey({ status: "reviewed", p0: 0, p1: 0 })).toBe("verified")
  })
  it("resolves an unacked reviewed pass with blockers or unknown counts to awaiting", () => {
    expect(statusKey({ status: "reviewed", p0: 1, p1: 0 })).toBe("awaiting")
    expect(statusKey({ status: "reviewed", p0: 0 })).toBe("awaiting")
    expect(statusKey({ status: "reviewed" })).toBe("awaiting")
  })
})
