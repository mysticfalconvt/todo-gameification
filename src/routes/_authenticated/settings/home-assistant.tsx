import { Link, createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_authenticated/settings/home-assistant')({
  component: HomeAssistantDocsPage,
})

function HomeAssistantDocsPage() {
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
          Home Assistant integration
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-[var(--sea-ink-soft)]">
          Ready-to-paste config that surfaces Todo XP state as HA sensors and
          lets you complete / skip / snooze tasks from automations,
          dashboards, and physical buttons. Everything below assumes your app
          is at <code className="font-mono">todo.rboskind.com</code> —
          replace with your own domain if different.
        </p>
      </header>

      <section className="island-shell max-w-3xl space-y-3 rounded-2xl p-5">
        <h2 className="text-lg font-bold text-[var(--sea-ink)]">
          1. Mint an API token
        </h2>
        <ol className="list-decimal space-y-1 pl-5 text-sm text-[var(--sea-ink-soft)]">
          <li>
            Open{' '}
            <Link to="/settings" className="font-semibold text-[var(--lagoon-deep)]">
              settings
            </Link>{' '}
            → expand <strong>API access</strong> → create token named
            "Home Assistant".
          </li>
          <li>Copy the <code className="font-mono">tgx_…</code> value (shown once).</li>
          <li>Store it in HA's <code className="font-mono">secrets.yaml</code>:</li>
        </ol>
        <pre className="overflow-x-auto rounded-md border border-[var(--line)] bg-[var(--surface-strong)] p-3 text-xs">
{`# secrets.yaml
todo_xp_token: "Bearer tgx_xxxxxxxxxxxxxxxxxxxx"`}
        </pre>
        <p className="text-xs text-[var(--sea-ink-soft)]">
          Note the literal <code className="font-mono">Bearer&nbsp;</code> prefix —
          HA's <code className="font-mono">rest:</code> and{' '}
          <code className="font-mono">rest_command:</code> pass the secret
          through verbatim to the Authorization header.
        </p>
      </section>

      <section className="island-shell max-w-3xl space-y-3 rounded-2xl p-5">
        <h2 className="text-lg font-bold text-[var(--sea-ink)]">2. Sensors</h2>
        <p className="text-sm text-[var(--sea-ink-soft)]">
          Add to <code className="font-mono">configuration.yaml</code>:
        </p>
        <pre className="overflow-x-auto rounded-md border border-[var(--line)] bg-[var(--surface-strong)] p-3 text-xs">
{`rest:
  - resource: https://todo.rboskind.com/api/v1/today
    scan_interval: 300
    headers:
      Authorization: !secret todo_xp_token
      Content-Type: application/json
    sensor:
      - name: "Todo XP Due Today"
        unique_id: todo_xp_due_today
        value_template: "{{ value_json.data | length }}"
        unit_of_measurement: "tasks"
        icon: mdi:clipboard-check-outline

  - resource: https://todo.rboskind.com/api/v1/progression
    scan_interval: 300
    headers:
      Authorization: !secret todo_xp_token
    sensor:
      - name: "Todo XP Level"
        unique_id: todo_xp_level
        value_template: "{{ value_json.data.level }}"
        icon: mdi:trophy
      - name: "Todo XP Points"
        unique_id: todo_xp_points
        value_template: "{{ value_json.data.xp }}"
        unit_of_measurement: "XP"
        icon: mdi:star-four-points
      - name: "Todo XP Streak"
        unique_id: todo_xp_streak
        value_template: "{{ value_json.data.currentStreak }}"
        unit_of_measurement: "days"
        icon: mdi:fire
      - name: "Todo XP Longest Streak"
        unique_id: todo_xp_longest_streak
        value_template: "{{ value_json.data.longestStreak }}"
        unit_of_measurement: "days"
        icon: mdi:flame-circle`}
        </pre>
        <p className="text-sm text-[var(--sea-ink-soft)]">
          Restart HA → Developer Tools → States should now show{' '}
          <code className="font-mono">sensor.todo_xp_due_today</code>,{' '}
          <code className="font-mono">sensor.todo_xp_level</code>, etc.
        </p>
      </section>

      <section className="island-shell max-w-3xl space-y-3 rounded-2xl p-5">
        <h2 className="text-lg font-bold text-[var(--sea-ink)]">3. Commands</h2>
        <pre className="overflow-x-auto rounded-md border border-[var(--line)] bg-[var(--surface-strong)] p-3 text-xs">
{`rest_command:
  todo_xp_complete_instance:
    url: "https://todo.rboskind.com/api/v1/instances/{{ instance_id }}/complete"
    method: post
    headers:
      Authorization: !secret todo_xp_token

  todo_xp_skip_instance:
    url: "https://todo.rboskind.com/api/v1/instances/{{ instance_id }}/skip"
    method: post
    headers:
      Authorization: !secret todo_xp_token

  todo_xp_snooze_instance:
    url: "https://todo.rboskind.com/api/v1/instances/{{ instance_id }}/snooze"
    method: post
    headers:
      Authorization: !secret todo_xp_token
      Content-Type: application/json
    payload: '{ "hours": {{ hours | default(1) }} }'

  todo_xp_create_task:
    url: "https://todo.rboskind.com/api/v1/tasks"
    method: post
    headers:
      Authorization: !secret todo_xp_token
      Content-Type: application/json
    payload: >-
      { "title": "{{ title }}",
        "difficulty": "{{ difficulty | default('medium') }}",
        "recurrence": {{ recurrence | default('null') }},
        "timeOfDay": {{ time_of_day | default('null') }},
        "someday": {{ someday | default(false) | lower }} }`}
        </pre>
      </section>

      <section className="island-shell max-w-3xl space-y-3 rounded-2xl p-5">
        <h2 className="text-lg font-bold text-[var(--sea-ink)]">
          4. Today's list as attributes
        </h2>
        <p className="text-sm text-[var(--sea-ink-soft)]">
          Scalar sensors are great for counts, but to render individual tasks
          on a Lovelace card you want the full list as attributes:
        </p>
        <pre className="overflow-x-auto rounded-md border border-[var(--line)] bg-[var(--surface-strong)] p-3 text-xs">
{`rest:
  - resource: https://todo.rboskind.com/api/v1/today
    scan_interval: 300
    headers:
      Authorization: !secret todo_xp_token
    sensor:
      - name: "Todo XP Today List"
        unique_id: todo_xp_today_list
        value_template: "{{ value_json.data | length }}"
        json_attributes_path: "$.data"
        json_attributes:
          - "[*]"`}
        </pre>
        <p className="text-sm text-[var(--sea-ink-soft)]">
          Then a Lovelace <code className="font-mono">markdown</code> card:
        </p>
        <pre className="overflow-x-auto rounded-md border border-[var(--line)] bg-[var(--surface-strong)] p-3 text-xs">
{`type: markdown
content: |
  ## Today ({{ states('sensor.todo_xp_due_today') }})
  {% for t in state_attr('sensor.todo_xp_today_list', '[*]') or [] %}
  - **{{ t.title }}** — {{ t.difficulty }} ({{ t.xpOverride or '?' }} XP)
  {% endfor %}`}
        </pre>
      </section>

      <section className="island-shell max-w-3xl space-y-2 rounded-2xl p-5">
        <h2 className="text-lg font-bold text-[var(--sea-ink)]">
          5. Automations worth building
        </h2>
        <ul className="list-disc space-y-1 pl-5 text-sm text-[var(--sea-ink-soft)]">
          <li>
            <strong>Lights dim at 22:00 if due count &gt; 0</strong> — visible nudge.
          </li>
          <li>
            <strong>Daily 07:55 TTS</strong> announcing due count + current streak.
          </li>
          <li>
            <strong>On streak reset</strong> (currentStreak drops) → motivating
            push on a different channel.
          </li>
          <li>
            <strong>Physical kitchen button</strong> →{' '}
            <code className="font-mono">rest_command.todo_xp_complete_instance</code>{' '}
            on the first due instance. Hands-free "took meds".
          </li>
        </ul>
      </section>

      <section className="island-shell max-w-3xl space-y-2 rounded-2xl p-5">
        <h2 className="text-lg font-bold text-[var(--sea-ink)]">
          6. Troubleshooting
        </h2>
        <ul className="list-disc space-y-1 pl-5 text-sm text-[var(--sea-ink-soft)]">
          <li>
            <strong>401 Unauthorized</strong> — secret must include the literal{' '}
            <code className="font-mono">Bearer&nbsp;</code> prefix.
          </li>
          <li>
            <strong>404 on complete/skip/snooze</strong> — instance IDs change
            every time a task materializes a new instance. Always read the
            current id from{' '}
            <code className="font-mono">sensor.todo_xp_today_list</code>, don't
            hard-code.
          </li>
          <li>
            <strong>Stale counts</strong> — default{' '}
            <code className="font-mono">scan_interval</code> is 300s; drop to
            60s for snappier dashboards. Don't go below 30s.
          </li>
          <li>
            <strong>Rotate a token</strong> — revoke in settings, mint a new
            one, update <code className="font-mono">secrets.yaml</code>, HA
            core restart. Old token 401s immediately.
          </li>
        </ul>
      </section>
    </main>
  )
}
