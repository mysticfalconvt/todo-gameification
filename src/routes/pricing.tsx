import { createFileRoute } from '@tanstack/react-router'
import { PricingTable } from '../components/pricing/PricingTable'
import { getCurrentSession } from '../server/session'

// Public pricing page. Renders for both logged-in and logged-out users:
// the PricingTable swaps signup CTAs for direct Upgrade buttons when a
// session is present.
export const Route = createFileRoute('/pricing')({
  loader: async () => {
    // Wrap the session fetch — a transient TanStack Start dispatch error
    // (we've seen rare TypeError("…reading 'method'") in the start-server-core
    // server-functions-handler in dev) shouldn't crash the public pricing
    // page. Defaulting to `authenticated: false` just shows the public
    // signup CTAs, which is the safe fallback.
    try {
      const session = await getCurrentSession()
      return { authenticated: Boolean(session) }
    } catch (err) {
      console.warn('[pricing] failed to resolve session, defaulting to public', err)
      return { authenticated: false }
    }
  },
  component: PricingPage,
})

function PricingPage() {
  const { authenticated } = Route.useLoaderData()
  return (
    <main className="page-wrap px-4 py-12">
      <section className="mx-auto mb-8 max-w-2xl text-center">
        <p className="island-kicker mb-3">Pricing</p>
        <h1 className="display-title mb-3 text-4xl font-bold text-[var(--sea-ink)]">
          Simple pricing, generous free tier
        </h1>
        <p className="text-[var(--sea-ink-soft)]">
          Memory Flip and Sliding Puzzle stay free forever. Upgrade for the AI
          Coach personalities, the rest of the arcade, and the Garden.
        </p>
      </section>
      <div className="mx-auto max-w-5xl">
        <PricingTable publicVariant={!authenticated} />
      </div>
    </main>
  )
}
