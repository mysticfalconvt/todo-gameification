import { createFileRoute, Link, redirect } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import {
  getAdminLlmCallFn,
  getIsAdminFn,
} from '../../../../server/functions/admin'

export const Route = createFileRoute('/_authenticated/admin/llm/$callId')({
  beforeLoad: async () => {
    const { isAdmin } = await getIsAdminFn()
    if (!isAdmin) throw redirect({ to: '/today' })
  },
  component: AdminLlmCallDetailPage,
})

function AdminLlmCallDetailPage() {
  const { callId } = Route.useParams()
  const query = useQuery({
    queryKey: ['admin', 'llm-call', callId],
    queryFn: () => getAdminLlmCallFn({ data: { id: callId } }),
  })
  const data = query.data

  return (
    <main className="page-wrap space-y-6 px-4 py-8">
      <header className="space-y-1">
        <p className="island-kicker mb-1">
          <Link to="/admin/llm" className="no-underline">
            ← LLM usage
          </Link>
        </p>
        <h1 className="display-title text-3xl font-bold text-[var(--sea-ink)]">
          LLM call
        </h1>
      </header>

      {query.isLoading ? (
        <p className="text-[var(--sea-ink-soft)]">Loading…</p>
      ) : query.isError ? (
        <p className="text-red-600">
          Failed to load call: {(query.error as Error)?.message ?? 'unknown error'}
        </p>
      ) : !data ? (
        <p className="text-[var(--sea-ink-soft)]">Call not found.</p>
      ) : (
        <>
          <Summary data={data} />
          <Messages data={data} />
          <ResponseBlock data={data} />
        </>
      )}
    </main>
  )
}

type CallDetail = NonNullable<Awaited<ReturnType<typeof getAdminLlmCallFn>>>

function Summary({ data }: { data: CallDetail }) {
  return (
    <section className="island-shell rounded-2xl p-4 text-sm">
      <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3">
        <Field label="Kind" value={data.kind} />
        <Field
          label="Started"
          value={new Date(data.startedAt).toLocaleString()}
        />
        <Field label="Duration" value={formatMs(data.durationMs)} />
        <Field
          label="Result"
          value={data.success ? 'ok' : (data.errorMessage ?? 'fail')}
          danger={!data.success}
        />
        <Field label="Model" value={data.model ?? '—'} />
        <Field
          label="User"
          value={
            data.userId ? (
              <Link
                to="/admin/users/$userId"
                params={{ userId: data.userId }}
                className="text-[var(--lagoon-deep)] no-underline"
              >
                @{data.userHandle ?? data.userId.slice(0, 8)}
              </Link>
            ) : (
              '(unattributed)'
            )
          }
        />
        <Field
          label="Prompt tokens"
          value={data.promptTokens?.toLocaleString() ?? '—'}
        />
        <Field
          label="Completion tokens"
          value={data.completionTokens?.toLocaleString() ?? '—'}
        />
        <Field
          label="Total tokens"
          value={data.totalTokens?.toLocaleString() ?? '—'}
        />
      </div>
    </section>
  )
}

function Messages({ data }: { data: CallDetail }) {
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-bold text-[var(--sea-ink)]">Messages</h2>
      {!data.messages || data.messages.length === 0 ? (
        <p className="text-[var(--sea-ink-soft)]">
          No messages recorded (call predates the context upgrade).
        </p>
      ) : (
        <div className="space-y-3">
          {data.messages.map((m, i) => (
            <article
              key={i}
              className="island-shell rounded-2xl p-3 text-sm"
            >
              <div className="mb-2 text-xs uppercase tracking-wide text-[var(--kicker)]">
                {m.role}
              </div>
              <pre className="whitespace-pre-wrap break-words text-[13px] text-[var(--sea-ink)]">
                {m.content}
              </pre>
            </article>
          ))}
        </div>
      )}
    </section>
  )
}

function ResponseBlock({ data }: { data: CallDetail }) {
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-bold text-[var(--sea-ink)]">Response</h2>
      {data.response ? (
        <pre className="island-shell whitespace-pre-wrap break-words rounded-2xl p-3 text-[13px] text-[var(--sea-ink)]">
          {data.response}
        </pre>
      ) : (
        <p className="text-[var(--sea-ink-soft)]">
          {data.errorMessage
            ? `No response — ${data.errorMessage}`
            : 'No response recorded.'}
        </p>
      )}
    </section>
  )
}

function Field({
  label,
  value,
  danger,
}: {
  label: string
  value: React.ReactNode
  danger?: boolean
}) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-[var(--sea-ink-soft)]">
        {label}
      </div>
      <div
        className={`mt-1 text-sm font-semibold ${
          danger ? 'text-red-600' : 'text-[var(--sea-ink)]'
        }`}
      >
        {value}
      </div>
    </div>
  )
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`
}
