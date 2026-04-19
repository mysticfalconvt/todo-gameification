import { Link, createFileRoute, redirect } from '@tanstack/react-router'
import { getCurrentSession } from '../server/session'

export const Route = createFileRoute('/')({
  beforeLoad: async () => {
    const session = await getCurrentSession()
    if (session) throw redirect({ to: '/today' })
  },
  component: LandingPage,
})

function LandingPage() {
  return (
    <main className="page-wrap px-4 py-12">
      <section className="mx-auto max-w-2xl text-center">
        <p className="island-kicker mb-3">Todo XP</p>
        <h1 className="display-title mb-4 text-5xl font-bold text-[var(--sea-ink)]">
          A todo app that rewards showing up.
        </h1>
        <p className="mx-auto mb-8 max-w-xl text-lg text-[var(--sea-ink-soft)]">
          Built for ADHD brains. Gentle streaks, no guilt, no metric to beat
          — just a consistent nudge toward the smallest next thing.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-3">
          <Link
            to="/auth/signup"
            className="btn-primary"
          >
            Create account
          </Link>
          <Link
            to="/auth/login"
            className="rounded-full border border-[rgba(50,143,151,0.3)] bg-[rgba(79,184,178,0.14)] px-5 py-2.5 text-sm font-semibold text-[var(--lagoon-deep)] no-underline"
          >
            Log in
          </Link>
        </div>
      </section>

      <section className="mx-auto mt-16 grid max-w-4xl gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Feature
          title="Recurring + someday"
          body="Daily routines, weekly habits, one-off reminders, or 'I'll get to it sometime.' All four recurrence shapes, plus a Someday pile."
        />
        <Feature
          title="XP that reflects effort"
          body="An AI helps score each task by real effort — not just by difficulty flag. Dreaded phone calls score higher than habits that take the same time."
        />
        <Feature
          title="Streaks that don't punish"
          body="Consistency earns a gentle bonus; missing a day doesn't wipe you out. Quiet hours stop escalating nudges overnight."
        />
        <Feature
          title="Friends + leaderboards"
          body="Add friends by handle and compare XP, streaks, or just how often you showed up. Cheer a friend to give them a small XP lift."
        />
        <Feature
          title="Offline + installable"
          body="Works offline as a PWA on Android — add it to your home screen and push notifications arrive like a native app."
        />
        <Feature
          title="Your data, your rules"
          body="Public / friends / private visibility, per-profile and per-task. A REST API and MCP server so your own tools can read and write."
        />
      </section>

      <section className="mx-auto mt-16 max-w-2xl text-center">
        <h2 className="display-title mb-3 text-2xl font-bold text-[var(--sea-ink)]">
          Ready to start?
        </h2>
        <p className="mb-5 text-[var(--sea-ink-soft)]">
          Free. No card. Takes 30 seconds.
        </p>
        <Link
          to="/auth/signup"
          className="btn-primary"
        >
          Create account
        </Link>
      </section>
    </main>
  )
}

function Feature({ title, body }: { title: string; body: string }) {
  return (
    <div className="island-shell rounded-2xl p-5">
      <h3 className="mb-1 text-base font-bold text-[var(--sea-ink)]">
        {title}
      </h3>
      <p className="text-sm text-[var(--sea-ink-soft)]">{body}</p>
    </div>
  )
}
