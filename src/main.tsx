import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { ConvexProvider, ConvexReactClient } from "convex/react"
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

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ConvexProvider client={convex}>
      <AccessGate>
        <App />
      </AccessGate>
    </ConvexProvider>
  </StrictMode>,
)
