import { useEffect, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useRouter } from '@tanstack/react-router'
import { toast } from 'sonner'
import { authClient, signOut, useSession } from '../../../lib/auth-client'
import { ThemePicker } from '../../../components/ThemeToggle'
import {
  currentPushStatus,
  disablePushNotifications,
  enablePushNotifications,
  type PushSupportStatus,
} from '../../../lib/push'
import {
  createApiToken,
  listApiTokens,
  revokeApiToken,
} from '../../../server/functions/api-tokens'
import {
  getGithubIntegration,
  removeGithubIntegration,
  syncGithubNow,
  updateGithubPollInterval,
  updateGithubSyncOptions,
  upsertGithubIntegration,
} from '../../../server/functions/github'
import {
  backfillCategories,
  countUncategorizedTasks,
  createCategory,
  deleteCategory,
  listCategories,
  updateCategory,
} from '../../../server/functions/categories'
import {
  getProfile,
  updateGardenVisibility,
  updateHandle,
  updatePrefs,
  updateProfileVisibility,
  updateQuietHours,
} from '../../../server/functions/user'
import {
  createHouseholdFn,
  deleteHouseholdFn,
  getMyHouseholdFn,
} from '../../../server/functions/households'
import {
  createAnnualCheckoutFn,
  createLifetimeCheckoutFn,
  createPortalSessionFn,
  getMemberStatusFn,
  getPricingDisplayFn,
} from '../../../server/functions/billing'
import { deleteAccountFn } from '../../../server/functions/account'
import { resetTasks } from '../../../server/functions/tasks'
import {
  MembersOnlyUpsell,
  formatMoney,
} from '../../../components/membership/MembersOnlyUpsell'

export const Route = createFileRoute('/_authenticated/settings/')({
  component: SettingsPage,
})

function ManagedAccountSettingsLockout({
  role,
}: {
  role: 'kid' | 'kiosk'
}) {
  const router = useRouter()
  const qc = useQueryClient()
  const [signingOut, setSigningOut] = useState(false)

  async function onSignOut() {
    setSigningOut(true)
    try {
      await signOut()
      qc.removeQueries()
      try {
        localStorage.removeItem('todo-xp-query-cache-v1')
      } catch {
        // no-op if storage is blocked
      }
      await router.invalidate()
      router.navigate({ to: '/' })
    } finally {
      setSigningOut(false)
    }
  }

  const homeTo = role === 'kiosk' ? '/household' : '/today'
  return (
    <main className="page-wrap px-4 py-12">
      <section className="island-shell mx-auto max-w-md rounded-2xl p-6 sm:p-8">
        <p className="island-kicker mb-1">Settings</p>
        <h1 className="display-title mb-3 text-3xl font-bold text-[var(--sea-ink)]">
          {role === 'kiosk' ? 'Kiosk accounts' : 'Kid accounts'}{' '}
          can&rsquo;t change settings
        </h1>
        <p className="text-sm text-[var(--sea-ink-soft)]">
          Ask a grown-up in your household to update preferences for you
          from their settings page.
        </p>
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <Link
            to={homeTo}
            className="inline-block rounded-full border border-[rgba(50,143,151,0.3)] bg-[rgba(79,184,178,0.14)] px-4 py-2 text-sm font-semibold text-[var(--lagoon-deep)] no-underline"
          >
            ← Back
          </Link>
          <button
            type="button"
            onClick={onSignOut}
            disabled={signingOut}
            className="rounded-full border border-[var(--line)] bg-[var(--option-bg)] px-4 py-2 text-sm font-semibold text-[var(--sea-ink-soft)] transition hover:text-red-600 disabled:opacity-60"
          >
            {signingOut ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      </section>
    </main>
  )
}

function SettingsPage() {
  const { data: session } = useSession()
  // Kid + kiosk accounts get a stripped-down "ask a grown-up" view
  // here. Settings has too many destructive surfaces (delete account,
  // reset tasks, household delete, GitHub token, API tokens) to leave
  // open to managed accounts. They keep access to the rest of the
  // app — this is the one route we lock down.
  const householdQuery = useQuery({
    queryKey: ['my-household'],
    queryFn: () => getMyHouseholdFn(),
  })
  const myRole = householdQuery.data?.role ?? null
  if (myRole === 'kid' || myRole === 'kiosk') {
    return <ManagedAccountSettingsLockout role={myRole} />
  }

  return (
    <main className="page-wrap space-y-8 px-4 py-8">
      <h1 className="display-title text-4xl font-bold text-[var(--sea-ink)]">
        Profile & settings
      </h1>
      <ProfileSection user={session?.user} />
      <MembershipSection />
      <PrivacySection />
      <HouseholdSection />
      <AppearanceSection />
      <CoachAttitudeSection />
      <WeeklySummarySection />
      <CategoriesSection />
      <PasswordSection />
      <NotificationsSection />
      <GithubSection />
      <TokensSection />
      <SignOutSection />
      <ResetSection />
      <DangerZoneSection />
      <p className="pt-4 text-center text-xs text-[var(--sea-ink-soft)]">
        Have an idea for the app?{' '}
        <Link
          to="/feedback"
          className="font-semibold text-[var(--lagoon-deep)] underline"
        >
          Send a feature request →
        </Link>
      </p>
    </main>
  )
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

function CategoriesSection() {
  const qc = useQueryClient()
  const categoriesQuery = useQuery({
    queryKey: ['categories'],
    queryFn: () => listCategories(),
  })

  const [newLabel, setNewLabel] = useState('')
  const [newColor, setNewColor] = useState('#4fb8b2')
  const [newDescription, setNewDescription] = useState('')

  const create = useMutation({
    mutationFn: (input: { label: string; color: string; description: string }) =>
      createCategory({ data: input }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['categories'] })
      setNewLabel('')
      setNewDescription('')
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : 'Create failed'),
  })

  const uncategorizedQuery = useQuery({
    queryKey: ['uncategorized-count'],
    queryFn: () => countUncategorizedTasks(),
  })

  const backfill = useMutation({
    mutationFn: () => backfillCategories(),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['tasks'] })
      qc.invalidateQueries({ queryKey: ['today'] })
      qc.invalidateQueries({ queryKey: ['someday'] })
      qc.invalidateQueries({ queryKey: ['uncategorized-count'] })
      if (res.assigned > 0) {
        toast.success(
          `Categorized ${res.assigned} task${res.assigned === 1 ? '' : 's'}${res.skipped > 0 ? ` (${res.skipped} skipped)` : ''}.`,
        )
      } else if (res.skipped > 0) {
        toast.error(
          `Couldn't categorize ${res.skipped} task${res.skipped === 1 ? '' : 's'}. Check the LLM connection.`,
        )
      } else {
        toast.message('Nothing to do.')
      }
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : 'Backfill failed'),
  })

  const uncategorized = uncategorizedQuery.data ?? 0

  const remove = useMutation({
    mutationFn: (slug: string) => deleteCategory({ data: { slug } }),
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ['categories'] })
      qc.invalidateQueries({ queryKey: ['tasks'] })
      qc.invalidateQueries({ queryKey: ['today'] })
      if (result.reassigned > 0) {
        toast.message(
          `Removed. ${result.reassigned} task${result.reassigned === 1 ? '' : 's'} became uncategorized.`,
        )
      }
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : 'Delete failed'),
  })

  return (
    <section className="island-shell max-w-xl rounded-2xl p-6">
      <h2 className="mb-2 text-lg font-bold text-[var(--sea-ink)]">
        Categories
      </h2>
      <p className="mb-4 text-sm text-[var(--sea-ink-soft)]">
        The AI picks one of these when you create a task. Add new ones or
        remove ones you don't use. Deleting a category un-sets it on existing
        tasks; they become "uncategorized" and you can re-analyze to reassign.
      </p>

      {categoriesQuery.isLoading ? (
        <p className="text-sm text-[var(--sea-ink-soft)]">Loading…</p>
      ) : (
        <ul className="mb-4 space-y-2">
          {(Array.isArray(categoriesQuery.data) ? categoriesQuery.data : []).map((c) => (
            <CategoryRow key={c.slug} category={c} onDelete={remove.mutate} />
          ))}
        </ul>
      )}

      {uncategorized > 0 ? (
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--line)] bg-[var(--option-bg)] p-3">
          <p className="text-sm text-[var(--sea-ink-soft)]">
            {uncategorized} task{uncategorized === 1 ? '' : 's'} still
            uncategorized. Run the AI to assign categories.
          </p>
          <button
            type="button"
            onClick={() => backfill.mutate()}
            disabled={backfill.isPending}
            className="rounded-full border border-[rgba(50,143,151,0.3)] bg-[rgba(79,184,178,0.14)] px-4 py-2 text-sm font-semibold text-[var(--lagoon-deep)] disabled:opacity-60"
          >
            {backfill.isPending ? 'Categorizing…' : `Categorize ${uncategorized}`}
          </button>
        </div>
      ) : null}

      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (!newLabel.trim()) return
          create.mutate({
            label: newLabel,
            color: newColor,
            description: newDescription,
          })
        }}
        className="space-y-3"
      >
        <div className="flex flex-wrap items-end gap-3">
          <label className="block flex-1 min-w-[12rem]">
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-[var(--kicker)]">
              New category
            </span>
            <input
              type="text"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              placeholder="e.g. Parenting"
              maxLength={40}
              className="field-input"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-[var(--kicker)]">
              Color
            </span>
            <input
              type="color"
              value={newColor}
              onChange={(e) => setNewColor(e.target.value)}
              className="h-10 w-14 cursor-pointer rounded-lg border border-[var(--line)] bg-transparent"
            />
          </label>
          <button
            type="submit"
            disabled={create.isPending || !newLabel.trim()}
            className="rounded-full border border-[rgba(50,143,151,0.3)] bg-[rgba(79,184,178,0.14)] px-4 py-2 text-sm font-semibold text-[var(--lagoon-deep)] disabled:opacity-60"
          >
            {create.isPending ? 'Adding…' : 'Add'}
          </button>
        </div>
        <label className="block">
          <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-[var(--kicker)]">
            Description <span className="normal-case text-[var(--sea-ink-soft)]">(optional — helps the AI)</span>
          </span>
          <textarea
            value={newDescription}
            onChange={(e) => setNewDescription(e.target.value)}
            placeholder="What belongs in this category? e.g. anything involving the kids, school, daycare."
            maxLength={280}
            rows={2}
            className="field-input w-full resize-y"
          />
        </label>
      </form>
    </section>
  )
}

function CategoryRow({
  category,
  onDelete,
}: {
  category: Awaited<ReturnType<typeof listCategories>>[number]
  onDelete: (slug: string) => void
}) {
  const qc = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [label, setLabel] = useState(category.label)
  const [color, setColor] = useState(category.color)
  const [description, setDescription] = useState(category.description ?? '')

  const save = useMutation({
    mutationFn: () =>
      updateCategory({
        data: { slug: category.slug, label, color, description },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['categories'] })
      qc.invalidateQueries({ queryKey: ['tasks'] })
      setEditing(false)
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : 'Update failed'),
  })

  if (editing) {
    return (
      <li className="space-y-2 rounded-xl border border-[var(--line)] p-2">
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="color"
            value={color}
            onChange={(e) => setColor(e.target.value)}
            className="h-8 w-10 cursor-pointer rounded-lg border border-[var(--line)] bg-transparent"
          />
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            maxLength={40}
            className="field-input flex-1 min-w-[10rem]"
          />
          <button
            type="button"
            onClick={() => save.mutate()}
            disabled={save.isPending || !label.trim()}
            className="rounded-full border border-[rgba(50,143,151,0.3)] bg-[rgba(79,184,178,0.14)] px-3 py-1 text-xs font-semibold text-[var(--lagoon-deep)] disabled:opacity-60"
          >
            Save
          </button>
          <button
            type="button"
            onClick={() => {
              setLabel(category.label)
              setColor(category.color)
              setDescription(category.description ?? '')
              setEditing(false)
            }}
            className="rounded-full border border-[var(--line)] bg-[var(--option-bg)] px-3 py-1 text-xs font-semibold text-[var(--sea-ink-soft)]"
          >
            Cancel
          </button>
        </div>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Optional description — helps the AI categorize tasks."
          maxLength={280}
          rows={2}
          className="field-input w-full resize-y"
        />
      </li>
    )
  }

  return (
    <li className="flex items-start gap-3 rounded-xl border border-[var(--line)] bg-[var(--option-bg)] p-2">
      <span
        aria-hidden
        className="mt-1.5 h-3 w-3 flex-shrink-0 rounded-full"
        style={{ backgroundColor: category.color }}
      />
      <span className="min-w-0 flex-1">
        <span className="text-sm font-semibold text-[var(--sea-ink)]">
          {category.label}
        </span>
        {category.description ? (
          <p className="mt-0.5 text-xs text-[var(--sea-ink-soft)]">
            {category.description}
          </p>
        ) : null}
      </span>
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="rounded-full border border-[var(--line)] bg-[var(--option-bg)] px-3 py-1 text-xs font-semibold text-[var(--sea-ink-soft)]"
      >
        Edit
      </button>
      <button
        type="button"
        onClick={() => {
          if (
            confirm(
              `Delete "${category.label}"? Tasks in this category become uncategorized.`,
            )
          ) {
            onDelete(category.slug)
          }
        }}
        className="rounded-full border border-[var(--line)] bg-[var(--option-bg)] px-3 py-1 text-xs font-semibold text-[var(--sea-ink-soft)] transition hover:text-red-600"
      >
        Delete
      </button>
    </li>
  )
}

// ---------------------------------------------------------------------------
// Appearance
// ---------------------------------------------------------------------------

function AppearanceSection() {
  return (
    <section className="island-shell max-w-xl rounded-2xl p-6">
      <h2 className="mb-2 text-lg font-bold text-[var(--sea-ink)]">Appearance</h2>
      <p className="mb-4 text-sm text-[var(--sea-ink-soft)]">
        Choose the color theme. Auto follows your system setting.
      </p>
      <ThemePicker />
    </section>
  )
}

// ---------------------------------------------------------------------------
// Membership
// ---------------------------------------------------------------------------

function MembershipSection() {
  // After Stripe Checkout we're redirected to /settings?billing=pending;
  // the webhook is the only thing that flips the projection, so poll for
  // ~30s before falling back to a "we'll email when ready" message.
  const [pending, setPending] = useState(() =>
    typeof window !== 'undefined'
      ? new URLSearchParams(window.location.search).get('billing') === 'pending'
      : false,
  )
  const memberQuery = useQuery({
    queryKey: ['member-status'],
    queryFn: () => getMemberStatusFn(),
    refetchInterval: pending ? 2000 : false,
  })

  useEffect(() => {
    if (!pending) return
    if (memberQuery.data?.isMember) {
      setPending(false)
      // Strip the query so a refresh doesn't restart polling.
      if (typeof window !== 'undefined') {
        const url = new URL(window.location.href)
        url.searchParams.delete('billing')
        window.history.replaceState({}, '', url.toString())
      }
      toast.success('Membership activated 🎉')
      return
    }
    const timeout = setTimeout(() => setPending(false), 30_000)
    return () => clearTimeout(timeout)
  }, [pending, memberQuery.data?.isMember])

  const pricingQuery = useQuery({
    queryKey: ['pricing-display'],
    queryFn: () => getPricingDisplayFn(),
    enabled: memberQuery.data ? !memberQuery.data.isMember : false,
    staleTime: 60_000,
  })

  const annual = useMutation({
    mutationFn: () => createAnnualCheckoutFn(),
    onSuccess: ({ url }) => window.location.assign(url),
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : 'Could not start checkout'),
  })
  const lifetime = useMutation({
    mutationFn: () => createLifetimeCheckoutFn(),
    onSuccess: ({ url }) => window.location.assign(url),
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : 'Could not start checkout'),
  })
  const portal = useMutation({
    mutationFn: () => createPortalSessionFn(),
    onSuccess: ({ url }) => window.location.assign(url),
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : 'Could not open portal'),
  })

  const m = memberQuery.data
  if (memberQuery.isLoading || !m) {
    return (
      <section className="island-shell max-w-xl rounded-2xl p-6">
        <h2 className="mb-2 text-lg font-bold text-[var(--sea-ink)]">
          Membership
        </h2>
        <p className="text-sm text-[var(--sea-ink-soft)]">Loading…</p>
      </section>
    )
  }

  const a = pricingQuery.data?.annual
  const l = pricingQuery.data?.lifetime
  const annualLabel = a
    ? `${formatMoney(a.amount, a.currency)}/${a.interval}`
    : '…'
  const lifetimeLabel = l ? `${formatMoney(l.amount, l.currency)} once` : '…'

  return (
    <section className="island-shell max-w-xl rounded-2xl p-6">
      <h2 className="mb-2 text-lg font-bold text-[var(--sea-ink)]">
        Membership
      </h2>
      {m.inherited ? (
        <div className="space-y-2">
          <p className="text-base font-semibold text-[var(--sea-ink)]">
            Full access ✨
          </p>
          <p className="text-sm text-[var(--sea-ink-soft)]">
            You have full access through your household — the Garden, full
            arcade, AI Coach personalities, and weekly email are all unlocked.
            No separate subscription needed.
          </p>
        </div>
      ) : m.tier === 'lifetime' ? (
        <div className="space-y-2">
          <p className="text-base font-semibold text-[var(--sea-ink)]">
            Lifetime ✨
          </p>
          <p className="text-sm text-[var(--sea-ink-soft)]">
            {m.source === 'admin'
              ? 'Granted by the team — thank you for testing.'
              : 'You bought lifetime access. No renewals, no expiry.'}
          </p>
        </div>
      ) : m.tier === 'annual' ? (
        <div className="space-y-3">
          <p className="text-base font-semibold text-[var(--sea-ink)]">
            Annual member
          </p>
          {m.cancelAtPeriodEnd && m.currentPeriodEnd ? (
            <p className="text-sm text-[rgb(180,90,40)]">
              Cancels {new Date(m.currentPeriodEnd).toLocaleDateString()}.
            </p>
          ) : m.currentPeriodEnd ? (
            <p className="text-sm text-[var(--sea-ink-soft)]">
              Renews {new Date(m.currentPeriodEnd).toLocaleDateString()}.
            </p>
          ) : null}
          <button
            type="button"
            onClick={() => portal.mutate()}
            disabled={portal.isPending}
            className="rounded-full border border-[rgba(50,143,151,0.3)] bg-[rgba(79,184,178,0.14)] px-5 py-2 text-sm font-semibold text-[var(--lagoon-deep)] disabled:opacity-50"
          >
            {portal.isPending ? 'Opening…' : 'Manage billing'}
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {pending ? (
            <div className="rounded-2xl border border-[rgba(50,143,151,0.3)] bg-[rgba(79,184,178,0.1)] p-3 text-sm text-[var(--lagoon-deep)]">
              Finalizing your payment with Stripe… this usually takes a few
              seconds. The page updates automatically.
            </div>
          ) : null}
          <p className="text-sm text-[var(--sea-ink-soft)]">
            You're on Free. Upgrade to unlock the full arcade, the AI Coach
            personalities + detailed mode, and the Garden.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => annual.mutate()}
              disabled={annual.isPending || lifetime.isPending}
              className="rounded-full bg-[var(--btn-primary-bg)] px-4 py-2 text-sm font-semibold text-[var(--btn-primary-fg)] disabled:opacity-50"
            >
              {annual.isPending ? 'Redirecting…' : `Annual · ${annualLabel}`}
            </button>
            <button
              type="button"
              onClick={() => lifetime.mutate()}
              disabled={annual.isPending || lifetime.isPending}
              className="rounded-full border border-[rgba(50,143,151,0.3)] bg-[rgba(79,184,178,0.14)] px-4 py-2 text-sm font-semibold text-[var(--lagoon-deep)] disabled:opacity-50"
            >
              {lifetime.isPending ? 'Redirecting…' : `Lifetime · ${lifetimeLabel}`}
            </button>
            <Link
              to="/pricing"
              className="self-center text-xs text-[var(--lagoon-deep)] no-underline"
            >
              Compare features →
            </Link>
          </div>
        </div>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Coach attitude
// ---------------------------------------------------------------------------

type CoachAttitudeSlug = 'warm' | 'snarky' | 'stoic' | 'drill' | 'zen'

const COACH_ATTITUDE_OPTIONS: ReadonlyArray<{
  value: CoachAttitudeSlug
  label: string
  glyph: string
  hint: string
}> = [
  {
    value: 'warm',
    label: 'Warm',
    glyph: '·',
    hint: 'A warm, ADHD-aware companion. The original voice.',
  },
  {
    value: 'snarky',
    label: 'Snarky',
    glyph: '✦',
    hint: 'Sarcastic and dry. Roasts the to-do list, never the human.',
  },
  {
    value: 'stoic',
    label: 'Stoic',
    glyph: '◻',
    hint: 'Just facts. No personality, no warmth, no humor.',
  },
  {
    value: 'drill',
    label: 'Drill Sergeant',
    glyph: '★',
    hint: 'Theatrical tough-love. Short, punchy, imperative.',
  },
  {
    value: 'zen',
    label: 'Zen',
    glyph: '◯',
    hint: 'Calm and unhurried. Reframes the day toward "do less, breathe."',
  },
]

function CoachAttitudeSection() {
  const qc = useQueryClient()
  const profileQuery = useQuery({
    queryKey: ['profile'],
    queryFn: () => getProfile(),
  })
  const memberQuery = useQuery({
    queryKey: ['member-status'],
    queryFn: () => getMemberStatusFn(),
  })
  const [upsellOpen, setUpsellOpen] = useState(false)

  const setPrefs = useMutation({
    mutationFn: (patch: {
      coachAttitude?: CoachAttitudeSlug
      coachDetailed?: boolean
    }) => updatePrefs({ data: patch }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['profile'] })
      // Force the today-page coach blurb to regenerate with the new voice
      // instead of waiting on its 2-hour refetchInterval.
      qc.invalidateQueries({ queryKey: ['coach'] })
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : 'Update failed'),
  })

  const current = (profileQuery.data?.coachAttitude ?? 'warm') as CoachAttitudeSlug
  const detailed = profileQuery.data?.coachDetailed ?? false
  const selectedHint =
    COACH_ATTITUDE_OPTIONS.find((o) => o.value === current)?.hint ?? ''
  const isMember = memberQuery.data?.isMember ?? false

  return (
    <section className="island-shell max-w-xl rounded-2xl p-6">
      <h2 className="mb-2 text-lg font-bold text-[var(--sea-ink)]">
        Coach attitude
      </h2>
      <p className="mb-4 text-sm text-[var(--sea-ink-soft)]">
        Pick the voice your daily coach uses on the Today page.
      </p>
      <div
        className="flex flex-wrap gap-2"
        role="radiogroup"
        aria-label="Coach attitude"
      >
        {COACH_ATTITUDE_OPTIONS.map((o) => {
          const selected = current === o.value
          const locked = !isMember && o.value !== 'warm'
          return (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={setPrefs.isPending}
              onClick={() => {
                if (locked) {
                  setUpsellOpen(true)
                  return
                }
                setPrefs.mutate({ coachAttitude: o.value })
              }}
              className={`inline-flex items-center gap-1 rounded-full border px-3 py-1 text-sm font-semibold transition disabled:opacity-60 ${
                selected
                  ? 'border-[var(--lagoon-deep)] bg-[rgba(79,184,178,0.2)] text-[var(--lagoon-deep)]'
                  : 'border-[var(--line)] bg-[var(--option-bg)] text-[var(--sea-ink-soft)] hover:bg-[var(--option-bg-hover)]'
              }`}
            >
              <span aria-hidden>{locked ? '🔒' : o.glyph}</span>
              <span>{o.label}</span>
            </button>
          )
        })}
      </div>
      {selectedHint && (
        <p className="mt-3 text-xs text-[var(--sea-ink-soft)]">{selectedHint}</p>
      )}
      {!isMember && (
        <p className="mt-2 text-xs text-[var(--sea-ink-soft)]">
          Warm is the free voice. Members get the other four personalities and
          detailed responses.
        </p>
      )}

      <div className="mt-5 flex items-start justify-between gap-4 border-t border-[var(--line)] pt-4">
        <div className="flex-1">
          <p className="flex items-center gap-2 text-sm font-semibold text-[var(--sea-ink)]">
            Detailed responses
            {!isMember ? (
              <span className="rounded-full bg-[rgba(50,143,151,0.14)] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-[var(--lagoon-deep)]">
                🔒 Members
              </span>
            ) : null}
          </p>
          <p className="mt-1 text-xs text-[var(--sea-ink-soft)]">
            Off: 1–3 sentences. On: 3–6 sentences with more context — names a
            task, calls out weekly trends, may suggest a next step. Works with
            any attitude above.
          </p>
        </div>
        <Switch
          checked={detailed && isMember}
          disabled={setPrefs.isPending}
          onChange={(v) => {
            if (!isMember) {
              setUpsellOpen(true)
              return
            }
            setPrefs.mutate({ coachDetailed: v })
          }}
          ariaLabel="Detailed responses"
        />
      </div>
      <MembersOnlyUpsell
        open={upsellOpen}
        onClose={() => setUpsellOpen(false)}
        headline="Unlock the full coach"
        subline="Members get all five personalities (Snarky, Stoic, Drill Sergeant, Zen) and detailed mode."
      />
    </section>
  )
}

function Switch({
  checked,
  disabled,
  onChange,
  ariaLabel,
}: {
  checked: boolean
  disabled?: boolean
  onChange: (next: boolean) => void
  ariaLabel: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border transition disabled:opacity-60 ${
        checked
          ? 'border-[var(--lagoon-deep)] bg-[rgba(79,184,178,0.5)]'
          : 'border-[var(--line)] bg-[var(--option-bg)]'
      }`}
    >
      <span
        aria-hidden
        className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition ${
          checked ? 'translate-x-6' : 'translate-x-1'
        }`}
      />
    </button>
  )
}

// ---------------------------------------------------------------------------
// Weekly summary
// ---------------------------------------------------------------------------

function WeeklySummarySection() {
  const qc = useQueryClient()
  const profileQuery = useQuery({
    queryKey: ['profile'],
    queryFn: () => getProfile(),
  })
  const memberQuery = useQuery({
    queryKey: ['member-status'],
    queryFn: () => getMemberStatusFn(),
  })
  const isMember = memberQuery.data?.isMember === true
  const optedIn = profileQuery.data?.weeklyEmailOptIn ?? false

  const setPref = useMutation({
    mutationFn: (weeklyEmailOptIn: boolean) =>
      updatePrefs({ data: { weeklyEmailOptIn } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['profile'] }),
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : 'Update failed'),
  })

  return (
    <section className="island-shell max-w-xl rounded-2xl p-6">
      <h2 className="mb-1 text-lg font-bold text-[var(--sea-ink)]">
        Weekly summary
      </h2>
      <p className="mb-4 text-sm text-[var(--sea-ink-soft)]">
        A Monday-morning recap of your week — completions, streaks, habits,
        arcade, and how you stack up against friends, with a short AI review.{' '}
        <Link
          to="/weekly-summary"
          className="font-semibold text-[var(--lagoon-deep)] underline"
        >
          Preview your summary →
        </Link>
      </p>

      <label className="flex cursor-pointer items-start justify-between gap-3 rounded-xl border border-[var(--line)] bg-[var(--option-bg)] p-3">
        <span className="flex-1">
          <span className="block text-sm font-semibold text-[var(--sea-ink)]">
            Email me the weekly summary
          </span>
          <span className="block text-xs text-[var(--sea-ink-soft)]">
            {isMember
              ? 'Sent Monday around 8am your time. Off by default — flip this on to receive it.'
              : 'The weekly email is a membership feature. Scroll up to Membership to upgrade.'}
          </span>
        </span>
        <Switch
          checked={optedIn && isMember}
          disabled={!isMember || setPref.isPending}
          onChange={(v) => setPref.mutate(v)}
          ariaLabel="Email me the weekly summary"
        />
      </label>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Sign out
// ---------------------------------------------------------------------------

function SignOutSection() {
  const router = useRouter()
  const qc = useQueryClient()
  const [pending, setPending] = useState(false)

  async function onSignOut() {
    setPending(true)
    try {
      await signOut()
      // Clear the persisted cache — otherwise admin flags, friends lists,
      // etc. leak into the next account that signs in on this device.
      qc.removeQueries()
      try {
        localStorage.removeItem('todo-xp-query-cache-v1')
      } catch {
        // no-op if storage is blocked
      }
      await router.invalidate()
      router.navigate({ to: '/' })
    } finally {
      setPending(false)
    }
  }

  return (
    <section className="max-w-xl">
      <button
        type="button"
        onClick={onSignOut}
        disabled={pending}
        className="rounded-full border border-[var(--line)] bg-[var(--option-bg)] px-4 py-2 text-sm font-semibold text-[var(--sea-ink-soft)] transition hover:text-red-600 disabled:opacity-60"
      >
        {pending ? 'Signing out…' : 'Sign out'}
      </button>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Reset tasks (clear current todos, keep history)
// ---------------------------------------------------------------------------

function ResetSection() {
  const router = useRouter()
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [confirmText, setConfirmText] = useState('')
  const [pending, setPending] = useState(false)

  const expectedConfirm = 'reset my tasks'
  const canSubmit =
    confirmText.trim().toLowerCase() === expectedConfirm && !pending

  async function onReset() {
    if (!canSubmit) return
    setPending(true)
    try {
      const result = await resetTasks()
      qc.invalidateQueries()
      await router.invalidate()
      toast.success(
        `Cleared ${result.deactivatedTasks} task${result.deactivatedTasks === 1 ? '' : 's'} and ${result.deletedInstances} pending item${result.deletedInstances === 1 ? '' : 's'}.`,
      )
      setOpen(false)
      setConfirmText('')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Reset failed')
    } finally {
      setPending(false)
    }
  }

  return (
    <section className="max-w-xl rounded-2xl border border-[rgba(230,160,60,0.35)] bg-[rgba(230,160,60,0.05)] p-6">
      <h2 className="mb-2 text-lg font-bold text-amber-700">Reset tasks</h2>
      <p className="mb-4 text-sm text-[var(--sea-ink-soft)]">
        Start over with an empty todo list while keeping every completion in
        your history, XP, streaks, and progression intact.
      </p>
      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded-full border border-[rgba(230,160,60,0.5)] bg-white px-4 py-2 text-sm font-semibold text-amber-700 transition hover:bg-amber-50"
        >
          Reset my tasks
        </button>
      ) : (
        <div className="space-y-3">
          <div className="text-sm text-[var(--sea-ink)]">
            <p className="mb-2 font-semibold">This will:</p>
            <ul className="list-disc space-y-1 pl-5">
              <li>Delete every pending item from today, someday, and upcoming</li>
              <li>Deactivate all current tasks so recurring ones stop generating</li>
            </ul>
            <p className="mt-3 mb-2 font-semibold">This keeps:</p>
            <ul className="list-disc space-y-1 pl-5">
              <li>Every completion in your history and stats</li>
              <li>Your XP, level, streak, and arcade tokens</li>
              <li>Categories, friends, and all other settings</li>
            </ul>
          </div>
          <p className="text-sm text-[var(--sea-ink-soft)]">
            Type{' '}
            <code className="rounded bg-[var(--option-bg)] px-1.5 py-0.5 text-xs font-semibold text-[var(--sea-ink)]">
              {expectedConfirm}
            </code>{' '}
            below to confirm.
          </p>
          <input
            type="text"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder={expectedConfirm}
            autoComplete="off"
            spellCheck={false}
            className="field-input"
          />
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={onReset}
              disabled={!canSubmit}
              className="rounded-full bg-amber-600 px-4 py-2 text-sm font-semibold text-white transition disabled:opacity-40"
            >
              {pending ? 'Resetting…' : 'Reset everything current'}
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false)
                setConfirmText('')
              }}
              disabled={pending}
              className="rounded-full border border-[var(--line)] bg-[var(--option-bg)] px-4 py-2 text-sm font-semibold text-[var(--sea-ink-soft)] disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Danger zone (delete account)
// ---------------------------------------------------------------------------

function DangerZoneSection() {
  const router = useRouter()
  const qc = useQueryClient()
  const { data: session } = useSession()
  const [open, setOpen] = useState(false)
  const [confirmText, setConfirmText] = useState('')
  const [pending, setPending] = useState(false)

  const expectedConfirm = 'delete my account'
  const canSubmit =
    confirmText.trim().toLowerCase() === expectedConfirm && !pending

  async function onDelete() {
    if (!canSubmit) return
    setPending(true)
    try {
      await deleteAccountFn()
      // Clear all client state before bouncing — same hygiene as sign-out
      // so a subsequent sign-up on this device starts from zero.
      try {
        await signOut()
      } catch {
        // signOut may fail with 401 because the session is already gone;
        // safe to ignore.
      }
      qc.removeQueries()
      try {
        localStorage.removeItem('todo-xp-query-cache-v1')
      } catch {
        // no-op if storage is blocked
      }
      toast.success('Account deleted. Sorry to see you go.')
      await router.invalidate()
      router.navigate({ to: '/' })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Delete failed')
      setPending(false)
    }
  }

  return (
    <section className="max-w-xl rounded-2xl border border-[rgba(230,90,90,0.3)] bg-[rgba(230,90,90,0.05)] p-6">
      <h2 className="mb-2 text-lg font-bold text-red-700">Danger zone</h2>
      <p className="mb-4 text-sm text-[var(--sea-ink-soft)]">
        Permanently delete your account, your tasks, your history, and any
        active subscription. This cannot be undone.
      </p>
      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded-full border border-[rgba(230,90,90,0.4)] bg-white px-4 py-2 text-sm font-semibold text-red-700 transition hover:bg-red-50"
        >
          Delete my account
        </button>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-[var(--sea-ink)]">
            This will erase everything tied to{' '}
            <span className="font-semibold">{session?.user?.email ?? 'your account'}</span>:
            tasks, completions, XP, streaks, garden, focus history, friends,
            and membership. If you have an active annual subscription it will
            be canceled in Stripe.
          </p>
          <p className="text-sm text-[var(--sea-ink-soft)]">
            Type <code className="rounded bg-[var(--option-bg)] px-1.5 py-0.5 text-xs font-semibold text-[var(--sea-ink)]">{expectedConfirm}</code> below to confirm.
          </p>
          <input
            type="text"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder={expectedConfirm}
            autoComplete="off"
            spellCheck={false}
            className="w-full rounded border border-[var(--line)] bg-white px-2 py-1.5 text-sm text-[var(--sea-ink)]"
          />
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={onDelete}
              disabled={!canSubmit}
              className="rounded-full bg-red-600 px-4 py-2 text-sm font-semibold text-white transition disabled:opacity-40"
            >
              {pending ? 'Deleting…' : 'Delete forever'}
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false)
                setConfirmText('')
              }}
              disabled={pending}
              className="rounded-full border border-[var(--line)] bg-[var(--option-bg)] px-4 py-2 text-sm font-semibold text-[var(--sea-ink-soft)] disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Push notifications
// ---------------------------------------------------------------------------

function NotificationsSection() {
  const [status, setStatus] = useState<PushSupportStatus>('unknown')
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    currentPushStatus().then((s) => {
      if (!cancelled) setStatus(s)
    })
    return () => {
      cancelled = true
    }
  }, [])

  async function onEnable() {
    setWorking(true)
    setError(null)
    try {
      await enablePushNotifications()
      setStatus('enabled')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to enable')
    } finally {
      setWorking(false)
    }
  }

  async function onDisable() {
    setWorking(true)
    setError(null)
    try {
      await disablePushNotifications()
      setStatus('unknown')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to disable')
    } finally {
      setWorking(false)
    }
  }

  if (status === 'unsupported') {
    return (
      <section className="island-shell max-w-xl rounded-2xl p-6">
        <h2 className="mb-2 text-lg font-bold text-[var(--sea-ink)]">
          Notifications
        </h2>
        <p className="text-sm text-[var(--sea-ink-soft)]">
          This browser doesn't support web push. Open the app on a device or
          browser that does (Chrome / Samsung Internet on Android, or install
          the PWA).
        </p>
      </section>
    )
  }

  const enabled = status === 'enabled'

  return (
    <section className="island-shell max-w-xl rounded-2xl p-6">
      <h2 className="mb-2 text-lg font-bold text-[var(--sea-ink)]">
        Notifications
      </h2>
      <p className="mb-4 text-sm text-[var(--sea-ink-soft)]">
        {enabled
          ? 'Push notifications are on for this device. Reminders will fire at each task\'s due time.'
          : 'Get a push when a task is due. You can turn it off any time.'}
      </p>
      {error ? (
        <p className="mb-3 text-sm text-red-600" role="alert">
          {error}
        </p>
      ) : null}
      {enabled ? (
        <button
          type="button"
          onClick={onDisable}
          disabled={working}
          className="rounded-full border border-[var(--line)] bg-[var(--option-bg)] px-4 py-2 text-sm font-semibold text-[var(--sea-ink-soft)] disabled:opacity-60"
        >
          {working ? 'Turning off…' : 'Turn off'}
        </button>
      ) : (
        <button
          type="button"
          onClick={onEnable}
          disabled={working}
          className="rounded-full border border-[rgba(50,143,151,0.3)] bg-[rgba(79,184,178,0.14)] px-4 py-2 text-sm font-semibold text-[var(--lagoon-deep)] disabled:opacity-60"
        >
          {working ? 'Enabling…' : 'Enable notifications'}
        </button>
      )}

      <QuietHoursSub />
    </section>
  )
}

function QuietHoursSub() {
  const qc = useQueryClient()
  const profileQuery = useQuery({
    queryKey: ['profile'],
    queryFn: () => getProfile(),
  })
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!profileQuery.data) return
    setStart(profileQuery.data.quietHoursStart ?? '')
    setEnd(profileQuery.data.quietHoursEnd ?? '')
  }, [profileQuery.data?.quietHoursStart, profileQuery.data?.quietHoursEnd])

  const save = useMutation({
    mutationFn: (input: { start: string | null; end: string | null }) =>
      updateQuietHours({ data: input }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['profile'] })
      setSaved(true)
      setError(null)
      setTimeout(() => setSaved(false), 2000)
    },
    onError: (err) =>
      setError(err instanceof Error ? err.message : 'Failed to save.'),
  })

  function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    const s = start.trim() || null
    const en = end.trim() || null
    if ((s && !en) || (!s && en)) {
      setError('Set both a start and end time, or leave both blank.')
      return
    }
    save.mutate({ start: s, end: en })
  }

  function onClear() {
    save.mutate({ start: null, end: null })
  }

  const current = profileQuery.data
  const hasWindow = Boolean(current?.quietHoursStart && current?.quietHoursEnd)

  return (
    <form
      onSubmit={onSubmit}
      className="mt-6 space-y-3 border-t border-[var(--line)] pt-5"
    >
      <div>
        <h3 className="text-sm font-semibold text-[var(--sea-ink)]">
          Quiet hours
        </h3>
        <p className="mt-1 text-xs text-[var(--sea-ink-soft)]">
          Nudges for unfinished tasks won’t fire in this window. First-time
          reminders for tasks you’ve scheduled still go through.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm text-[var(--sea-ink-soft)]">
          From
          <input
            type="time"
            value={start}
            onChange={(e) => setStart(e.target.value)}
            className="field-input w-auto"
          />
        </label>
        <label className="flex items-center gap-2 text-sm text-[var(--sea-ink-soft)]">
          until
          <input
            type="time"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
            className="field-input w-auto"
          />
        </label>
      </div>
      {error ? (
        <p className="text-sm text-red-600" role="alert">
          {error}
        </p>
      ) : null}
      {saved ? (
        <p className="text-sm text-[var(--palm)]">Saved.</p>
      ) : null}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={save.isPending}
          className="rounded-full border border-[rgba(50,143,151,0.3)] bg-[rgba(79,184,178,0.14)] px-4 py-2 text-sm font-semibold text-[var(--lagoon-deep)] disabled:opacity-60"
        >
          {save.isPending ? 'Saving…' : 'Save quiet hours'}
        </button>
        {hasWindow ? (
          <button
            type="button"
            onClick={onClear}
            disabled={save.isPending}
            className="rounded-full border border-[var(--line)] bg-[var(--option-bg)] px-4 py-2 text-sm font-semibold text-[var(--sea-ink-soft)] disabled:opacity-60"
          >
            Clear
          </button>
        ) : null}
      </div>
    </form>
  )
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

function ProfileSection({
  user,
}: {
  user:
    | { id: string; name: string; email: string; [k: string]: unknown }
    | undefined
}) {
  const qc = useQueryClient()
  const profileQuery = useQuery({
    queryKey: ['profile'],
    queryFn: () => getProfile(),
  })
  const [name, setName] = useState('')
  const [handle, setHandle] = useState('')
  const [bio, setBio] = useState('')
  const [savedField, setSavedField] = useState<
    null | 'name' | 'handle' | 'bio'
  >(null)
  const [nameError, setNameError] = useState<string | null>(null)
  const [handleError, setHandleError] = useState<string | null>(null)
  const [bioError, setBioError] = useState<string | null>(null)
  const [pendingName, setPendingName] = useState(false)
  const [pendingHandle, setPendingHandle] = useState(false)
  const [pendingBio, setPendingBio] = useState(false)

  useEffect(() => {
    if (user?.name) setName(user.name)
  }, [user?.id, user?.name])
  useEffect(() => {
    if (profileQuery.data?.handle) setHandle(profileQuery.data.handle)
  }, [profileQuery.data?.handle])
  useEffect(() => {
    if (typeof profileQuery.data?.bio === 'string') {
      setBio(profileQuery.data.bio)
    }
  }, [profileQuery.data?.bio])

  async function onSaveName(e: React.FormEvent) {
    e.preventDefault()
    if (!user) return
    setNameError(null)
    setSavedField(null)
    setPendingName(true)
    try {
      const { error: err } = await authClient.updateUser({ name })
      if (err) throw new Error(err.message ?? 'Failed to update name')
      setSavedField('name')
      setTimeout(() => setSavedField(null), 2000)
    } catch (e) {
      setNameError(e instanceof Error ? e.message : 'Failed to update name')
    } finally {
      setPendingName(false)
    }
  }

  async function onSaveHandle(e: React.FormEvent) {
    e.preventDefault()
    setHandleError(null)
    setSavedField(null)
    setPendingHandle(true)
    try {
      await updateHandle({ data: { handle } })
      qc.invalidateQueries({ queryKey: ['profile'] })
      setSavedField('handle')
      setTimeout(() => setSavedField(null), 2000)
    } catch (e) {
      setHandleError(e instanceof Error ? e.message : 'Failed to update handle')
    } finally {
      setPendingHandle(false)
    }
  }

  async function onSaveBio(e: React.FormEvent) {
    e.preventDefault()
    setBioError(null)
    setSavedField(null)
    setPendingBio(true)
    try {
      await updatePrefs({ data: { bio } })
      qc.invalidateQueries({ queryKey: ['profile'] })
      setSavedField('bio')
      setTimeout(() => setSavedField(null), 2000)
    } catch (e) {
      setBioError(e instanceof Error ? e.message : 'Failed to save bio')
    } finally {
      setPendingBio(false)
    }
  }

  const tz =
    (user && (user as { timezone?: string }).timezone) ||
    Intl.DateTimeFormat().resolvedOptions().timeZone

  return (
    <section className="island-shell max-w-xl rounded-2xl p-6">
      <h2 className="mb-1 text-lg font-bold text-[var(--sea-ink)]">Profile</h2>
      <dl className="mb-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm text-[var(--sea-ink-soft)]">
        <dt className="font-semibold">Email</dt>
        <dd className="truncate text-[var(--sea-ink)]">{user?.email ?? '—'}</dd>
        <dt className="font-semibold">Timezone</dt>
        <dd className="text-[var(--sea-ink)]">{tz}</dd>
      </dl>
      <form onSubmit={onSaveName} className="mb-4 space-y-3">
        <label className="block">
          <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-[var(--kicker)]">
            Display name
          </span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="field-input"
          />
        </label>
        {nameError ? (
          <p className="text-sm text-red-600" role="alert">
            {nameError}
          </p>
        ) : null}
        {savedField === 'name' ? (
          <p className="text-sm text-[var(--palm)]">Saved.</p>
        ) : null}
        <button
          type="submit"
          disabled={pendingName || !user || name === user?.name}
          className="rounded-full border border-[rgba(50,143,151,0.3)] bg-[rgba(79,184,178,0.14)] px-4 py-2 text-sm font-semibold text-[var(--lagoon-deep)] disabled:opacity-60"
        >
          {pendingName ? 'Saving…' : 'Save name'}
        </button>
      </form>
      <form onSubmit={onSaveHandle} className="space-y-3">
        <label className="block">
          <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-[var(--kicker)]">
            Handle
          </span>
          <div className="flex items-center gap-2">
            <span className="text-[var(--sea-ink-soft)]">@</span>
            <input
              type="text"
              value={handle}
              onChange={(e) => setHandle(e.target.value.toLowerCase())}
              minLength={3}
              maxLength={20}
              pattern="[a-z0-9_]{3,20}"
              className="field-input"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <span className="mt-1 block text-xs text-[var(--sea-ink-soft)]">
            3–20 characters. Lowercase letters, numbers, underscores.
          </span>
        </label>
        {handleError ? (
          <p className="text-sm text-red-600" role="alert">
            {handleError}
          </p>
        ) : null}
        {savedField === 'handle' ? (
          <p className="text-sm text-[var(--palm)]">Saved.</p>
        ) : null}
        <button
          type="submit"
          disabled={
            pendingHandle ||
            !handle ||
            handle === profileQuery.data?.handle ||
            profileQuery.isLoading
          }
          className="rounded-full border border-[rgba(50,143,151,0.3)] bg-[rgba(79,184,178,0.14)] px-4 py-2 text-sm font-semibold text-[var(--lagoon-deep)] disabled:opacity-60"
        >
          {pendingHandle ? 'Saving…' : 'Save handle'}
        </button>
      </form>
      <form onSubmit={onSaveBio} className="mt-4 space-y-3">
        <label className="block">
          <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-[var(--kicker)]">
            About you (for the coach)
          </span>
          <textarea
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            rows={3}
            maxLength={500}
            placeholder="A few sentences about what you do, what's going on in your life, what kinds of nudges work for you. Optional."
            className="field-input"
          />
          <span className="mt-1 flex items-center justify-between text-xs text-[var(--sea-ink-soft)]">
            <span>Private. Only the coach sees this.</span>
            <span aria-live="polite">{bio.length} / 500</span>
          </span>
        </label>
        {bioError ? (
          <p className="text-sm text-red-600" role="alert">
            {bioError}
          </p>
        ) : null}
        {savedField === 'bio' ? (
          <p className="text-sm text-[var(--palm)]">Saved.</p>
        ) : null}
        <button
          type="submit"
          disabled={
            pendingBio ||
            profileQuery.isLoading ||
            bio === (profileQuery.data?.bio ?? '')
          }
          className="rounded-full border border-[rgba(50,143,151,0.3)] bg-[rgba(79,184,178,0.14)] px-4 py-2 text-sm font-semibold text-[var(--lagoon-deep)] disabled:opacity-60"
        >
          {pendingBio ? 'Saving…' : 'Save bio'}
        </button>
      </form>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Privacy
// ---------------------------------------------------------------------------

const VISIBILITY_OPTIONS = [
  {
    value: 'public',
    label: 'Public',
    hint: 'Anyone signed in can view your profile and global leaderboard.',
  },
  {
    value: 'friends',
    label: 'Friends only',
    hint: 'Only accepted friends can see your profile and activity.',
  },
  {
    value: 'private',
    label: 'Private',
    hint: 'Hidden from leaderboards. Friends still see your name.',
  },
] as const

const GARDEN_VISIBILITY_OPTIONS = [
  {
    value: 'public',
    label: 'Public',
    hint: 'Your garden appears in the Global community garden for anyone.',
  },
  {
    value: 'friends',
    label: 'Friends only',
    hint: 'Only accepted friends see your garden in the Community tab.',
  },
  {
    value: 'private',
    label: 'Private',
    hint: 'Nobody sees your garden. You still see it in the Yours tab.',
  },
] as const

function PrivacySection() {
  const qc = useQueryClient()
  const profileQuery = useQuery({
    queryKey: ['profile'],
    queryFn: () => getProfile(),
  })

  const setVisibility = useMutation({
    mutationFn: (visibility: string) =>
      updateProfileVisibility({ data: { visibility } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['profile'] }),
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : 'Update failed'),
  })

  const setGardenVisibility = useMutation({
    mutationFn: (visibility: string) =>
      updateGardenVisibility({ data: { visibility } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['profile'] }),
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : 'Update failed'),
  })

  const setPref = useMutation({
    mutationFn: (patch: {
      shareProgression?: boolean
      shareActivity?: boolean
      shareTaskTitles?: boolean
      mergeHouseholdIntoToday?: boolean
    }) => updatePrefs({ data: patch }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['profile'] })
      qc.invalidateQueries({ queryKey: ['today'] })
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : 'Update failed'),
  })

  const p = profileQuery.data

  return (
    <section className="island-shell max-w-xl rounded-2xl p-6">
      <h2 className="mb-1 text-lg font-bold text-[var(--sea-ink)]">Privacy</h2>
      <p className="mb-4 text-sm text-[var(--sea-ink-soft)]">
        Control who can find your profile and what friends see.
      </p>

      <fieldset className="mb-5">
        <legend className="mb-2 block text-xs font-semibold uppercase tracking-wide text-[var(--kicker)]">
          Profile visibility
        </legend>
        <div className="space-y-2">
          {VISIBILITY_OPTIONS.map((opt) => {
            const checked = p?.profileVisibility === opt.value
            return (
              <label
                key={opt.value}
                className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 ${
                  checked
                    ? 'border-[var(--lagoon-deep)] bg-[rgba(79,184,178,0.1)]'
                    : 'border-[var(--line)] bg-[var(--option-bg)]'
                }`}
              >
                <input
                  type="radio"
                  name="profile-visibility"
                  value={opt.value}
                  checked={checked}
                  onChange={() => setVisibility.mutate(opt.value)}
                  className="mt-1"
                />
                <span className="flex-1">
                  <span className="block text-sm font-semibold text-[var(--sea-ink)]">
                    {opt.label}
                  </span>
                  <span className="block text-xs text-[var(--sea-ink-soft)]">
                    {opt.hint}
                  </span>
                </span>
              </label>
            )
          })}
        </div>
      </fieldset>

      <fieldset className="mb-5">
        <legend className="mb-2 block text-xs font-semibold uppercase tracking-wide text-[var(--kicker)]">
          Garden visibility
        </legend>
        <p className="mb-2 text-xs text-[var(--sea-ink-soft)]">
          Separate from profile visibility — share your garden publicly even
          if the rest of your profile is friends-only.
        </p>
        <div className="space-y-2">
          {GARDEN_VISIBILITY_OPTIONS.map((opt) => {
            const checked = p?.gardenVisibility === opt.value
            return (
              <label
                key={opt.value}
                className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 ${
                  checked
                    ? 'border-[var(--lagoon-deep)] bg-[rgba(79,184,178,0.1)]'
                    : 'border-[var(--line)] bg-[var(--option-bg)]'
                }`}
              >
                <input
                  type="radio"
                  name="garden-visibility"
                  value={opt.value}
                  checked={checked}
                  onChange={() => setGardenVisibility.mutate(opt.value)}
                  className="mt-1"
                />
                <span className="flex-1">
                  <span className="block text-sm font-semibold text-[var(--sea-ink)]">
                    {opt.label}
                  </span>
                  <span className="block text-xs text-[var(--sea-ink-soft)]">
                    {opt.hint}
                  </span>
                </span>
              </label>
            )
          })}
        </div>
      </fieldset>

      <fieldset className="mb-5">
        <legend className="mb-2 block text-xs font-semibold uppercase tracking-wide text-[var(--kicker)]">
          Friend sharing
        </legend>
        <div className="space-y-2">
          <PrefToggle
            label="Share level, XP, and streaks"
            hint="Appears in the friends leaderboard."
            checked={p?.shareProgression ?? true}
            onChange={(v) => setPref.mutate({ shareProgression: v })}
          />
          <PrefToggle
            label="Share task completions"
            hint="Shows up in the activity feed when you finish a task."
            checked={p?.shareActivity ?? true}
            onChange={(v) => setPref.mutate({ shareActivity: v })}
          />
          <PrefToggle
            label="Show task titles"
            hint="Otherwise activity just says “completed a task.”"
            checked={p?.shareTaskTitles ?? false}
            onChange={(v) => setPref.mutate({ shareTaskTitles: v })}
          />
        </div>
      </fieldset>

      <fieldset>
        <legend className="mb-2 block text-xs font-semibold uppercase tracking-wide text-[var(--kicker)]">
          Household
        </legend>
        <div className="space-y-2">
          <PrefToggle
            label="Show household chores in Today"
            hint="When on, chores assigned to you and free-for-all household chores appear in your Today view. When off, they live only in the Household tab."
            checked={p?.mergeHouseholdIntoToday ?? true}
            onChange={(v) => setPref.mutate({ mergeHouseholdIntoToday: v })}
          />
        </div>
      </fieldset>
    </section>
  )
}

function PrefToggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string
  hint: string
  checked: boolean
  onChange: (next: boolean) => void
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-[var(--line)] bg-[var(--option-bg)] p-3">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-1"
      />
      <span className="flex-1">
        <span className="block text-sm font-semibold text-[var(--sea-ink)]">
          {label}
        </span>
        <span className="block text-xs text-[var(--sea-ink-soft)]">{hint}</span>
      </span>
    </label>
  )
}

// ---------------------------------------------------------------------------
// Household
// ---------------------------------------------------------------------------

function HouseholdSection() {
  const qc = useQueryClient()
  // refetchOnMount: 'always' to bypass any stale persisted value for this
  // query — otherwise a cached `null` would show the create form for a
  // user who is actually in a household.
  const myQuery = useQuery({
    queryKey: ['my-household'],
    queryFn: () => getMyHouseholdFn(),
    refetchOnMount: 'always',
  })
  // Household creation is paywalled to the admin — joining is free.
  // Show an upsell instead of the create form when the viewer isn't
  // already in a household and isn't a paid member.
  const memberQuery = useQuery({
    queryKey: ['member-status'],
    queryFn: () => getMemberStatusFn(),
  })
  const isMember = memberQuery.data?.isMember === true
  const [name, setName] = useState('')
  const create = useMutation({
    mutationFn: (n: string) => createHouseholdFn({ data: { name: n } }),
    onSuccess: () => {
      toast.success('Household created.')
      setName('')
      qc.invalidateQueries({ queryKey: ['my-household'] })
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : 'Failed to create.'),
  })
  const [confirmName, setConfirmName] = useState('')
  const deleteHousehold = useMutation({
    mutationFn: (householdId: string) =>
      deleteHouseholdFn({ data: { householdId } }),
    onSuccess: () => {
      toast.success('Household deleted.')
      setConfirmName('')
      qc.invalidateQueries({ queryKey: ['my-household'] })
      qc.invalidateQueries({ queryKey: ['household-chores'] })
      qc.invalidateQueries({ queryKey: ['today'] })
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : 'Failed to delete.'),
  })

  return (
    <section className="island-shell max-w-xl rounded-2xl p-6">
      <h2 className="mb-1 text-lg font-bold text-[var(--sea-ink)]">
        Household
      </h2>
      <p className="mb-4 text-sm text-[var(--sea-ink-soft)]">
        Share chores with family or roommates. XP for a household chore goes
        to whoever completes it.
      </p>

      {myQuery.isLoading ? (
        <p className="text-sm text-[var(--sea-ink-soft)]">Loading…</p>
      ) : myQuery.data?.household ? (
        (() => {
          const hh = myQuery.data.household
          const role = myQuery.data.role
          return (
            <div className="space-y-4">
              <p className="text-sm text-[var(--sea-ink)]">
                You&rsquo;re in <strong>{hh.name}</strong> as{' '}
                <span className="font-semibold">{role}</span>.
              </p>
              <Link
                to="/household"
                className="inline-block rounded-full border border-[rgba(50,143,151,0.3)] bg-[rgba(79,184,178,0.14)] px-4 py-2 text-sm font-semibold text-[var(--lagoon-deep)] no-underline"
              >
                Open household
              </Link>
              {role === 'admin' && (
                <div className="rounded-xl border border-red-300/60 bg-red-50/40 p-4 dark:border-red-500/40 dark:bg-red-900/10">
                  <h3 className="text-sm font-semibold text-red-700 dark:text-red-300">
                    Delete household
                  </h3>
                  <p className="mt-1 text-xs text-[var(--sea-ink-soft)]">
                    Removes all members and household chores (members&rsquo;
                    personal tasks are unaffected). To confirm, type the
                    household name below:{' '}
                    <strong className="text-[var(--sea-ink)]">{hh.name}</strong>
                  </p>
                  <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                    <input
                      type="text"
                      value={confirmName}
                      onChange={(e) => setConfirmName(e.target.value)}
                      placeholder="Type the household name"
                      className="field-input flex-1"
                      autoComplete="off"
                    />
                    <button
                      type="button"
                      disabled={
                        deleteHousehold.isPending ||
                        confirmName.trim() !== hh.name
                      }
                      onClick={() => deleteHousehold.mutate(hh.id)}
                      className="rounded-full border border-[rgba(230,90,90,0.4)] bg-white px-4 py-2 text-sm font-semibold text-red-700 transition hover:bg-red-50 disabled:opacity-50 dark:bg-transparent dark:hover:bg-red-900/20"
                    >
                      {deleteHousehold.isPending ? 'Deleting…' : 'Delete'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )
        })()
      ) : isMember ? (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (!name.trim()) return
            create.mutate(name.trim())
          }}
          className="flex flex-col gap-3 sm:flex-row"
        >
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. The Smiths"
            maxLength={80}
            className="field-input flex-1"
          />
          <button
            type="submit"
            disabled={create.isPending || !name.trim()}
            className="rounded-full border border-[rgba(50,143,151,0.3)] bg-[rgba(79,184,178,0.14)] px-4 py-2 text-sm font-semibold text-[var(--lagoon-deep)] disabled:opacity-50"
          >
            {create.isPending ? 'Creating…' : 'Create household'}
          </button>
        </form>
      ) : (
        <div className="rounded-xl border border-[var(--lagoon-deep)] bg-[rgba(79,184,178,0.08)] p-4">
          <p className="text-sm font-semibold text-[var(--sea-ink)]">
            Households are a membership feature.
          </p>
          <p className="mt-1 text-xs text-[var(--sea-ink-soft)]">
            Sharing chores with family or roommates needs a Todo XP
            membership. Only the household admin (that&rsquo;s you)
            needs to subscribe — kids, members, and kiosk accounts you
            add to the household join for free.
          </p>
          <p className="mt-3 text-xs text-[var(--sea-ink-soft)]">
            Scroll up to <strong>Membership</strong> to upgrade.
          </p>
        </div>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Password
// ---------------------------------------------------------------------------

function PasswordSection() {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [pending, setPending] = useState(false)

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setSaved(false)
    if (next.length < 8) {
      setError('New password must be at least 8 characters.')
      return
    }
    if (next !== confirm) {
      setError("New passwords don't match.")
      return
    }
    setPending(true)
    try {
      const { error: err } = await authClient.changePassword({
        currentPassword: current,
        newPassword: next,
        revokeOtherSessions: false,
      })
      if (err) throw new Error(err.message ?? 'Failed to change password')
      setCurrent('')
      setNext('')
      setConfirm('')
      setSaved(true)
      setTimeout(() => setSaved(false), 2500)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to change password')
    } finally {
      setPending(false)
    }
  }

  return (
    <section className="island-shell max-w-xl rounded-2xl p-6">
      <h2 className="mb-3 text-lg font-bold text-[var(--sea-ink)]">
        Change password
      </h2>
      <form onSubmit={onSubmit} className="space-y-3">
        <label className="block">
          <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-[var(--kicker)]">
            Current password
          </span>
          <input
            type="password"
            required
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            className="field-input"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-[var(--kicker)]">
            New password
          </span>
          <input
            type="password"
            required
            autoComplete="new-password"
            minLength={8}
            value={next}
            onChange={(e) => setNext(e.target.value)}
            className="field-input"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-[var(--kicker)]">
            Confirm new password
          </span>
          <input
            type="password"
            required
            autoComplete="new-password"
            minLength={8}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            className="field-input"
          />
        </label>
        {error ? (
          <p className="text-sm text-red-600" role="alert">
            {error}
          </p>
        ) : null}
        {saved ? (
          <p className="text-sm text-[var(--palm)]">Password updated.</p>
        ) : null}
        <button
          type="submit"
          disabled={pending}
          className="rounded-full border border-[rgba(50,143,151,0.3)] bg-[rgba(79,184,178,0.14)] px-4 py-2 text-sm font-semibold text-[var(--lagoon-deep)] disabled:opacity-60"
        >
          {pending ? 'Updating…' : 'Change password'}
        </button>
      </form>
    </section>
  )
}

// ---------------------------------------------------------------------------
// GitHub integration
// ---------------------------------------------------------------------------

const GITHUB_POLL_OPTIONS = [1, 5, 15, 30, 60] as const

function GithubSection() {
  const qc = useQueryClient()
  const statusQuery = useQuery({
    queryKey: ['github-integration'],
    queryFn: () => getGithubIntegration(),
  })

  const [token, setToken] = useState('')
  const [pollInterval, setPollInterval] = useState<number>(5)
  const [formError, setFormError] = useState<string | null>(null)
  const [showInstructions, setShowInstructions] = useState(false)

  useEffect(() => {
    if (statusQuery.data?.pollIntervalMinutes) {
      setPollInterval(statusQuery.data.pollIntervalMinutes)
    }
  }, [statusQuery.data?.pollIntervalMinutes])

  const connect = useMutation({
    mutationFn: (input: { token: string; pollIntervalMinutes: number }) =>
      upsertGithubIntegration({ data: input }),
    onSuccess: () => {
      setToken('')
      setFormError(null)
      qc.invalidateQueries({ queryKey: ['github-integration'] })
      toast.success('GitHub connected.')
    },
    onError: (err) =>
      setFormError(err instanceof Error ? err.message : 'Connect failed.'),
  })

  const updateInterval = useMutation({
    mutationFn: (minutes: number) =>
      updateGithubPollInterval({ data: { pollIntervalMinutes: minutes } }),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ['github-integration'] }),
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : 'Update failed.'),
  })

  const updateSyncOptions = useMutation({
    mutationFn: (opts: {
      trackReviewRequested: boolean
      trackAssigned: boolean
    }) => updateGithubSyncOptions({ data: opts }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['github-integration'] }),
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : 'Update failed.'),
  })

  const disconnect = useMutation({
    mutationFn: () => removeGithubIntegration(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['github-integration'] })
      toast.message('GitHub disconnected.')
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : 'Disconnect failed.'),
  })

  const syncNow = useMutation({
    mutationFn: () => syncGithubNow(),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['github-integration'] })
      qc.invalidateQueries({ queryKey: ['today'] })
      qc.invalidateQueries({ queryKey: ['tasks'] })
      if (res.errors.length > 0) {
        toast.error(res.errors[0])
        return
      }
      const parts: string[] = []
      if (res.created > 0) parts.push(`${res.created} new`)
      if (res.completed > 0) parts.push(`${res.completed} auto-completed`)
      toast.success(parts.length > 0 ? `Synced: ${parts.join(', ')}.` : 'Up to date.')
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : 'Sync failed.'),
  })

  const status = statusQuery.data
  const connected = Boolean(status?.connected)

  function onConnect(e: React.FormEvent) {
    e.preventDefault()
    setFormError(null)
    const t = token.trim()
    if (!t) {
      setFormError('Token is required.')
      return
    }
    connect.mutate({ token: t, pollIntervalMinutes: pollInterval })
  }

  return (
    <details className="island-shell max-w-xl rounded-2xl [&[open]>summary_[data-chevron]]:rotate-90">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-5">
        <div className="min-w-0">
          <h2 className="text-lg font-bold text-[var(--sea-ink)]">
            GitHub reviews
          </h2>
          <p className="text-sm text-[var(--sea-ink-soft)]">
            {connected
              ? `Connected as @${status?.externalId ?? '…'}. PRs you're asked to review or are assigned to become tasks automatically — choose which below.`
              : 'Connect a GitHub token so PRs you need to review or are assigned to show up as tasks.'}
          </p>
        </div>
        <span
          data-chevron
          aria-hidden
          className="flex-shrink-0 text-[var(--sea-ink-soft)] transition-transform"
        >
          ▸
        </span>
      </summary>

      <div className="space-y-4 border-t border-[var(--line)] p-5">
        {connected ? (
          <div className="space-y-4">
            {(() => {
              const expiresAt = status?.tokenExpiresAt
                ? new Date(status.tokenExpiresAt)
                : null
              const err = status?.lastPollError ?? null
              const authErr = err?.startsWith('AUTH: ') ?? false
              const expired = expiresAt ? expiresAt.getTime() <= Date.now() : false
              const msUntil = expiresAt ? expiresAt.getTime() - Date.now() : null
              const expiringSoon =
                msUntil !== null && msUntil > 0 && msUntil <= 5 * 24 * 60 * 60 * 1000
              if (authErr || expired) {
                return (
                  <div className="rounded-xl border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-700">
                    <strong>Token invalid.</strong> GitHub rejected the current
                    token — polling is paused until you reconnect. Paste a
                    fresh token below.
                  </div>
                )
              }
              if (expiringSoon) {
                return (
                  <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-800">
                    <strong>Token expires soon.</strong> In{' '}
                    {Math.max(1, Math.ceil(msUntil! / (24 * 60 * 60 * 1000)))}{' '}
                    day(s). Generate a new one and paste it here to avoid a
                    gap.
                  </div>
                )
              }
              return null
            })()}
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm text-[var(--sea-ink-soft)]">
              <dt className="font-semibold">Account</dt>
              <dd className="text-[var(--sea-ink)]">@{status?.externalId}</dd>
              <dt className="font-semibold">Last poll</dt>
              <dd className="text-[var(--sea-ink)]">
                {status?.lastPolledAt
                  ? timeAgo(status.lastPolledAt)
                  : 'not yet'}
              </dd>
              <dt className="font-semibold">Token expires</dt>
              <dd className="text-[var(--sea-ink)]">
                {status?.tokenExpiresAt
                  ? new Date(status.tokenExpiresAt).toLocaleDateString()
                  : 'no expiration'}
              </dd>
              {status?.lastPollError ? (
                <>
                  <dt className="font-semibold text-red-600">Last error</dt>
                  <dd className="break-words text-red-600">
                    {status.lastPollError.replace(/^AUTH: /, '')}
                  </dd>
                </>
              ) : null}
            </dl>

            {(() => {
              const reviewOn = status?.trackReviewRequested ?? true
              const assignedOn = status?.trackAssigned ?? true
              // Don't let the user clear the last enabled flow — there'd be
              // nothing left to sync. The server enforces this too.
              const setFlows = (review: boolean, assigned: boolean) => {
                if (!review && !assigned) {
                  toast.error('Keep at least one option enabled.')
                  return
                }
                updateSyncOptions.mutate({
                  trackReviewRequested: review,
                  trackAssigned: assigned,
                })
              }
              return (
                <fieldset className="space-y-2">
                  <legend className="mb-1 block text-xs font-semibold uppercase tracking-wide text-[var(--kicker)]">
                    Create tasks for
                  </legend>
                  <label className="flex items-center gap-2 text-sm text-[var(--sea-ink)]">
                    <input
                      type="checkbox"
                      checked={reviewOn}
                      disabled={updateSyncOptions.isPending}
                      onChange={(e) => setFlows(e.target.checked, assignedOn)}
                    />
                    PRs where I'm requested as a reviewer
                  </label>
                  <label className="flex items-center gap-2 text-sm text-[var(--sea-ink)]">
                    <input
                      type="checkbox"
                      checked={assignedOn}
                      disabled={updateSyncOptions.isPending}
                      onChange={(e) => setFlows(reviewOn, e.target.checked)}
                    />
                    PRs assigned to me
                  </label>
                </fieldset>
              )
            })()}

            <label className="block">
              <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-[var(--kicker)]">
                Check for new reviews every
              </span>
              <select
                value={pollInterval}
                onChange={(e) => {
                  const next = Number(e.target.value)
                  setPollInterval(next)
                  updateInterval.mutate(next)
                }}
                disabled={updateInterval.isPending}
                className="field-input w-auto"
              >
                {GITHUB_POLL_OPTIONS.map((n) => (
                  <option key={n} value={n}>
                    {n === 1 ? '1 minute' : `${n} minutes`}
                  </option>
                ))}
              </select>
            </label>

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => syncNow.mutate()}
                disabled={syncNow.isPending}
                className="rounded-full border border-[rgba(50,143,151,0.3)] bg-[rgba(79,184,178,0.14)] px-4 py-2 text-sm font-semibold text-[var(--lagoon-deep)] disabled:opacity-60"
              >
                {syncNow.isPending ? 'Syncing…' : 'Sync now'}
              </button>
              <button
                type="button"
                onClick={() => {
                  if (confirm('Disconnect GitHub? Existing review tasks will remain.')) {
                    disconnect.mutate()
                  }
                }}
                disabled={disconnect.isPending}
                className="rounded-full border border-[var(--line)] bg-[var(--option-bg)] px-4 py-2 text-sm font-semibold text-[var(--sea-ink-soft)] transition hover:text-red-600 disabled:opacity-60"
              >
                Disconnect
              </button>
            </div>

            <form
              onSubmit={onConnect}
              className="space-y-2 border-t border-[var(--line)] pt-4"
            >
              <label className="block">
                <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-[var(--kicker)]">
                  Replace token
                </span>
                <input
                  type="password"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="ghp_…"
                  autoComplete="off"
                  spellCheck={false}
                  className="field-input"
                />
              </label>
              {formError ? (
                <p className="text-sm text-red-600" role="alert">
                  {formError}
                </p>
              ) : null}
              <button
                type="submit"
                disabled={connect.isPending || !token.trim()}
                className="rounded-full border border-[rgba(50,143,151,0.3)] bg-[rgba(79,184,178,0.14)] px-4 py-2 text-sm font-semibold text-[var(--lagoon-deep)] disabled:opacity-60"
              >
                {connect.isPending ? 'Updating…' : 'Save new token'}
              </button>
            </form>
          </div>
        ) : (
          <form onSubmit={onConnect} className="space-y-3">
            <label className="block">
              <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-[var(--kicker)]">
                Personal access token
              </span>
              <input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="ghp_…"
                autoComplete="off"
                spellCheck={false}
                className="field-input"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-[var(--kicker)]">
                Check for new reviews every
              </span>
              <select
                value={pollInterval}
                onChange={(e) => setPollInterval(Number(e.target.value))}
                className="field-input w-auto"
              >
                {GITHUB_POLL_OPTIONS.map((n) => (
                  <option key={n} value={n}>
                    {n === 1 ? '1 minute' : `${n} minutes`}
                  </option>
                ))}
              </select>
            </label>
            {formError ? (
              <p className="text-sm text-red-600" role="alert">
                {formError}
              </p>
            ) : null}
            <button
              type="submit"
              disabled={connect.isPending}
              className="rounded-full border border-[rgba(50,143,151,0.3)] bg-[rgba(79,184,178,0.14)] px-4 py-2 text-sm font-semibold text-[var(--lagoon-deep)] disabled:opacity-60"
            >
              {connect.isPending ? 'Connecting…' : 'Connect'}
            </button>
          </form>
        )}

        <div className="rounded-xl border border-[var(--line)] bg-[var(--option-bg)] p-4">
          <button
            type="button"
            onClick={() => setShowInstructions((v) => !v)}
            className="flex w-full items-center justify-between gap-2 text-left text-sm font-semibold text-[var(--sea-ink)]"
          >
            <span>How to create a classic token</span>
            <span aria-hidden className="text-[var(--sea-ink-soft)]">
              {showInstructions ? '▾' : '▸'}
            </span>
          </button>
          {showInstructions ? (
            <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm text-[var(--sea-ink-soft)]">
              <li>
                Open{' '}
                <a
                  href="https://github.com/settings/tokens/new"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[var(--lagoon-deep)] underline"
                >
                  github.com/settings/tokens/new
                </a>{' '}
                (Settings → Developer settings → Personal access tokens →
                Tokens (classic)).
              </li>
              <li>
                Note: <code>todo-gameification</code> (or anything you'll
                recognize later).
              </li>
              <li>
                Expiration: pick whatever you're comfortable re-generating
                — 90 days is a good default.
              </li>
              <li>
                <span className="font-semibold text-[var(--sea-ink)]">
                  Select scopes
                </span>{' '}
                — check:
                <ul className="mt-1 list-disc space-y-0.5 pl-5">
                  <li>
                    <code>repo</code> — required for private-repo and org PRs
                  </li>
                  <li>
                    <code>read:org</code> — optional, only needed if your
                    org uses team-based review requests
                  </li>
                </ul>
              </li>
              <li>
                Click <strong>Generate token</strong> and copy the{' '}
                <code>ghp_…</code> value immediately — GitHub only shows
                it once.
              </li>
              <li>
                If your org requires SSO, click <strong>Configure SSO</strong>{' '}
                next to the token on the tokens page and authorize it for
                that org — otherwise API calls return empty results.
              </li>
              <li>Paste it above and hit Connect.</li>
            </ol>
          ) : null}
        </div>
      </div>
    </details>
  )
}

// ---------------------------------------------------------------------------
// API tokens
// ---------------------------------------------------------------------------

type TokenRow = Awaited<ReturnType<typeof listApiTokens>>[number]
type CreatedToken = Awaited<ReturnType<typeof createApiToken>>

function TokensSection() {
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [created, setCreated] = useState<CreatedToken | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const tokensQuery = useQuery({
    queryKey: ['api-tokens'],
    queryFn: () => listApiTokens(),
  })

  const create = useMutation({
    mutationFn: (n: string) => createApiToken({ data: { name: n } }),
    onSuccess: (token) => {
      setCreated(token)
      setName('')
      qc.invalidateQueries({ queryKey: ['api-tokens'] })
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : 'Failed to create token')
    },
  })

  const revoke = useMutation({
    mutationFn: (tokenId: string) =>
      revokeApiToken({ data: { tokenId } }),
    onMutate: async (tokenId) => {
      await qc.cancelQueries({ queryKey: ['api-tokens'] })
      const prev = qc.getQueryData<TokenRow[]>(['api-tokens'])
      qc.setQueryData<TokenRow[]>(['api-tokens'], (old) =>
        old?.filter((t) => t.id !== tokenId),
      )
      return { prev }
    },
    onError: (_err, _id, ctx) => {
      if (ctx?.prev) qc.setQueryData(['api-tokens'], ctx.prev)
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['api-tokens'] }),
  })

  function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (!name.trim()) {
      setError('Name is required')
      return
    }
    create.mutate(name.trim())
  }

  async function onCopy() {
    if (!created?.plaintext) return
    try {
      await navigator.clipboard.writeText(created.plaintext)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // ignore
    }
  }

  const tokens = Array.isArray(tokensQuery.data) ? tokensQuery.data : []

  return (
    <details className="island-shell max-w-xl rounded-2xl [&[open]>summary_[data-chevron]]:rotate-90">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-5">
        <div className="min-w-0">
          <h2 className="text-lg font-bold text-[var(--sea-ink)]">API access</h2>
          <p className="text-sm text-[var(--sea-ink-soft)]">
            {tokens.length === 0
              ? 'No tokens yet.'
              : `${tokens.length} active token${tokens.length === 1 ? '' : 's'}.`}{' '}
            Tokens work for REST, MCP, and Home Assistant.
          </p>
        </div>
        <span
          data-chevron
          aria-hidden
          className="flex-shrink-0 text-[var(--sea-ink-soft)] transition-transform"
        >
          ▸
        </span>
      </summary>

      <div className="space-y-4 border-t border-[var(--line)] p-5">
        <nav className="grid gap-2 sm:grid-cols-3">
          <DocLink
            to="/settings/api-docs"
            label="REST API"
            detail="Endpoints, request & response shapes."
          />
          <DocLink
            to="/settings/mcp"
            label="MCP (for LLMs)"
            detail="Claude Desktop config + tool inventory."
          />
          <DocLink
            to="/settings/home-assistant"
            label="Home Assistant"
            detail="Copy-paste sensor & command YAML."
          />
        </nav>

      <div className="island-shell rounded-2xl p-5">
        <h3 className="mb-3 text-sm font-semibold text-[var(--sea-ink)]">
          Create token
        </h3>
        <form onSubmit={onSubmit} className="space-y-3">
          <label className="block">
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-[var(--kicker)]">
              Name
            </span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Home Assistant"
              maxLength={80}
              className="field-input"
            />
          </label>
          {error ? (
            <p className="text-sm text-red-600" role="alert">
              {error}
            </p>
          ) : null}
          <button
            type="submit"
            disabled={create.isPending}
            className="rounded-full border border-[rgba(50,143,151,0.3)] bg-[rgba(79,184,178,0.14)] px-4 py-2 text-sm font-semibold text-[var(--lagoon-deep)] disabled:opacity-60"
          >
            {create.isPending ? 'Creating…' : 'Create token'}
          </button>
        </form>

        {created ? (
          <div className="mt-4 rounded-xl border border-[var(--lagoon-deep)] bg-[rgba(79,184,178,0.1)] p-4 text-sm">
            <p className="mb-2 font-semibold text-[var(--sea-ink)]">
              Copy this token now. You won't see it again.
            </p>
            <div className="mb-3 flex items-center gap-2">
              <code className="flex-1 break-all rounded-md border border-[var(--line)] bg-[var(--surface-strong)] p-2 font-mono text-xs text-[var(--sea-ink)]">
                {created.plaintext}
              </code>
              <button
                type="button"
                onClick={onCopy}
                className="rounded-full border border-[var(--line)] bg-[var(--option-bg)] px-3 py-1 text-xs font-semibold text-[var(--sea-ink)]"
              >
                {copied ? 'Copied!' : 'Copy'}
              </button>
            </div>
            <button
              type="button"
              onClick={() => setCreated(null)}
              className="rounded-full border border-[var(--line)] bg-[var(--option-bg)] px-3 py-1 text-xs font-semibold text-[var(--sea-ink-soft)]"
            >
              I've saved it
            </button>
          </div>
        ) : null}
      </div>

      <div>
        <h3 className="mb-2 text-sm font-semibold text-[var(--sea-ink)]">
          Your tokens
        </h3>
        {tokensQuery.isLoading ? (
          <p className="text-sm text-[var(--sea-ink-soft)]">Loading…</p>
        ) : tokens.length === 0 ? (
          <p className="text-sm text-[var(--sea-ink-soft)]">
            No tokens yet.
          </p>
        ) : (
          <ul className="space-y-2">
            {tokens.map((t) => (
              <li
                key={t.id}
                className="island-shell flex items-center gap-3 rounded-xl p-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold text-[var(--sea-ink)]">
                    {t.name}
                  </p>
                  <p className="text-xs text-[var(--sea-ink-soft)]">
                    <code className="font-mono">{t.tokenPrefix}…</code>
                    {' • created '}
                    {new Date(t.createdAt).toLocaleDateString()}
                    {' • '}
                    {t.lastUsedAt
                      ? `last used ${timeAgo(t.lastUsedAt)}`
                      : 'never used'}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    if (
                      confirm(
                        `Revoke "${t.name}"? This can't be undone.`,
                      )
                    ) {
                      revoke.mutate(t.id)
                    }
                  }}
                  className="rounded-full border border-[var(--line)] bg-[var(--option-bg)] px-3 py-1 text-xs font-semibold text-[var(--sea-ink-soft)] transition hover:text-red-600"
                >
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      </div>
    </details>
  )
}

function DocLink({
  to,
  label,
  detail,
}: {
  to: '/settings/api-docs' | '/settings/mcp' | '/settings/home-assistant'
  label: string
  detail: string
}) {
  return (
    <Link
      to={to}
      onClick={(e) => e.stopPropagation()}
      className="block rounded-xl border border-[var(--line)] bg-[var(--option-bg)] p-3 no-underline transition hover:bg-[var(--option-bg-hover)]"
    >
      <p className="text-sm font-semibold text-[var(--sea-ink)]">{label}</p>
      <p className="mt-0.5 text-xs text-[var(--sea-ink-soft)]">{detail}</p>
    </Link>
  )
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(ms / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}
