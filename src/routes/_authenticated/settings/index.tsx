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
  backfillCategories,
  countUncategorizedTasks,
  createCategory,
  deleteCategory,
  listCategories,
  updateCategory,
} from '../../../server/functions/categories'
import {
  getProfile,
  updateHandle,
  updatePrefs,
  updateProfileVisibility,
  updateQuietHours,
} from '../../../server/functions/user'
import {
  acceptFriendRequestFn,
  cancelFriendRequestFn,
  declineFriendRequestFn,
  listBlockedFn,
  listFriendsFn,
  listIncomingFn,
  listOutgoingFn,
  removeFriendFn,
  sendFriendRequestFn,
  unblockUserFn,
} from '../../../server/functions/social'

export const Route = createFileRoute('/_authenticated/settings/')({
  component: SettingsPage,
})

function SettingsPage() {
  const { data: session } = useSession()

  return (
    <main className="page-wrap space-y-8 px-4 py-8">
      <h1 className="display-title text-4xl font-bold text-[var(--sea-ink)]">
        Profile & settings
      </h1>
      <ProfileSection user={session?.user} />
      <PrivacySection />
      <FriendsSection />
      <AppearanceSection />
      <CategoriesSection />
      <PasswordSection />
      <NotificationsSection />
      <TokensSection />
      <SignOutSection />
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

  const create = useMutation({
    mutationFn: (input: { label: string; color: string }) =>
      createCategory({ data: input }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['categories'] })
      setNewLabel('')
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
          {(categoriesQuery.data ?? []).map((c) => (
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
          create.mutate({ label: newLabel, color: newColor })
        }}
        className="flex flex-wrap items-end gap-3"
      >
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

  const save = useMutation({
    mutationFn: () =>
      updateCategory({
        data: { slug: category.slug, label, color },
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
      <li className="flex flex-wrap items-center gap-2 rounded-xl border border-[var(--line)] p-2">
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
            setEditing(false)
          }}
          className="rounded-full border border-[var(--line)] bg-[var(--option-bg)] px-3 py-1 text-xs font-semibold text-[var(--sea-ink-soft)]"
        >
          Cancel
        </button>
      </li>
    )
  }

  return (
    <li className="flex items-center gap-3 rounded-xl border border-[var(--line)] bg-[var(--option-bg)] p-2">
      <span
        aria-hidden
        className="h-3 w-3 flex-shrink-0 rounded-full"
        style={{ backgroundColor: category.color }}
      />
      <span className="min-w-0 flex-1">
        <span className="text-sm font-semibold text-[var(--sea-ink)]">
          {category.label}
        </span>
        <span className="ml-2 font-mono text-xs text-[var(--sea-ink-soft)]">
          {category.slug}
        </span>
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
// Sign out
// ---------------------------------------------------------------------------

function SignOutSection() {
  const router = useRouter()
  const [pending, setPending] = useState(false)

  async function onSignOut() {
    setPending(true)
    try {
      await signOut()
      await router.invalidate()
      router.navigate({ to: '/auth/login' })
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
  const [savedField, setSavedField] = useState<null | 'name' | 'handle'>(null)
  const [nameError, setNameError] = useState<string | null>(null)
  const [handleError, setHandleError] = useState<string | null>(null)
  const [pendingName, setPendingName] = useState(false)
  const [pendingHandle, setPendingHandle] = useState(false)

  useEffect(() => {
    if (user?.name) setName(user.name)
  }, [user?.id, user?.name])
  useEffect(() => {
    if (profileQuery.data?.handle) setHandle(profileQuery.data.handle)
  }, [profileQuery.data?.handle])

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

  const setPref = useMutation({
    mutationFn: (patch: {
      shareProgression?: boolean
      shareActivity?: boolean
      shareTaskTitles?: boolean
    }) => updatePrefs({ data: patch }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['profile'] }),
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

      <fieldset>
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
// Friends
// ---------------------------------------------------------------------------

function FriendsSection() {
  const qc = useQueryClient()
  const friendsQuery = useQuery({
    queryKey: ['friends'],
    queryFn: () => listFriendsFn(),
  })
  const incomingQuery = useQuery({
    queryKey: ['friends', 'incoming'],
    queryFn: () => listIncomingFn(),
  })
  const outgoingQuery = useQuery({
    queryKey: ['friends', 'outgoing'],
    queryFn: () => listOutgoingFn(),
  })
  const blockedQuery = useQuery({
    queryKey: ['friends', 'blocked'],
    queryFn: () => listBlockedFn(),
  })

  function invalidateAll() {
    qc.invalidateQueries({ queryKey: ['friends'] })
  }

  const [handleInput, setHandleInput] = useState('')
  const [addError, setAddError] = useState<string | null>(null)

  const send = useMutation({
    mutationFn: (handle: string) =>
      sendFriendRequestFn({ data: { handle } }),
    onSuccess: (res) => {
      setHandleInput('')
      setAddError(null)
      invalidateAll()
      if (res.status === 'sent') toast.success('Friend request sent.')
      else if (res.status === 'accepted')
        toast.success('You’re now friends — they had already sent a request.')
      else if (res.status === 'already_pending')
        toast.message('Request already pending.')
      else if (res.status === 'already_friends')
        toast.message('Already friends.')
    },
    onError: (err) => {
      setAddError(err instanceof Error ? err.message : 'Failed to send request.')
    },
  })

  const accept = useMutation({
    mutationFn: (requesterId: string) =>
      acceptFriendRequestFn({ data: { requesterId } }),
    onSuccess: invalidateAll,
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : 'Accept failed'),
  })
  const decline = useMutation({
    mutationFn: (requesterId: string) =>
      declineFriendRequestFn({ data: { requesterId } }),
    onSuccess: invalidateAll,
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : 'Decline failed'),
  })
  const cancel = useMutation({
    mutationFn: (addresseeId: string) =>
      cancelFriendRequestFn({ data: { addresseeId } }),
    onSuccess: invalidateAll,
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : 'Cancel failed'),
  })
  const remove = useMutation({
    mutationFn: (otherUserId: string) =>
      removeFriendFn({ data: { otherUserId } }),
    onSuccess: invalidateAll,
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : 'Remove failed'),
  })
  const unblock = useMutation({
    mutationFn: (targetUserId: string) =>
      unblockUserFn({ data: { targetUserId } }),
    onSuccess: invalidateAll,
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : 'Unblock failed'),
  })

  const friends = friendsQuery.data ?? []
  const incoming = incomingQuery.data ?? []
  const outgoing = outgoingQuery.data ?? []
  const blocked = blockedQuery.data ?? []

  function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    const h = handleInput.trim().replace(/^@/, '')
    if (!h) return
    send.mutate(h)
  }

  return (
    <section className="island-shell max-w-xl rounded-2xl p-6">
      <h2 className="mb-1 text-lg font-bold text-[var(--sea-ink)]">Friends</h2>
      <p className="mb-4 text-sm text-[var(--sea-ink-soft)]">
        Find people by their handle to add them.
      </p>

      <form onSubmit={onSubmit} className="mb-5 flex gap-2">
        <div className="flex flex-1 items-center gap-1 rounded-xl border border-[var(--line)] bg-[var(--option-bg)] px-3">
          <span className="text-[var(--sea-ink-soft)]">@</span>
          <input
            type="text"
            value={handleInput}
            onChange={(e) => setHandleInput(e.target.value.toLowerCase())}
            placeholder="friend_handle"
            className="w-full bg-transparent py-2 text-sm outline-none"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <button
          type="submit"
          disabled={send.isPending || !handleInput.trim()}
          className="rounded-full border border-[rgba(50,143,151,0.3)] bg-[rgba(79,184,178,0.14)] px-4 py-2 text-sm font-semibold text-[var(--lagoon-deep)] disabled:opacity-60"
        >
          {send.isPending ? 'Sending…' : 'Send request'}
        </button>
      </form>
      {addError ? (
        <p className="-mt-3 mb-4 text-sm text-red-600" role="alert">
          {addError}
        </p>
      ) : null}

      {incoming.length > 0 ? (
        <FriendList
          title={`Incoming requests (${incoming.length})`}
          rows={incoming.map((r) => ({
            userId: r.userId,
            handle: r.handle,
            name: r.name,
            trailing: (
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => accept.mutate(r.userId)}
                  disabled={accept.isPending}
                  className="rounded-full bg-[var(--lagoon-deep)] px-3 py-1 text-xs font-semibold text-white disabled:opacity-60"
                >
                  Accept
                </button>
                <button
                  type="button"
                  onClick={() => decline.mutate(r.userId)}
                  disabled={decline.isPending}
                  className="rounded-full border border-[var(--line)] px-3 py-1 text-xs font-semibold text-[var(--sea-ink-soft)] disabled:opacity-60"
                >
                  Decline
                </button>
              </div>
            ),
          }))}
        />
      ) : null}

      {outgoing.length > 0 ? (
        <FriendList
          title={`Sent (${outgoing.length})`}
          rows={outgoing.map((r) => ({
            userId: r.userId,
            handle: r.handle,
            name: r.name,
            trailing: (
              <button
                type="button"
                onClick={() => cancel.mutate(r.userId)}
                disabled={cancel.isPending}
                className="rounded-full border border-[var(--line)] px-3 py-1 text-xs font-semibold text-[var(--sea-ink-soft)] disabled:opacity-60"
              >
                Cancel
              </button>
            ),
          }))}
        />
      ) : null}

      <FriendList
        title={`Friends (${friends.length})`}
        empty="No friends yet. Send a request above."
        rows={friends.map((r) => ({
          userId: r.userId,
          handle: r.handle,
          name: r.name,
          trailing: (
            <button
              type="button"
              onClick={() => {
                if (!confirm(`Remove @${r.handle} from friends?`)) return
                remove.mutate(r.userId)
              }}
              disabled={remove.isPending}
              className="rounded-full border border-[var(--line)] px-3 py-1 text-xs font-semibold text-[var(--sea-ink-soft)] disabled:opacity-60"
            >
              Remove
            </button>
          ),
        }))}
      />

      {blocked.length > 0 ? (
        <FriendList
          title={`Blocked (${blocked.length})`}
          rows={blocked.map((r) => ({
            userId: r.userId,
            handle: r.handle,
            name: r.name,
            trailing: (
              <button
                type="button"
                onClick={() => unblock.mutate(r.userId)}
                disabled={unblock.isPending}
                className="rounded-full border border-[var(--line)] px-3 py-1 text-xs font-semibold text-[var(--sea-ink-soft)] disabled:opacity-60"
              >
                Unblock
              </button>
            ),
          }))}
        />
      ) : null}
    </section>
  )
}

function FriendList({
  title,
  empty,
  rows,
}: {
  title: string
  empty?: string
  rows: Array<{
    userId: string
    handle: string
    name: string
    trailing: React.ReactNode
  }>
}) {
  return (
    <div className="mb-4 last:mb-0">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--kicker)]">
        {title}
      </h3>
      {rows.length === 0 ? (
        empty ? (
          <p className="text-sm text-[var(--sea-ink-soft)]">{empty}</p>
        ) : null
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => (
            <li
              key={r.userId}
              className="flex items-center gap-3 rounded-xl border border-[var(--line)] bg-[var(--option-bg)] p-3"
            >
              <Initials name={r.name} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-[var(--sea-ink)]">
                  {r.name}
                </p>
                <p className="truncate text-xs text-[var(--sea-ink-soft)]">
                  @{r.handle}
                </p>
              </div>
              {r.trailing}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function Initials({ name }: { name: string }) {
  const letters = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('')
  return (
    <span
      className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-[var(--lagoon-deep)] text-xs font-bold text-white"
      aria-hidden
    >
      {letters || '?'}
    </span>
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

  const tokens = tokensQuery.data ?? []

  return (
    <details className="island-shell max-w-2xl rounded-2xl [&[open]>summary_[data-chevron]]:rotate-90">
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
