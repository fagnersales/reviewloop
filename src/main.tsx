import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { ConvexProvider, ConvexReactClient } from "convex/react"
import { ConvexQueryCacheProvider } from "convex-helpers/react/cache/provider"
import App from "./App.tsx"
import { AccessGate } from "./AccessGate.tsx"
import "./index.css"

const url = import.meta.env.VITE_CONVEX_URL as string | undefined
if (!url) {
  throw new Error(
    "VITE_CONVEX_URL is not set. Run `npx convex dev` to create the deployment.",
  )
}

const convex = new ConvexReactClient(url)

// Keep every query subscription warm for 10 minutes after its component
// unmounts — without dropping the websocket — so switching between Reviews /
// Solves / Follow-ups (and reselecting PRs) is instant and the data stays live
// instead of flashing a loading state on every navigation. Idle subscriptions
// are capped so per-item review-log subs can't pile up unbounded while the few
// top-level board queries stay resident the whole session.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ConvexProvider client={convex}>
      <ConvexQueryCacheProvider expiration={1000 * 60 * 10} maxIdleEntries={50}>
        <AccessGate>
          <App />
        </AccessGate>
      </ConvexQueryCacheProvider>
    </ConvexProvider>
  </StrictMode>,
)
