import { Link, createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_authenticated/settings/api-docs')({
  component: ApiDocsPage,
})

const BASE = 'https://todo.rboskind.com'

function ApiDocsPage() {
  return (
    <main className="page-wrap space-y-8 px-4 py-8">
      <header>
        <Link
          to="/settings"
          className="mb-2 inline-block text-sm text-[var(--lagoon-deep)]"
        >
          ← Back to settings
        </Link>
        <h1 className="display-title text-4xl font-bold text-[var(--sea-ink)]">
          API reference
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-[var(--sea-ink-soft)]">
          REST endpoints under <code className="font-mono">/api/v1</code>.
          Every endpoint requires an{' '}
          <code className="font-mono">Authorization: Bearer tgx_…</code>{' '}
          header — create a token in{' '}
          <Link to="/settings" className="font-semibold text-[var(--lagoon-deep)]">
            settings
          </Link>
          . Responses are <code className="font-mono">{'{ data: … }'}</code> on
          success and{' '}
          <code className="font-mono">{'{ error: { code, message } }'}</code>{' '}
          on failure. All timestamps are ISO 8601 UTC.
        </p>
      </header>

      <Section
        title="GET /api/v1/today"
        purpose="Today's open task instances (plus anything due within the next 36h)."
        request={`curl -H 'Authorization: Bearer tgx_xxxx' \\
  ${BASE}/api/v1/today`}
        response={`{
  "data": [
    {
      "instanceId": "uuid",
      "taskId": "uuid",
      "title": "Take meds",
      "difficulty": "small",
      "xpOverride": 10,
      "dueAt": "2026-04-19T13:00:00.000Z",
      "timeOfDay": "08:00",
      "snoozedUntil": null
    }
  ]
}`}
      />

      <Section
        title="GET /api/v1/tasks"
        purpose="All of the user's active tasks (including someday tasks)."
        request={`curl -H 'Authorization: Bearer tgx_xxxx' \\
  ${BASE}/api/v1/tasks`}
        response={`{
  "data": [
    {
      "id": "uuid",
      "title": "Take meds",
      "notes": null,
      "difficulty": "small",
      "xpOverride": 10,
      "recurrence": { "type": "daily" },
      "timeOfDay": "08:00",
      "snoozeUntil": null,
      "createdAt": "2026-04-18T21:00:00.000Z"
    }
  ]
}`}
      />

      <Section
        title="POST /api/v1/tasks"
        purpose="Create a task. Returns the task id plus the LLM score (if the scoring endpoint is configured)."
        request={`curl -X POST -H 'Authorization: Bearer tgx_xxxx' \\
     -H 'Content-Type: application/json' \\
     -d '{
       "title": "Water plants",
       "notes": null,
       "difficulty": "small",
       "recurrence": null,
       "timeOfDay": null,
       "someday": false
     }' \\
  ${BASE}/api/v1/tasks`}
        response={`{
  "data": {
    "id": "uuid",
    "scored": {
      "xp": 10,
      "tier": "small",
      "reasoning": "Quick 5-minute chore."
    }
  }
}`}
      />

      <Section
        title="GET /api/v1/tasks/:taskId"
        purpose="Full task detail including snooze state and timestamps."
        request={`curl -H 'Authorization: Bearer tgx_xxxx' \\
  ${BASE}/api/v1/tasks/<taskId>`}
        response={`{
  "data": {
    "id": "uuid",
    "title": "Take meds",
    "notes": null,
    "difficulty": "small",
    "xpOverride": 10,
    "recurrence": { "type": "daily" },
    "timeOfDay": "08:00",
    "snoozeUntil": null,
    "active": true,
    "createdAt": "2026-04-18T21:00:00.000Z",
    "updatedAt": "2026-04-18T21:00:00.000Z"
  }
}`}
      />

      <Section
        title="PATCH /api/v1/tasks/:taskId"
        purpose="Partially update a task. Any field you omit is preserved. Includes snoozeUntil (pass null to un-snooze)."
        request={`curl -X PATCH -H 'Authorization: Bearer tgx_xxxx' \\
     -H 'Content-Type: application/json' \\
     -d '{ "title": "Take morning meds", "timeOfDay": "07:30" }' \\
  ${BASE}/api/v1/tasks/<taskId>`}
        response={`{
  "data": {
    "id": "uuid",
    "title": "Take morning meds",
    "timeOfDay": "07:30",
    "...": "...full task detail..."
  }
}`}
      />

      <Section
        title="DELETE /api/v1/tasks/:taskId"
        purpose="Soft-delete. Sets active=false; existing instances stop surfacing. No hard delete for now."
        request={`curl -X DELETE -H 'Authorization: Bearer tgx_xxxx' \\
  ${BASE}/api/v1/tasks/<taskId>`}
        response={`{ "data": { "id": "uuid" } }`}
      />

      <Section
        title="POST /api/v1/instances/:instanceId/complete"
        purpose="Mark an instance done. Writes a task.completed event, applies streak + punctuality multipliers, materializes the next instance if the task recurs. Returns the updated progression."
        request={`curl -X POST -H 'Authorization: Bearer tgx_xxxx' \\
  ${BASE}/api/v1/instances/<instanceId>/complete`}
        response={`{
  "data": {
    "alreadyHandled": false,
    "xp": 26,
    "level": 1,
    "currentStreak": 1
  }
}`}
      />

      <Section
        title="POST /api/v1/instances/:instanceId/skip"
        purpose="Skip. Writes a task.skipped event, does NOT affect progression, materializes the next instance if recurring."
        request={`curl -X POST -H 'Authorization: Bearer tgx_xxxx' \\
  ${BASE}/api/v1/instances/<instanceId>/skip`}
        response={`{ "data": { "alreadyHandled": false } }`}
      />

      <Section
        title="POST /api/v1/instances/:instanceId/snooze"
        purpose="Short (instance-level) snooze by N hours. Hides the instance from Today until the snooze window ends."
        request={`curl -X POST -H 'Authorization: Bearer tgx_xxxx' \\
     -H 'Content-Type: application/json' \\
     -d '{ "hours": 2 }' \\
  ${BASE}/api/v1/instances/<instanceId>/snooze`}
        response={`{ "data": { "snoozedUntil": "2026-04-18T15:00:00.000Z" } }`}
      />

      <Section
        title="GET /api/v1/progression"
        purpose="Current XP / level / streak summary."
        request={`curl -H 'Authorization: Bearer tgx_xxxx' \\
  ${BASE}/api/v1/progression`}
        response={`{
  "data": {
    "xp": 240,
    "level": 3,
    "currentStreak": 5,
    "longestStreak": 12
  }
}`}
      />

      <Section
        title="GET /api/v1/events?since=ISO&limit=1..200"
        purpose="Paginated event log, descending by occurredAt. Useful for LLM context or custom dashboards. Default limit 50."
        request={`curl -H 'Authorization: Bearer tgx_xxxx' \\
  '${BASE}/api/v1/events?since=2026-04-18T00:00:00Z&limit=100'`}
        response={`{
  "data": [
    {
      "id": "uuid",
      "type": "task.completed",
      "payload": {
        "taskId": "uuid",
        "instanceId": "uuid",
        "difficulty": "small",
        "xpOverride": 10,
        "dueAt": "2026-04-18T13:00:00.000Z",
        "timeOfDay": "08:00"
      },
      "occurredAt": "2026-04-18T13:04:12.319Z"
    }
  ]
}`}
      />

      <section className="island-shell max-w-3xl rounded-2xl p-5">
        <h2 className="mb-2 text-lg font-bold text-[var(--sea-ink)]">
          Other access paths
        </h2>
        <ul className="list-disc space-y-1 pl-5 text-sm text-[var(--sea-ink-soft)]">
          <li>
            <Link to="/settings/mcp" className="font-semibold text-[var(--lagoon-deep)]">
              MCP server
            </Link>
            {' '}— same tools wrapped as an MCP server at{' '}
            <code className="font-mono">/api/mcp</code> for Claude Desktop and
            other LLM clients.
          </li>
          <li>
            <Link to="/settings/home-assistant" className="font-semibold text-[var(--lagoon-deep)]">
              Home Assistant
            </Link>
            {' '}— ready-to-paste sensor + command YAML.
          </li>
        </ul>
      </section>

      <section className="island-shell max-w-3xl rounded-2xl p-5">
        <h2 className="mb-2 text-lg font-bold text-[var(--sea-ink)]">
          Error shape
        </h2>
        <p className="mb-3 text-sm text-[var(--sea-ink-soft)]">
          All errors share the same envelope. <code>code</code> is one of{' '}
          <code>unauthorized</code>, <code>not_found</code>,{' '}
          <code>validation</code>, <code>internal</code>.
        </p>
        <pre className="overflow-x-auto rounded-md border border-[var(--line)] bg-[var(--surface-strong)] p-3 text-xs">
{`{
  "error": {
    "code": "not_found",
    "message": "task not found"
  }
}`}
        </pre>
      </section>
    </main>
  )
}

function Section({
  title,
  purpose,
  request,
  response,
}: {
  title: string
  purpose: string
  request: string
  response: string
}) {
  return (
    <section className="island-shell max-w-3xl space-y-3 rounded-2xl p-5">
      <div>
        <h2 className="text-lg font-bold text-[var(--sea-ink)]">
          <code className="font-mono">{title}</code>
        </h2>
        <p className="mt-1 text-sm text-[var(--sea-ink-soft)]">{purpose}</p>
      </div>
      <div>
        <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--kicker)]">
          Request
        </p>
        <pre className="overflow-x-auto rounded-md border border-[var(--line)] bg-[var(--surface-strong)] p-3 text-xs">
          {request}
        </pre>
      </div>
      <div>
        <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--kicker)]">
          Response
        </p>
        <pre className="overflow-x-auto rounded-md border border-[var(--line)] bg-[var(--surface-strong)] p-3 text-xs">
          {response}
        </pre>
      </div>
    </section>
  )
}
