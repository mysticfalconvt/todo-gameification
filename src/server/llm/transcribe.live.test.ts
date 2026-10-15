// Live check against the configured Whisper server. Opt-in:
//
//   WHISPER_LIVE_TEST=1 WHISPER_BASE_URL=... pnpm vitest run src/server/llm/transcribe.live.test.ts
//
// Needs a 16kHz mono WAV at WHISPER_TEST_WAV.
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { transcribeAudio } from './transcribe'

const LIVE = process.env.WHISPER_LIVE_TEST === '1'
const WAV = process.env.WHISPER_TEST_WAV ?? ''

describe.skipIf(!LIVE)('live transcription', () => {
  it('transcribes real speech', { timeout: 120_000 }, async () => {
    const audio = new Uint8Array(await readFile(WAV))
    const t0 = Date.now()
    const { text } = await transcribeAudio({ audio, mimeType: 'audio/wav', userId: 'live' })
    console.log(`\n  bytes=${audio.byteLength}  ms=${Date.now() - t0}\n  text: ${text}\n`)
    expect(text).toBeTruthy()
    expect(text?.toLowerCase()).toContain('country')
  })

  it('returns null for silence instead of a hallucinated task', async () => {
    const silence = new Uint8Array(await readFile(process.env.WHISPER_SILENCE_WAV ?? ''))
    const { text } = await transcribeAudio({
      audio: silence,
      mimeType: 'audio/wav',
      userId: 'live',
    })
    console.log(`\n  silence -> ${JSON.stringify(text)}\n`)
    expect(text).toBeNull()
  })
})
