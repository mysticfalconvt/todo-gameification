import { useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useMutation } from '@tanstack/react-query'
import { toast } from 'sonner'
import { submitFeatureRequest } from '../../server/functions/featureRequests'

export const Route = createFileRoute('/_authenticated/feedback')({
  component: FeedbackPage,
})

function FeedbackPage() {
  const navigate = useNavigate()
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')

  const submit = useMutation({
    mutationFn: () =>
      submitFeatureRequest({ data: { title, description } }),
    onSuccess: () => {
      toast.success("Thanks! Your feature request has been sent.")
      setTitle('')
      setDescription('')
      navigate({ to: '/today' })
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Could not submit')
    },
  })

  const titleTrim = title.trim()
  const descriptionTrim = description.trim()
  const canSubmit =
    titleTrim.length > 0 && descriptionTrim.length > 0 && !submit.isPending

  return (
    <main className="page-wrap px-4 py-8">
      <h1 className="display-title mb-2 text-4xl font-bold text-[var(--sea-ink)]">
        Send a feature request
      </h1>
      <p className="mb-6 max-w-xl text-sm text-[var(--sea-ink-soft)]">
        Got an idea for the app? Tell us about it. Your request goes
        straight to the maintainers as a task they'll see in their own
        list.
      </p>

      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (!canSubmit) return
          submit.mutate()
        }}
        className="island-shell max-w-xl space-y-5 rounded-2xl p-6"
      >
        <label className="block">
          <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-[var(--kicker)]">
            Title
          </span>
          <input
            type="text"
            required
            maxLength={200}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Short summary of your idea"
            className="field-input"
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-[var(--kicker)]">
            Description
          </span>
          <textarea
            required
            maxLength={4000}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={8}
            placeholder="What would it do? Why would it help? Any details that'd be useful for whoever picks this up."
            className="field-input"
          />
          <span className="mt-1 block text-right text-[11px] text-[var(--sea-ink-soft)]">
            {description.length} / 4000
          </span>
        </label>

        <div className="flex items-center justify-end gap-3 pt-1">
          <button
            type="button"
            onClick={() => navigate({ to: '/today' })}
            className="rounded-full border border-[var(--line)] bg-[var(--option-bg)] px-4 py-2 text-sm font-semibold text-[var(--sea-ink-soft)]"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!canSubmit}
            className="rounded-full border border-[rgba(50,143,151,0.3)] bg-[rgba(79,184,178,0.14)] px-5 py-2 text-sm font-semibold text-[var(--lagoon-deep)] disabled:opacity-60"
          >
            {submit.isPending ? 'Sending…' : 'Send feature request'}
          </button>
        </div>
      </form>
    </main>
  )
}
