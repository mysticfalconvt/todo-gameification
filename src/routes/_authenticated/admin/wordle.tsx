import { useState } from 'react'
import { createFileRoute, Link, redirect } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { getIsAdminFn } from '../../../server/functions/admin'
import {
  addWordleWords,
  listWordleWords,
  removeWordleWord,
} from '../../../server/functions/wordle'

export const Route = createFileRoute('/_authenticated/admin/wordle')({
  beforeLoad: async () => {
    const { isAdmin } = await getIsAdminFn()
    if (!isAdmin) throw redirect({ to: '/today' })
  },
  component: AdminWordlePage,
})

function AdminWordlePage() {
  const qc = useQueryClient()
  const [draft, setDraft] = useState('')
  const [filter, setFilter] = useState('')

  const wordsQuery = useQuery({
    queryKey: ['admin', 'wordle', 'words'],
    queryFn: () => listWordleWords(),
  })

  const addMutation = useMutation({
    mutationFn: (raw: string) => addWordleWords({ data: { raw } }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['admin', 'wordle', 'words'] })
      const bits: string[] = []
      bits.push(`${res.added} added`)
      if (res.skipped > 0) bits.push(`${res.skipped} already present`)
      if (res.invalid.length > 0) bits.push(`${res.invalid.length} invalid`)
      toast.success(bits.join(', '))
      setDraft('')
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Add failed')
    },
  })

  const removeMutation = useMutation({
    mutationFn: (word: string) => removeWordleWord({ data: { word } }),
    onSuccess: (ok, word) => {
      qc.invalidateQueries({ queryKey: ['admin', 'wordle', 'words'] })
      if (ok) toast.success(`Removed ${word}`)
      else toast.error(`${word} not found`)
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Remove failed')
    },
  })

  const words = wordsQuery.data ?? []
  const lowered = filter.trim().toLowerCase()
  const visible = lowered
    ? words.filter((w) => w.word.toLowerCase().includes(lowered))
    : words

  return (
    <main className="page-wrap space-y-6 px-4 py-8">
      <header className="space-y-1">
        <p className="island-kicker">Admin</p>
        <h1 className="display-title text-4xl font-bold text-[var(--sea-ink)]">
          Wordle words
        </h1>
        <p className="text-sm text-[var(--sea-ink-soft)]">
          The arcade pool. Each entry must be 5 A–Z letters; input is
          normalized to uppercase.{' '}
          <Link
            to="/admin"
            className="text-[var(--lagoon-deep)] no-underline"
          >
            ← Back to admin
          </Link>
        </p>
      </header>

      <section className="island-shell space-y-3 rounded-2xl p-4">
        <h2 className="text-lg font-bold text-[var(--sea-ink)]">Add words</h2>
        <p className="text-xs text-[var(--sea-ink-soft)]">
          Paste words separated by whitespace or commas. Duplicates are
          silently skipped.
        </p>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={4}
          placeholder="PLANT, CLOUD, FROST..."
          className="w-full rounded-lg border border-[var(--btn-subtle-border)] bg-[var(--btn-subtle-bg)] p-2 font-mono text-sm uppercase text-[var(--sea-ink)]"
        />
        <div className="flex items-center gap-3">
          <button
            type="button"
            disabled={!draft.trim() || addMutation.isPending}
            onClick={() => addMutation.mutate(draft)}
            className="rounded-full bg-[var(--btn-primary-bg)] px-4 py-2 text-sm font-semibold text-[var(--btn-primary-fg)] disabled:opacity-50"
          >
            {addMutation.isPending ? 'Adding…' : 'Add'}
          </button>
          <span className="text-xs text-[var(--sea-ink-soft)]">
            {wordsQuery.data
              ? `${wordsQuery.data.length} word${wordsQuery.data.length === 1 ? '' : 's'} in pool`
              : '…'}
          </span>
        </div>
      </section>

      <section className="space-y-3">
        <header className="flex items-end justify-between gap-3">
          <h2 className="text-lg font-bold text-[var(--sea-ink)]">Pool</h2>
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter…"
            className="rounded-lg border border-[var(--btn-subtle-border)] bg-[var(--btn-subtle-bg)] px-3 py-1 text-sm"
          />
        </header>
        {wordsQuery.isLoading ? (
          <p className="text-sm text-[var(--sea-ink-soft)]">Loading…</p>
        ) : visible.length === 0 ? (
          <p className="text-sm text-[var(--sea-ink-soft)]">
            {words.length === 0 ? 'No words yet.' : 'No matches.'}
          </p>
        ) : (
          <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
            {visible.map((w) => (
              <li
                key={w.word}
                className="flex items-center justify-between rounded-lg border border-[var(--btn-subtle-border)] bg-[var(--btn-subtle-bg)] px-3 py-1.5 font-mono text-sm"
              >
                <span className="text-[var(--sea-ink)]">{w.word}</span>
                <button
                  type="button"
                  onClick={() => removeMutation.mutate(w.word)}
                  disabled={removeMutation.isPending}
                  className="text-xs text-red-600 hover:underline disabled:opacity-50"
                  aria-label={`Remove ${w.word}`}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  )
}
