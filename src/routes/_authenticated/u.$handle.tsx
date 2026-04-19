import { createFileRoute, Link } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { getPublicProfileFn } from '../../server/functions/profile'
import {
  acceptFriendRequestFn,
  blockUserFn,
  cancelFriendRequestFn,
  declineFriendRequestFn,
  removeFriendFn,
  sendFriendRequestFn,
  unblockUserFn,
} from '../../server/functions/social'
import type { PublicProfile } from '../../server/services/profile'

export const Route = createFileRoute('/_authenticated/u/$handle')({
  component: ProfilePage,
})

function ProfilePage() {
  const { handle } = Route.useParams()
  const qc = useQueryClient()
  const query = useQuery({
    queryKey: ['profile', 'public', handle],
    queryFn: () => getPublicProfileFn({ data: { handle } }),
  })

  function invalidate() {
    qc.invalidateQueries({ queryKey: ['profile', 'public', handle] })
    qc.invalidateQueries({ queryKey: ['friends'] })
  }

  const send = useMutation({
    mutationFn: () => sendFriendRequestFn({ data: { handle } }),
    onSuccess: (res) => {
      invalidate()
      if (res.status === 'sent') toast.success('Request sent.')
      else if (res.status === 'accepted')
        toast.success('You’re now friends.')
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : 'Request failed'),
  })

  const cancel = useMutation({
    mutationFn: (addresseeId: string) =>
      cancelFriendRequestFn({ data: { addresseeId } }),
    onSuccess: invalidate,
  })
  const accept = useMutation({
    mutationFn: (requesterId: string) =>
      acceptFriendRequestFn({ data: { requesterId } }),
    onSuccess: invalidate,
  })
  const decline = useMutation({
    mutationFn: (requesterId: string) =>
      declineFriendRequestFn({ data: { requesterId } }),
    onSuccess: invalidate,
  })
  const remove = useMutation({
    mutationFn: (otherUserId: string) =>
      removeFriendFn({ data: { otherUserId } }),
    onSuccess: invalidate,
  })
  const block = useMutation({
    mutationFn: (targetUserId: string) =>
      blockUserFn({ data: { targetUserId } }),
    onSuccess: invalidate,
  })
  const unblock = useMutation({
    mutationFn: (targetUserId: string) =>
      unblockUserFn({ data: { targetUserId } }),
    onSuccess: invalidate,
  })

  if (query.isLoading) {
    return (
      <main className="page-wrap px-4 py-8">
        <p className="text-[var(--sea-ink-soft)]">Loading…</p>
      </main>
    )
  }

  if (!query.data) {
    return (
      <main className="page-wrap px-4 py-16 text-center">
        <h1 className="display-title mb-2 text-3xl font-bold text-[var(--sea-ink)]">
          No one with that handle
        </h1>
        <p className="mb-6 text-[var(--sea-ink-soft)]">
          We couldn’t find a user <code>@{handle}</code>.
        </p>
        <Link
          to="/friends"
          className="rounded-full border border-[rgba(50,143,151,0.3)] bg-[rgba(79,184,178,0.14)] px-4 py-2 text-sm font-semibold text-[var(--lagoon-deep)] no-underline"
        >
          Back to friends
        </Link>
      </main>
    )
  }

  const p = query.data

  return (
    <main className="page-wrap space-y-6 px-4 py-8">
      <header className="flex flex-wrap items-center gap-4">
        <Avatar name={p.name} />
        <div className="min-w-0 flex-1">
          <h1 className="display-title text-3xl font-bold text-[var(--sea-ink)]">
            {p.name}
          </h1>
          <p className="text-sm text-[var(--sea-ink-soft)]">@{p.handle}</p>
        </div>
        <ActionButtons
          profile={p}
          onSend={() => send.mutate()}
          onCancel={() => cancel.mutate(p.userId)}
          onAccept={() => accept.mutate(p.userId)}
          onDecline={() => decline.mutate(p.userId)}
          onRemove={() => {
            if (!confirm(`Remove @${p.handle} from friends?`)) return
            remove.mutate(p.userId)
          }}
          onBlock={() => {
            if (!confirm(`Block @${p.handle}?`)) return
            block.mutate(p.userId)
          }}
          onUnblock={() => unblock.mutate(p.userId)}
          pending={
            send.isPending ||
            cancel.isPending ||
            accept.isPending ||
            decline.isPending ||
            remove.isPending ||
            block.isPending ||
            unblock.isPending
          }
        />
      </header>

      {!p.canView ? (
        <section className="island-shell rounded-2xl p-6">
          <p className="text-[var(--sea-ink-soft)]">
            {p.profileVisibility === 'private'
              ? 'This profile is private.'
              : p.viewerRelation === 'blocked_me'
                ? 'You can’t view this profile.'
                : 'Only friends can see this profile.'}
          </p>
        </section>
      ) : (
        <>
          <section className="island-shell rounded-2xl p-4">
            <div className="grid grid-cols-4 gap-4 text-center">
              <Stat label="Level" value={p.progression!.level} />
              <Stat label="XP" value={p.progression!.xp} />
              <Stat
                label="Streak"
                value={`${p.progression!.currentStreak}d`}
              />
              <Stat
                label="Longest"
                value={`${p.progression!.longestStreak}d`}
              />
            </div>
          </section>
          <XpSection data={p.xpByDay} />
        </>
      )}
    </main>
  )
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <div className="text-2xl font-bold text-[var(--sea-ink)]">{value}</div>
      <div className="text-xs uppercase tracking-wide text-[var(--sea-ink-soft)]">
        {label}
      </div>
    </div>
  )
}

function XpSection({
  data,
}: {
  data: Array<{ date: string; xp: number }>
}) {
  const total = data.reduce((acc, d) => acc + d.xp, 0)
  const max = data.reduce((acc, d) => Math.max(acc, d.xp), 0) || 1
  const width = 600
  const height = 120
  const padX = 4
  const n = data.length
  const stepX = n > 1 ? (width - padX * 2) / (n - 1) : 0
  const points = data
    .map((d, i) => {
      const x = padX + i * stepX
      const y = height - (d.xp / max) * (height - 8) - 4
      return `${x},${y}`
    })
    .join(' ')
  const area = `${padX},${height} ${points} ${padX + (n - 1) * stepX},${height}`

  return (
    <section className="island-shell rounded-2xl p-4">
      <header className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-bold text-[var(--sea-ink)]">
          XP (last 30 days)
        </h2>
        <p className="text-xs text-[var(--sea-ink-soft)]">total {total}</p>
      </header>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-32 w-full"
        preserveAspectRatio="none"
      >
        <polygon points={area} fill="var(--lagoon-deep)" fillOpacity="0.15" />
        <polyline
          points={points}
          fill="none"
          stroke="var(--lagoon-deep)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </section>
  )
}

function Avatar({ name }: { name: string }) {
  const letters = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('')
  return (
    <span
      className="flex h-14 w-14 flex-shrink-0 items-center justify-center rounded-full bg-[var(--lagoon-deep)] text-lg font-bold text-white"
      aria-hidden
    >
      {letters || '?'}
    </span>
  )
}

function ActionButtons({
  profile,
  onSend,
  onCancel,
  onAccept,
  onDecline,
  onRemove,
  onBlock,
  onUnblock,
  pending,
}: {
  profile: PublicProfile
  onSend: () => void
  onCancel: () => void
  onAccept: () => void
  onDecline: () => void
  onRemove: () => void
  onBlock: () => void
  onUnblock: () => void
  pending: boolean
}) {
  const btn =
    'rounded-full border border-[var(--line)] px-3 py-1 text-xs font-semibold text-[var(--sea-ink-soft)] disabled:opacity-60'
  const primary =
    'rounded-full border border-[rgba(50,143,151,0.3)] bg-[rgba(79,184,178,0.14)] px-3 py-1 text-xs font-semibold text-[var(--lagoon-deep)] disabled:opacity-60'

  if (profile.viewerRelation === 'self') {
    return (
      <Link to="/settings" className={primary}>
        Edit profile
      </Link>
    )
  }
  if (profile.viewerRelation === 'blocked_me') return null
  if (profile.viewerRelation === 'blocked_by_me') {
    return (
      <button type="button" className={btn} onClick={onUnblock} disabled={pending}>
        Unblock
      </button>
    )
  }
  if (profile.viewerRelation === 'friend') {
    return (
      <div className="flex gap-2">
        <button type="button" className={btn} onClick={onRemove} disabled={pending}>
          Remove friend
        </button>
        <button type="button" className={btn} onClick={onBlock} disabled={pending}>
          Block
        </button>
      </div>
    )
  }
  if (profile.viewerRelation === 'outgoing_request') {
    return (
      <button type="button" className={btn} onClick={onCancel} disabled={pending}>
        Cancel request
      </button>
    )
  }
  if (profile.viewerRelation === 'incoming_request') {
    return (
      <div className="flex gap-2">
        <button
          type="button"
          className={primary}
          onClick={onAccept}
          disabled={pending}
        >
          Accept
        </button>
        <button
          type="button"
          className={btn}
          onClick={onDecline}
          disabled={pending}
        >
          Decline
        </button>
      </div>
    )
  }
  // 'none'
  return (
    <div className="flex gap-2">
      <button type="button" className={primary} onClick={onSend} disabled={pending}>
        Add friend
      </button>
      <button type="button" className={btn} onClick={onBlock} disabled={pending}>
        Block
      </button>
    </div>
  )
}
