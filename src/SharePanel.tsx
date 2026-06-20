import { useEffect, useRef, useState } from "react"
import { QRCodeSVG } from "qrcode.react"
import { Check, Copy, ExternalLink, Smartphone } from "lucide-react"
import {
  IS_LOCAL_CONSOLE,
  LOCAL_PASSCODE,
  PUBLIC_CONSOLE_URL,
  buildDeepLink,
} from "./access"

// Local/admin-only. Surfaces the passcode and a pre-authenticated deep link
// (plus a QR of it) so you can jump to the hosted read-only console already
// signed in — including by scanning the QR from your phone. Renders nothing on
// the public build, where these helpers don't exist.
export function SharePanel() {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onClick = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false)
    }
    document.addEventListener("mousedown", onClick)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("mousedown", onClick)
      document.removeEventListener("keydown", onKey)
    }
  }, [open])

  if (!IS_LOCAL_CONSOLE || !LOCAL_PASSCODE) return null

  const link = buildDeepLink(LOCAL_PASSCODE)

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Phone access / share link"
        aria-label="Phone access / share link"
        className="inline-flex items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-950 px-2.5 py-1.5 text-xs text-zinc-400 transition hover:border-zinc-700 hover:text-zinc-200"
      >
        <Smartphone className="size-3.5" />
        Phone access
      </button>

      {open && (
        <div className="absolute right-0 z-30 mt-2 w-72 rounded-lg border border-zinc-800 bg-zinc-950 p-4 shadow-xl">
          <div className="mb-3 text-xs font-medium text-zinc-300">Open the hosted console</div>

          {!PUBLIC_CONSOLE_URL && (
            <p className="mb-3 rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-[11px] leading-snug text-amber-200/90">
              Set <code className="font-mono">VITE_PUBLIC_CONSOLE_URL</code> in{" "}
              <code className="font-mono">.env.local</code> to your Vercel URL — the
              link below currently points at this local origin.
            </p>
          )}

          <div className="flex flex-col items-center gap-3">
            <div className="rounded-md bg-white p-2">
              <QRCodeSVG value={link} size={148} marginSize={0} />
            </div>
            <span className="text-[11px] text-zinc-600">Scan to open on your phone</span>
          </div>

          <div className="mt-4 space-y-2">
            <CopyRow label="Passcode" value={LOCAL_PASSCODE} mono />
            <CopyRow label="Pre-authenticated link" value={link} href={link} />
          </div>
        </div>
      )}
    </div>
  )
}

function CopyRow({
  label,
  value,
  href,
  mono,
}: {
  label: string
  value: string
  href?: string
  mono?: boolean
}) {
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
    <div>
      <div className="mb-1 text-[10px] uppercase tracking-wide text-zinc-600">{label}</div>
      <div className="flex items-center gap-1.5">
        <code className="min-w-0 flex-1 truncate rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-[11px] text-zinc-300">
          {mono ? value : value.replace(/^https?:\/\//, "")}
        </code>
        {href && (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            title="Open"
            className="rounded-md border border-zinc-800 bg-zinc-950 p-1.5 text-zinc-500 transition hover:border-zinc-700 hover:text-zinc-200"
          >
            <ExternalLink className="size-3.5" />
          </a>
        )}
        <button
          type="button"
          onClick={copy}
          title="Copy"
          aria-label={`Copy ${label}`}
          className="rounded-md border border-zinc-800 bg-zinc-950 p-1.5 text-zinc-500 transition hover:border-zinc-700 hover:text-zinc-200"
        >
          {copied ? <Check className="size-3.5 text-emerald-400" /> : <Copy className="size-3.5" />}
        </button>
      </div>
    </div>
  )
}
