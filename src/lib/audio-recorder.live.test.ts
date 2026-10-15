// Proves the browser-side audio path produces something Whisper accepts,
// without needing a browser. Opt-in:
//
//   WHISPER_LIVE_TEST=1 WHISPER_BASE_URL=... WHISPER_TEST_WAV=... \
//     pnpm vitest run src/lib/audio-recorder.live.test.ts
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { transcribeAudio } from '../server/llm/transcribe'
import { downsample, encodeWav, TARGET_SAMPLE_RATE } from './audio-recorder'

const LIVE = process.env.WHISPER_LIVE_TEST === '1'

/** Read a 16-bit mono PCM WAV into floats. */
function decodeWav(buffer: Buffer): { samples: Float32Array; sampleRate: number } {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  const sampleRate = view.getUint32(24, true)
  const count = (buffer.byteLength - 44) / 2
  const samples = new Float32Array(count)
  for (let i = 0; i < count; i++) samples[i] = view.getInt16(44 + i * 2, true) / 32768
  return { samples, sampleRate }
}

/** Nearest-neighbour upsample, standing in for a 48kHz capture device. */
function upsample(samples: Float32Array, factor: number): Float32Array {
  const out = new Float32Array(samples.length * factor)
  for (let i = 0; i < out.length; i++) out[i] = samples[Math.floor(i / factor)]
  return out
}

describe.skipIf(!LIVE)('recorder output is transcribable', () => {
  it('survives a 48kHz capture -> downsample -> encodeWav round trip', async () => {
    const original = decodeWav(await readFile(process.env.WHISPER_TEST_WAV ?? ''))
    expect(original.sampleRate).toBe(TARGET_SAMPLE_RATE)

    // Pretend the mic gave us 48kHz, then run the real client-side path.
    const asCaptured = upsample(original.samples, 3)
    const reduced = downsample(asCaptured, 48_000)
    expect(Math.abs(reduced.length - original.samples.length)).toBeLessThan(4)

    const wav = encodeWav(reduced, TARGET_SAMPLE_RATE)
    const audio = new Uint8Array(await wav.arrayBuffer())
    const { text } = await transcribeAudio({ audio, mimeType: 'audio/wav', userId: 'live' })

    console.log(`\n  encoded ${audio.byteLength} bytes -> ${text}\n`)
    expect(text?.toLowerCase()).toContain('ask not what your country')
  }, 120_000)
})
