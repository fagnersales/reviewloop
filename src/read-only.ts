import { createContext, useContext } from "react"

// True on the public (Vercel) build, false on the local/admin build. Components
// read this to hide write affordances (add/remove repo) on the hosted console.
// Defaults to true so anything rendered outside the provider fails safe (read
// only) rather than exposing writes.
export const ReadOnlyContext = createContext(true)

export const useReadOnly = () => useContext(ReadOnlyContext)
