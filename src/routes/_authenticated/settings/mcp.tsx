import { Link, createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_authenticated/settings/mcp')({
  component: McpDocsPage,
})

const BASE = 'https://todo.rboskind.com'

function McpDocsPage() {
  return (
    <main className="page-wrap space-y-6 px-4 py-8">
      <header>
        <Link
          to="/settings"
          className="mb-2 inline-block text-sm text-[var(--lagoon-deep)]"
        >
          ← Back to settings
        </Link>
        <h1 className="display-title text-4xl font-bold text-[var(--sea-ink)]">
          MCP server
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-[var(--sea-ink-soft)]">
          A Model Context Protocol server is mounted at{' '}
          <code className="font-mono">/api/mcp</code>. It exposes the same
          operations as the REST API as typed MCP tools, so Claude Desktop and
          other MCP clients can read and modify your tasks directly. Auth is
          the same <code className="font-mono">tgx_</code> token you use for
          REST.
        </p>
      </header>

      <section className="island-shell max-w-3xl rounded-2xl p-5">
        <h2 className="mb-2 text-lg font-bold text-[var(--sea-ink)]">
          Claude Desktop setup
        </h2>
        <ol className="mb-3 list-decimal space-y-1 pl-5 text-sm text-[var(--sea-ink-soft)]">
          <li>
            Create a token in{' '}
            <Link to="/settings" className="font-semibold text-[var(--lagoon-deep)]">
              settings
            </Link>{' '}
            and copy the <code className="font-mono">tgx_…</code> value.
          </li>
          <li>
            Open Claude Desktop → Settings → Developer → Edit config (this
            opens <code className="font-mono">claude_desktop_config.json</code>).
          </li>
          <li>Paste the block below, replacing the token. Save.</li>
          <li>Fully quit + reopen Claude Desktop.</li>
        </ol>
        <pre className="overflow-x-auto rounded-md border border-[var(--line)] bg-[var(--surface-strong)] p-3 text-xs">
{`{
  "mcpServers": {
    "todo-xp": {
      "url": "${BASE}/api/mcp",
      "headers": {
        "Authorization": "Bearer tgx_xxxxxxxxxxxxxxxxxxxx"
      }
    }
  }
}`}
        </pre>
        <p className="mt-3 text-sm text-[var(--sea-ink-soft)]">
          Any MCP client with Streamable HTTP transport (URL + headers) works
          — open-interpreter, Cline, custom agents, etc.
        </p>
      </section>

      <section className="max-w-3xl space-y-3">
        <h2 className="text-lg font-bold text-[var(--sea-ink)]">Tools</h2>
        <p className="text-sm text-[var(--sea-ink-soft)]">
          Every tool below is callable by a connected LLM. Arguments are typed
          (via Zod schemas), results are JSON.
        </p>

        <ToolCard
          name="list_today"
          purpose="Open task instances due within the next ~36 hours."
          args="none"
        />
        <ToolCard
          name="list_someday"
          purpose="Undated open tasks (no deadline)."
          args="none"
        />
        <ToolCard
          name="list_tasks"
          purpose="All active tasks the user has."
          args="none"
        />
        <ToolCard
          name="get_task"
          purpose="Full detail for one task."
          args="taskId: string (UUID)"
        />
        <ToolCard
          name="create_task"
          purpose="Add a task. Pass someday=true + omit recurrence/timeOfDay for a no-deadline task."
          args={`title: string
notes: string | null
difficulty: 'small' | 'medium' | 'large'
recurrence: { type: 'daily' } | { type: 'weekly', daysOfWeek: number[] } | { type: 'interval', days: number } | { type: 'after_completion', days: number } | null
timeOfDay: 'HH:MM' | null
someday: boolean`}
        />
        <ToolCard
          name="complete_instance"
          purpose="Mark an instance done. Grants XP + updates streak. Materializes next occurrence for recurring tasks."
          args="instanceId: string (UUID)"
        />
        <ToolCard
          name="skip_instance"
          purpose="Skip this occurrence (no XP). Materializes next instance if the task recurs."
          args="instanceId: string (UUID)"
        />
        <ToolCard
          name="snooze_instance"
          purpose="Hide this instance from Today for N hours."
          args={`instanceId: string (UUID)
hours: number (0..720)`}
        />
        <ToolCard
          name="snooze_task"
          purpose="Long-snooze the whole task until an ISO timestamp. Pass until=null to un-snooze."
          args={`taskId: string (UUID)
until: string (ISO) | null`}
        />
        <ToolCard
          name="delete_task"
          purpose="Soft-delete (active=false). Existing instances stop surfacing."
          args="taskId: string (UUID)"
        />
        <ToolCard
          name="get_progression"
          purpose="Current XP, level, current streak, longest streak."
          args="none"
        />
        <ToolCard
          name="list_recent_activity"
          purpose="ISO dates (YYYY-MM-DD, user-local tz) with ≥1 completion in the last 8 days."
          args="none"
        />
      </section>
    </main>
  )
}

function ToolCard({
  name,
  purpose,
  args,
}: {
  name: string
  purpose: string
  args: string
}) {
  return (
    <div className="island-shell rounded-xl p-4">
      <p className="font-mono text-sm font-semibold text-[var(--sea-ink)]">
        {name}
      </p>
      <p className="mt-1 text-sm text-[var(--sea-ink-soft)]">{purpose}</p>
      <p className="mt-2 text-xs font-semibold uppercase tracking-wide text-[var(--kicker)]">
        Arguments
      </p>
      <pre className="mt-1 overflow-x-auto rounded-md border border-[var(--line)] bg-[var(--surface-strong)] p-2 text-xs">
        {args}
      </pre>
    </div>
  )
}
