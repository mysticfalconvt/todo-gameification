# Home Assistant Integration

A ready-to-paste Home Assistant config that surfaces Todo XP state as sensors and lets you complete / snooze / skip tasks from automations and dashboards.

Everything below assumes your app is running at `https://todo.rboskind.com`. Replace with your own domain.

---

## 1. Mint an API token

1. Sign in to Todo XP on the web.
2. Click your user name in the top-right to open `/settings`.
3. Expand **API tokens** → give it a name (e.g. `Home Assistant`) → **Create token**.
4. Copy the `tgx_...` string shown **once**. You can't retrieve it again; if you lose it, revoke and mint a new one.

Store it as a secret in Home Assistant so it never lands in your UI YAML:

```yaml
# secrets.yaml
todo_xp_token: "Bearer tgx_xxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

(Note the literal word `Bearer ` at the front — HA's `rest` + `rest_command` pass the secret through verbatim to the `Authorization` header.)

---

## 2. Sensors

Add to `configuration.yaml`:

```yaml
rest:
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
        icon: mdi:flame-circle
```

Restart HA → **Developer Tools → States** should now show `sensor.todo_xp_due_today`, `sensor.todo_xp_level`, etc.

---

## 3. Commands

```yaml
rest_command:
  todo_xp_complete_instance:
    url: "https://todo.rboskind.com/api/v1/instances/{{ instance_id }}/complete"
    method: post
    headers:
      Authorization: !secret todo_xp_token
    timeout: 10

  todo_xp_skip_instance:
    url: "https://todo.rboskind.com/api/v1/instances/{{ instance_id }}/skip"
    method: post
    headers:
      Authorization: !secret todo_xp_token
    timeout: 10

  todo_xp_snooze_instance:
    url: "https://todo.rboskind.com/api/v1/instances/{{ instance_id }}/snooze"
    method: post
    headers:
      Authorization: !secret todo_xp_token
      Content-Type: application/json
    payload: '{ "hours": {{ hours | default(1) }} }'
    timeout: 10

  todo_xp_create_task:
    url: "https://todo.rboskind.com/api/v1/tasks"
    method: post
    headers:
      Authorization: !secret todo_xp_token
      Content-Type: application/json
    payload: >-
      { "title": "{{ title }}",
        "notes": {{ notes | default('null') }},
        "difficulty": "{{ difficulty | default('medium') }}",
        "recurrence": {{ recurrence | default('null') }},
        "timeOfDay": {{ time_of_day | default('null') }},
        "someday": {{ someday | default(false) | lower }} }
    timeout: 30
```

Call them from a script, automation, or the UI:

```yaml
# Example: physical button → complete the top-due instance via an automation
service: rest_command.todo_xp_complete_instance
data:
  instance_id: "{{ (states('sensor.todo_xp_due_today_instances') | from_json)[0].instanceId }}"
```

---

## 4. "What's due today" as a list

The scalar `sensor.todo_xp_due_today` is just a count. For the full list (so a Lovelace card can render individual tasks), declare a second REST integration whose state is the raw JSON:

```yaml
rest:
  - resource: https://todo.rboskind.com/api/v1/today
    scan_interval: 300
    headers:
      Authorization: !secret todo_xp_token
    sensor:
      - name: "Todo XP Today List"
        unique_id: todo_xp_today_list
        # Keep the full payload small enough to live in state; HA truncates > 255 chars
        # so expose it as attributes.
        value_template: "{{ value_json.data | length }}"
        json_attributes_path: "$.data"
        json_attributes:
          - "[*]"
```

Then in Lovelace, use a `markdown` card:

```yaml
type: markdown
content: |
  ## Today ({{ states('sensor.todo_xp_due_today') }})
  {% for t in state_attr('sensor.todo_xp_today_list', '[*]') or [] %}
  - **{{ t.title }}** — {{ t.difficulty }} ({{ t.xpOverride or '?' }} XP)
  {% endfor %}
```

---

## 5. Automations worth building

- **Smart lights dim at 22:00 if `sensor.todo_xp_due_today > 0`** → visible nudge.
- **Daily 07:55 TTS: "N tasks due today, current streak X days"** via the level + streak sensors.
- **On `sensor.todo_xp_streak` drop (gap day detected)**: send a motivating push via a different channel.
- **Physical button in the kitchen → `rest_command.todo_xp_complete_instance`** on the first due instance so you can mark "took meds" hands-free.

---

## 6. Troubleshooting

- **401 Unauthorized** — check the secret includes the literal `Bearer ` prefix. HA's `rest:` passes headers verbatim.
- **404 on `/api/v1/instances/<id>/complete`** — the instance id is a UUID that changes each time a task materializes a new instance. Always pull the current id from `sensor.todo_xp_today_list`'s attributes, don't hard-code.
- **Stale counts** — default `scan_interval` is 300s. Drop to 60s if you want snappier dashboards, but don't go below 30s to be polite to the server.
- **Revoke + rotate** — `/settings` → Revoke button. Mint a new token, update `secrets.yaml`, `ha core restart`. Old token goes 401 immediately.
