// Coerce arbitrary query results into a safe array. React Query persists
// cached entries to localStorage, so a corrupted or legacy value (e.g.,
// from before a server-fn shape change) can hydrate as a non-array
// truthy object — which then blows up `.map` / `for..of` / etc. Always
// route persisted list-shaped query data through this helper before
// iterating. `?? []` alone isn't enough because a truthy-but-wrong value
// passes through it unchanged.
export function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : []
}
