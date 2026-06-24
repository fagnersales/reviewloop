// The phone-access popover that lives at the foot of the nav rail (local/admin
// build only). It surfaces the passcode and a pre-authenticated deep link (plus
// a QR of it) so you can hop to the hosted read-only console already signed in —
// including by scanning the QR from your phone. Renders nothing on the public
// build, where these helpers don't exist. Replaces the old header SharePanel.
import { useEffect, useRef, useState } from "react"
import { QRCodeSVG } from "qrcode.react"
import { Check, Copy, Smartphone } from "lucide-react"
import { cn } from "../lib/cn"
import { IS_LOCAL_CONSOLE, LOCAL_PASSCODE, buildDeepLink } from "../access"

export function PhoneAccess() {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false)
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [open])

  if (!IS_LOCAL_CONSOLE || !LOCAL_PASSCODE) return null

  const link = buildDeepLink(LOCAL_PASSCODE)

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Phone access"
        aria-label="Phone access"
        className={cn(
          "relative flex size-10 items-center justify-center rounded-md border transition-colors",
          open
            ? "border-edge2 bg-railsel text-zinc-100"
            : "border-transparent text-zinc-500 hover:bg-railsel/60 hover:text-zinc-300",
        )}
      >
        <Smartphone className="size-[18px]" />
      </button>

      {open && (
        <>
          <div onClick={() => setOpen(false)} className="fixed inset-0 z-40" />
          <div className="absolute bottom-0 left-[calc(100%+12px)] z-50 w-[268px] rounded-[9px] border border-edge2 bg-elevated p-4 shadow-[0_18px_44px_rgba(0,0,0,0.6)]">
            <div className="mb-1 flex items-center gap-2">
              <Smartphone className="size-3.5 text-accent" />
              <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-300">
                Phone access
              </span>
            </div>
            <p className="m-0 mb-3.5 text-[11.5px] leading-relaxed text-zinc-500">
              Scan to open the read-only console on your phone, already signed in.
            </p>
            <div className="flex justify-center">
              <div className="rounded-[7px] bg-white p-[9px] leading-[0]">
                <QRCodeSVG value={link} size={174} marginSize={0} />
              </div>
            </div>
            <CopyField label="Passcode" value={LOCAL_PASSCODE} />
            <CopyField label="Pre-authenticated link" value={link} display={link.replace(/^https?:\/\//, "")} />
          </div>
        </>
      )}
    </div>
  )
}

function CopyField({ label, value, display }: { label: string; value: string; display?: string }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])

  const copy = () => {
    void navigator.clipboard?.writeText(value).then(() => {
      setCopied(true)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), 1200)
    })
  }

  return (
    <div className="mt-2.5">
      <div className="mb-1.5 font-mono text-[9px] uppercase tracking-[0.16em] text-zinc-600">{label}</div>
      <div className="flex items-center gap-1.5">
        <code className="min-w-0 flex-1 truncate rounded-[5px] border border-edge bg-inset px-2.5 py-1.5 font-mono text-xs text-zinc-300">
          {display ?? value}
        </code>
        <button
          type="button"
          onClick={copy}
          title={`Copy ${label.toLowerCase()}`}
          aria-label={`Copy ${label.toLowerCase()}`}
          className="flex size-[30px] shrink-0 items-center justify-center rounded-[5px] border border-edge bg-[#0d0d0f] text-zinc-500 transition-colors hover:border-edge2 hover:text-zinc-300"
        >
          {copied ? <Check className="size-3.5 text-accent" strokeWidth={2.4} /> : <Copy className="size-[13px]" />}
        </button>
      </div>
    </div>
  )
}
