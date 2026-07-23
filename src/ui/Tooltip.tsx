/**
 * The console's tooltip — the "tinted surface" design.
 *
 * Two tiers from one component, and the tier resolves itself: a tip that
 * carries a body is **rich** (title + wrapping explanation + optional keycap
 * row, and its tone is composited into the card's own material — a low-alpha
 * wash over the surface, a border mixed toward the same hue, the title in the
 * tone's light shade). A tip that is just a label is **plain**: a quiet
 * hairline chip, always neutral. Nothing is bolted on top — there is no
 * coloured rule or bar anywhere.
 *
 * Usage is a drop-in for the `title=` attributes this replaces:
 *
 *   <button {...tip("Open PR on GitHub")} />
 *   <span {...tip("Acked by claude-code", { body: "…", tone: "agent" })} />
 *
 * `tip()` only spreads data attributes, so it works on any element (button,
 * span, anchor) without wrapping it in a positioning div. A single delegated
 * engine (mounted once via <TooltipLayer />) owns hover/focus, positioning,
 * flip/clamp and the notch — so there is exactly one tooltip node in the DOM
 * no matter how many triggers exist.
 *
 * No animation, by design: show and hide are instant paints. The only timing
 * is an integer show-delay, with a warm window so sweeping along a toolbar
 * pops without re-paying it.
 */
import { useEffect, useRef } from "react"

export type TipTone = "neutral" | "ok" | "fail" | "merged" | "agent"
export type TipPlace = "top" | "bottom" | "left" | "right"
export type TipAlign = "start" | "center" | "end"

export type TipOptions = {
  /** The wrapping sentence of explanation. Its presence is what makes a tip rich. */
  body?: string
  /** Only meaningful on a rich tip — the plain tier is always neutral. */
  tone?: TipTone
  /** Space-separated keys, e.g. "⌘ K". Plain tips carry at most the first. */
  keys?: string
  place?: TipPlace
  align?: TipAlign
}

export type TipProps = {
  "data-tip": string
  "data-tip-body"?: string
  "data-tip-tone"?: TipTone
  "data-tip-keys"?: string
  "data-tip-place"?: TipPlace
  "data-tip-align"?: TipAlign
}

/**
 * Build the trigger props. Spread onto any element; pass `undefined` as the
 * label to opt out entirely (handy for conditional tips) — the spread then
 * yields nothing the engine will pick up.
 */
export function tip(label: string, opts: TipOptions = {}): TipProps {
  return {
    "data-tip": label,
    ...(opts.body ? { "data-tip-body": opts.body } : {}),
    ...(opts.tone && opts.tone !== "neutral" ? { "data-tip-tone": opts.tone } : {}),
    ...(opts.keys ? { "data-tip-keys": opts.keys } : {}),
    ...(opts.place ? { "data-tip-place": opts.place } : {}),
    ...(opts.align ? { "data-tip-align": opts.align } : {}),
  }
}

const GAP = 9 // trigger → card, with the notch showing
const PAD = 8 // viewport keep-out
const ARROW_INSET = 12 // how close the notch may sit to a corner
const SHOW_DELAY = 350 // cold hover, ms — the only timing in the design
const WARM_MS = 300 // move to another trigger within this and it pops instantly

const OPPOSITE: Record<TipPlace, TipPlace> = {
  top: "bottom",
  bottom: "top",
  left: "right",
  right: "left",
}

function clamp(v: number, lo: number, hi: number) {
  return hi < lo ? lo : v < lo ? lo : v > hi ? hi : v
}

/**
 * Mount once, near the root. Renders the single tooltip node and installs the
 * delegated listeners; everything else in the app just spreads `tip(...)`.
 */
export function TooltipLayer() {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!ref.current) return
    const tt: HTMLDivElement = ref.current
    const card = tt.querySelector<HTMLElement>("[data-part=card]")!
    const elTitle = tt.querySelector<HTMLElement>("[data-part=title]")!
    const elBody = tt.querySelector<HTMLElement>("[data-part=body]")!
    const elKeys = tt.querySelector<HTMLElement>("[data-part=keys]")!
    const elInline = tt.querySelector<HTMLElement>("[data-part=inlinekeys]")!
    const elArrow = tt.querySelector<HTMLElement>("[data-part=arrow]")!

    let timer: number | null = null
    let current: HTMLElement | null = null
    let lastHidden = 0
    let tier: "plain" | "rich" = "plain"

    const triggerFor = (node: EventTarget | null) =>
      node instanceof Element ? node.closest<HTMLElement>("[data-tip]") : null

    function caps(host: HTMLElement, list: string[]) {
      for (const k of list) {
        if (!k) continue
        const kb = document.createElement("kbd")
        kb.className = "rl-tip-key"
        kb.textContent = k
        host.appendChild(kb)
      }
    }

    function fill(el: HTMLElement) {
      const label = el.getAttribute("data-tip") ?? ""
      const body = el.getAttribute("data-tip-body") ?? ""
      const keys = el.getAttribute("data-tip-keys") ?? ""
      // The graduation rule, in one line: a tip that needs a body is rich.
      tier = body ? "rich" : "plain"
      const tone = tier === "rich" ? el.getAttribute("data-tip-tone") || "neutral" : "neutral"

      elTitle.textContent = label
      elBody.textContent = body
      elKeys.textContent = ""
      elInline.textContent = ""

      if (keys) {
        const list = keys.split(/\s+/)
        if (tier === "plain") {
          caps(elInline, list.slice(0, 1)) // a plain chip carries at most one
        } else {
          const lab = document.createElement("span")
          lab.className = "rl-tip-klabel"
          lab.textContent = "key"
          elKeys.appendChild(lab)
          caps(elKeys, list)
        }
      }

      tt.dataset.tone = tone
      tt.dataset.tier = tier
    }

    function position(el: HTMLElement) {
      const r = el.getBoundingClientRect()
      const vw = document.documentElement.clientWidth
      const vh = document.documentElement.clientHeight

      // Measure at the origin so a previous placement can't constrain this one.
      tt.style.left = "0px"
      tt.style.top = "0px"
      const box = card.getBoundingClientRect()
      const w = box.width
      const h = box.height

      const want = (el.getAttribute("data-tip-place") as TipPlace) || "top"
      const align = (el.getAttribute("data-tip-align") as TipAlign) || "center"

      const fits: Record<TipPlace, boolean> = {
        top: r.top - GAP - h >= PAD,
        bottom: r.bottom + GAP + h <= vh - PAD,
        left: r.left - GAP - w >= PAD,
        right: r.right + GAP + w <= vw - PAD,
      }
      let place = want
      if (!fits[place] && fits[OPPOSITE[place]]) place = OPPOSITE[place]

      let x: number
      let y: number
      if (place === "top" || place === "bottom") {
        y = place === "top" ? r.top - GAP - h : r.bottom + GAP
        x =
          align === "start"
            ? r.left
            : align === "end"
              ? r.right - w
              : r.left + r.width / 2 - w / 2
      } else {
        x = place === "left" ? r.left - GAP - w : r.right + GAP
        y =
          align === "start"
            ? r.top
            : align === "end"
              ? r.bottom - h
              : r.top + r.height / 2 - h / 2
      }

      x = clamp(x, PAD, vw - PAD - w)
      y = clamp(y, PAD, vh - PAD - h)
      tt.style.left = `${Math.round(x)}px`
      tt.style.top = `${Math.round(y)}px`

      // Re-anchor the notch onto the trigger's centre *after* clamping, so a
      // card pushed off-centre by the viewport edge still points at its target.
      const half = tier === "plain" ? 3 : 4 // notch is 7px plain / 9px rich
      elArrow.style.top = elArrow.style.bottom = elArrow.style.left = elArrow.style.right = ""
      if (place === "top" || place === "bottom") {
        const cx = clamp(r.left + r.width / 2 - x, ARROW_INSET, w - ARROW_INSET) - half - 0.5
        elArrow.style.left = `${Math.round(cx)}px`
        if (place === "top") elArrow.style.bottom = `-${half}px`
        else elArrow.style.top = `-${half}px`
      } else {
        const cy = clamp(r.top + r.height / 2 - y, ARROW_INSET, h - ARROW_INSET) - half - 0.5
        elArrow.style.top = `${Math.round(cy)}px`
        if (place === "left") elArrow.style.right = `-${half}px`
        else elArrow.style.left = `-${half}px`
      }
    }

    function show(el: HTMLElement) {
      current = el
      fill(el)
      tt.dataset.on = "1"
      position(el)
      el.setAttribute("aria-describedby", "rl-tooltip")
      tt.setAttribute("aria-hidden", "false")
    }

    function hide() {
      if (timer !== null) {
        window.clearTimeout(timer)
        timer = null
      }
      if (!current) return
      current.removeAttribute("aria-describedby")
      current = null
      lastHidden = Date.now()
      delete tt.dataset.on
      tt.setAttribute("aria-hidden", "true")
    }

    function open(el: HTMLElement, immediate: boolean) {
      if (current === el) return
      if (timer !== null) window.clearTimeout(timer)
      // Warm: the pointer came straight off another trigger, so the delay has
      // already been paid — re-paying it makes a toolbar sweep feel broken.
      const warm = current !== null || Date.now() - lastHidden < WARM_MS
      if (immediate || warm) {
        if (current) hide()
        show(el)
        return
      }
      timer = window.setTimeout(() => {
        timer = null
        show(el)
      }, SHOW_DELAY)
    }

    const onOver = (e: PointerEvent) => {
      const el = triggerFor(e.target)
      if (!el) {
        if (current) hide()
        return
      }
      if (el === current) return
      open(el, false)
    }
    const onOut = (e: PointerEvent) => {
      const el = triggerFor(e.target)
      if (!el) return
      if (triggerFor(e.relatedTarget) === el) return
      hide()
    }
    // Focus shows without the delay — a keyboard user has already committed.
    const onFocus = (e: FocusEvent) => {
      const el = triggerFor(e.target)
      if (el) open(el, true)
    }
    const onBlur = () => hide()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") hide()
    }
    const onScrollOrResize = () => hide()

    document.addEventListener("pointerover", onOver, true)
    document.addEventListener("pointerout", onOut, true)
    document.addEventListener("focusin", onFocus, true)
    document.addEventListener("focusout", onBlur, true)
    document.addEventListener("keydown", onKey, true)
    // The card is position:fixed against a live console — anything that moves
    // the trigger under it (a scrolling rail, a resize) must drop it.
    window.addEventListener("scroll", onScrollOrResize, true)
    window.addEventListener("resize", onScrollOrResize)

    return () => {
      hide()
      document.removeEventListener("pointerover", onOver, true)
      document.removeEventListener("pointerout", onOut, true)
      document.removeEventListener("focusin", onFocus, true)
      document.removeEventListener("focusout", onBlur, true)
      document.removeEventListener("keydown", onKey, true)
      window.removeEventListener("scroll", onScrollOrResize, true)
      window.removeEventListener("resize", onScrollOrResize)
    }
  }, [])

  return (
    <div ref={ref} id="rl-tooltip" className="rl-tip" role="tooltip" aria-hidden="true" data-tier="plain" data-tone="neutral">
      <div className="rl-tip-arrow" data-part="arrow" />
      <div className="rl-tip-card" data-part="card">
        <span className="rl-tip-line">
          <span className="rl-tip-title" data-part="title" />
          <span className="rl-tip-inlinekeys" data-part="inlinekeys" />
        </span>
        <div className="rl-tip-body" data-part="body" />
        <div className="rl-tip-keys" data-part="keys" />
      </div>
    </div>
  )
}
