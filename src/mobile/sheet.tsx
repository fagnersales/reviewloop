// A draggable bottom sheet with snap points. Opening, closing, dismissing, and
// snapping all animate via a CSS transform transition; the live drag bypasses the
// transition and mutates the transform directly for 1:1 finger tracking.
//
// The transform is expressed as a percentage of the sheet's own height, so no
// container measurement is needed for the resting positions — only the live drag
// converts pixel deltas using the measured height.
import { useCallback, useEffect, useRef, useState } from "react"
import { cn } from "../lib/cn"

type Drag = {
  startY: number
  startPct: number
  height: number
  lastY: number
  lastT: number
  vel: number // %/ms, + = downward
}

const HIDDEN = 100 // translateY(100%) = fully off the bottom

export function DraggableSheet({
  open,
  onClose,
  // Ascending fractions of the container height the sheet top can rest at,
  // e.g. [0.5, 0.92] = a half-height peek and a near-full expand.
  snaps,
  initialSnap = 0,
  header,
  children,
  onSnapChange,
}: {
  open: boolean
  onClose: () => void
  snaps: number[]
  initialSnap?: number
  header?: React.ReactNode
  children: React.ReactNode
  onSnapChange?: (index: number) => void
}) {
  const maxSnap = snaps[snaps.length - 1]
  const sheetRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<Drag | null>(null)

  const [render, setRender] = useState(open)
  const [snapIndex, setSnapIndex] = useState(initialSnap)
  const [dragging, setDragging] = useState(false)
  const [pct, setPct] = useState(HIDDEN)

  // translateY% for a resting snap: 0 at the top (max) snap, larger lower down.
  const restPct = useCallback(
    (i: number) => ((maxSnap - snaps[i]) / maxSnap) * 100,
    [maxSnap, snaps],
  )

  useEffect(() => {
    if (open) {
      // Mount hidden, then animate to the snap on the next frames. Two frames so
      // the hidden state actually paints before the transition starts (a single
      // frame flips before paint and the open looks instant).
      setRender(true)
      setSnapIndex(initialSnap)
      setPct(HIDDEN)
      let r2 = 0
      const r1 = requestAnimationFrame(() => {
        r2 = requestAnimationFrame(() => setPct(restPct(initialSnap)))
      })
      return () => {
        cancelAnimationFrame(r1)
        cancelAnimationFrame(r2)
      }
    }
    // Close: animate down, then unmount once the slide-out finishes.
    setPct(HIDDEN)
    const t = setTimeout(() => setRender(false), 320)
    return () => clearTimeout(t)
  }, [open, initialSnap, restPct])

  const onPointerDown = (e: React.PointerEvent) => {
    // Capture is a nicety, not a requirement; never let it throw out the drag.
    try {
      ;(e.target as Element).setPointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
    dragRef.current = {
      startY: e.clientY,
      startPct: pct,
      height: sheetRef.current?.clientHeight || 1,
      lastY: e.clientY,
      lastT: performance.now(),
      vel: 0,
    }
    setDragging(true)
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current
    if (!d) return
    let next = d.startPct + ((e.clientY - d.startY) / d.height) * 100
    next = Math.max(0, Math.min(HIDDEN, next))
    const now = performance.now()
    const dt = now - d.lastT
    if (dt > 0) d.vel = (((e.clientY - d.lastY) / d.height) * 100) / dt
    d.lastY = e.clientY
    d.lastT = now
    if (sheetRef.current) sheetRef.current.style.transform = `translateY(${next}%)`
  }

  const finishDrag = (e: React.PointerEvent) => {
    const d = dragRef.current
    if (!d) return
    dragRef.current = null
    setDragging(false)

    const currentPct = Math.max(0, Math.min(HIDDEN, d.startPct + ((e.clientY - d.startY) / d.height) * 100))
    const snapValue = maxSnap * (1 - currentPct / 100) // fraction of height shown
    const FLICK = 0.1 // %/ms

    // A firm downward flick from the lowest snap, or a drag well below it, dismisses.
    if ((d.vel > FLICK && snapIndex === 0) || (snapValue < snaps[0] - 0.1 && d.vel >= 0)) {
      setPct(HIDDEN)
      onClose()
      return
    }

    let target = snaps.reduce(
      (best, _s, i) =>
        Math.abs(snaps[i] - snapValue) < Math.abs(snaps[best] - snapValue) ? i : best,
      0,
    )
    if (d.vel > FLICK) target = Math.max(0, target - 1)
    if (d.vel < -FLICK) target = Math.min(snaps.length - 1, target + 1)

    if (target !== snapIndex) onSnapChange?.(target)
    setSnapIndex(target)
    setPct(restPct(target))
  }

  if (!render) return null

  const peeking = pct < HIDDEN
  return (
    <div className="absolute inset-0 z-40 overflow-hidden">
      <button
        type="button"
        aria-label="Dismiss"
        onClick={onClose}
        className={cn(
          "absolute inset-0 bg-black/60 transition-opacity duration-300",
          peeking ? "opacity-100" : "opacity-0",
        )}
      />
      <div
        ref={sheetRef}
        className={cn(
          "absolute inset-x-0 bottom-0 flex flex-col overflow-hidden rounded-t-2xl border border-zinc-800 bg-[#0c0c0e] shadow-2xl shadow-black/60",
          !dragging && "transition-transform duration-300 ease-out",
        )}
        style={{ height: `${maxSnap * 100}%`, transform: `translateY(${pct}%)`, willChange: "transform" }}
      >
        {/* Grab area: handle + optional header. Dragging happens here so the
            scrollable body never fights the gesture. */}
        <div
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={finishDrag}
          onPointerCancel={finishDrag}
          className="shrink-0 cursor-grab touch-none select-none active:cursor-grabbing"
        >
          <div className="flex justify-center pb-1 pt-2.5">
            <span className="h-1 w-9 rounded-full bg-zinc-700" />
          </div>
          {header}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-6">{children}</div>
      </div>
    </div>
  )
}
