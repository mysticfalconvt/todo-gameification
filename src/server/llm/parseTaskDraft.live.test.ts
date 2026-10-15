// Prompt-tuning harness. Hits the real LLM, so it is opt-in:
//
//   LLM_LIVE_TEST=1 LLM_BASE_URL=... LLM_MODEL=... pnpm vitest run src/server/llm/parseTaskDraft.live.test.ts
//
// It asserts only that every utterance parses — the point is the printed
// table, which is what you read when changing SYSTEM_PROMPT. Expect ~4s per
// utterance against gpt-oss-120b.
import { describe, expect, it } from 'vitest'
import { resolveVoiceWhen } from '../../domain/voiceWhen'
import { parseTaskDraft } from './parseTaskDraft'

const TZ = 'America/New_York'
const NOW = new Date('2026-10-08T13:00:00Z') // Thursday 09:00 EDT

const CASES = [
  'I need to mow the lawn on Tuesday afternoon',
  'I need to take out the trash tomorrow',
  'remind me to call the dentist next Friday at 3:30',
  'water the plants every Tuesday and Thursday',
  'change the furnace filter on the 15th of every month',
  'take the bins out every Wednesday evening',
  'I should clean the gutters in two weeks',
  'pay the mortgage the first Monday of every month',
  'check the smoke alarms every six months',
  'book flights for the trip',
  'vacuum the house every other Tuesday',
  'pick up the kids from soccer at 5:30 tomorrow, the back gate code is 4455',
  'in two hours remind me to move the laundry over',
  'water the garden every 3 days',
  'descale the coffee machine two weeks after I finish it',
  'put the bins out tonight',
]

const LIVE = process.env.LLM_LIVE_TEST === '1'

describe.skipIf(!LIVE)('live parse against the configured LLM', () => {
  it('parses a spread of real utterances', async () => {
    const rows: string[] = []
    for (const transcript of CASES) {
      const t0 = Date.now()
      const draft = await parseTaskDraft({ transcript, timeZone: TZ, now: NOW, userId: 'live' })
      const ms = Date.now() - t0
      expect(draft, `no draft for "${transcript}"`).not.toBeNull()
      if (!draft) continue
      let due = 'none'
      try {
        const r = resolveVoiceWhen(draft.when, NOW, TZ)
        due = r.dueAtOverride
          ? `${new Date(r.dueAtOverride).toISOString()} tod=${r.timeOfDay ?? '-'}`
          : 'someday'
      } catch (e) {
        due = `RESOLVE THREW: ${(e as Error).message}`
      }
      rows.push(
        [
          `"${transcript}"`,
          `   title:  ${draft.title}`,
          `   notes:  ${draft.notes ?? '-'}`,
          `   when:   ${JSON.stringify(draft.when)}`,
          `   repeat: ${JSON.stringify(draft.recurrence)}`,
          `   due:    ${due}   (${ms}ms)`,
        ].join('\n'),
      )
    }
    console.log(`\n${rows.join('\n\n')}\n`)
    expect(rows.length).toBe(CASES.length)
  }, 300_000)
})
