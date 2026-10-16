import { describe, expect, it } from 'vitest'
import {
  concatSamples,
  downsample,
  encodeWav,
  normalize,
  newTake,
  observeLevel,
  rms,
  shouldStop,
  speechThreshold,
  TARGET_SAMPLE_RATE,
} from './audio-recorder'

const readAscii = (view: DataView, offset: number, length: number) =>
  Array.from({ length }, (_, i) => String.fromCharCode(view.getUint8(offset + i))).join('')

describe('rms', () => {
  it('is zero for silence and 1 for full-scale', () => {
    expect(rms(new Float32Array(128))).toBe(0)
    expect(rms(new Float32Array(64).fill(1))).toBeCloseTo(1, 5)
    expect(rms(new Float32Array([]))).toBe(0)
  })

  it('ignores sign', () => {
    expect(rms(new Float32Array([-0.5, 0.5, -0.5, 0.5]))).toBeCloseTo(0.5, 5)
  })
})

describe('downsample', () => {
  it('passes through when already at the target rate', () => {
    const input = new Float32Array([0.1, 0.2, 0.3])
    expect(downsample(input, TARGET_SAMPLE_RATE)).toBe(input)
  })

  it('box-averages an integer ratio (48k -> 16k)', () => {
    // Ratio 3: each output is the mean of three inputs.
    const input = new Float32Array([0, 0.3, 0.6, 1, 1, 1])
    const out = downsample(input, 48_000)
    expect(out.length).toBe(2)
    expect(out[0]).toBeCloseTo(0.3, 5)
    expect(out[1]).toBeCloseTo(1, 5)
  })

  it('interpolates a non-integer ratio (44.1k -> 16k)', () => {
    const input = new Float32Array(441).map((_, i) => i / 441)
    const out = downsample(input, 44_100)
    expect(out.length).toBe(160)
    expect(out[0]).toBeCloseTo(0, 3)
    // Monotonic ramp stays monotonic through interpolation.
    for (let i = 1; i < out.length; i++) expect(out[i]).toBeGreaterThan(out[i - 1])
  })

  it('preserves a constant signal at any rate', () => {
    const flat = new Float32Array(960).fill(0.42)
    for (const rate of [48_000, 44_100, 32_000]) {
      const out = downsample(flat, rate)
      expect(out.length).toBeGreaterThan(0)
      for (const v of out) expect(v).toBeCloseTo(0.42, 4)
    }
  })

  it('handles an empty buffer', () => {
    expect(downsample(new Float32Array(0), 48_000).length).toBe(0)
  })
})

describe('encodeWav', () => {
  it('writes a valid 16-bit mono PCM header', async () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1, -1])
    const buffer = await encodeWav(samples, TARGET_SAMPLE_RATE).arrayBuffer()
    const view = new DataView(buffer)

    expect(readAscii(view, 0, 4)).toBe('RIFF')
    expect(readAscii(view, 8, 4)).toBe('WAVE')
    expect(readAscii(view, 12, 4)).toBe('fmt ')
    expect(view.getUint32(16, true)).toBe(16) // PCM chunk size
    expect(view.getUint16(20, true)).toBe(1) // PCM
    expect(view.getUint16(22, true)).toBe(1) // mono
    expect(view.getUint32(24, true)).toBe(TARGET_SAMPLE_RATE)
    expect(view.getUint32(28, true)).toBe(TARGET_SAMPLE_RATE * 2) // byte rate
    expect(view.getUint16(32, true)).toBe(2) // block align
    expect(view.getUint16(34, true)).toBe(16) // bits
    expect(readAscii(view, 36, 4)).toBe('data')
    expect(view.getUint32(40, true)).toBe(samples.length * 2)
    expect(buffer.byteLength).toBe(44 + samples.length * 2)
  })

  it('clamps and scales samples to int16', async () => {
    const buffer = await encodeWav(new Float32Array([0, 1, -1, 2, -2]), 16_000).arrayBuffer()
    const view = new DataView(buffer)
    expect(view.getInt16(44, true)).toBe(0)
    expect(view.getInt16(46, true)).toBe(32767)
    expect(view.getInt16(48, true)).toBe(-32768)
    // Out-of-range input must clamp, not wrap to the opposite sign.
    expect(view.getInt16(50, true)).toBe(32767)
    expect(view.getInt16(52, true)).toBe(-32768)
  })

  it('produces the documented byte size for a 10s take', async () => {
    // 10s of 16kHz 16-bit mono ~= 320KB, the figure the docs quote.
    const blob = encodeWav(new Float32Array(TARGET_SAMPLE_RATE * 10), TARGET_SAMPLE_RATE)
    expect(blob.size).toBeCloseTo(320_044, -3)
    expect(blob.type).toBe('audio/wav')
  })
})

describe('concatSamples', () => {
  it('joins chunks in order', () => {
    const out = concatSamples([
      new Float32Array([1, 2]),
      new Float32Array([]),
      new Float32Array([3]),
    ])
    expect(Array.from(out)).toEqual([1, 2, 3])
  })

  it('returns empty for no chunks', () => {
    expect(concatSamples([]).length).toBe(0)
  })
})

describe('normalize', () => {
  const peakOf = (s: Float32Array) => s.reduce((m, v) => Math.max(m, Math.abs(v)), 0)

  it('lifts a quiet take to full scale', () => {
    // A quiet-but-normal mic: peak sample ~0.03 (peak block RMS is several
    // times smaller than peak sample, so this is the shape of the laptop
    // that measured peakRms 0.0058).
    const quiet = new Float32Array([0.03, -0.02, 0.01, -0.03])
    const { samples, gain } = normalize(quiet)
    expect(gain).toBeCloseTo(30, 1)
    expect(peakOf(samples)).toBeCloseTo(0.9, 3)
  })

  it('still lifts an extremely quiet take as far as the cap allows', () => {
    // Below ~0.015 peak the gain cap binds before full scale is reached.
    // 60x of 0.006 is 0.36 — far more intelligible than the original, and
    // the cap is what stops room noise being amplified to full scale.
    const veryQuiet = new Float32Array([0.006, -0.004, 0.002, -0.006])
    const { samples, gain } = normalize(veryQuiet)
    expect(gain).toBe(60)
    expect(peakOf(samples)).toBeCloseTo(0.36, 2)
  })

  it('never amplifies past the gain cap', () => {
    // Pure near-silence must not be blown up into full-scale noise.
    const nearSilent = new Float32Array([0.0001, -0.0001])
    const { gain, samples } = normalize(nearSilent)
    expect(gain).toBe(60)
    expect(peakOf(samples)).toBeLessThan(0.9)
  })

  it('leaves an already-loud take alone', () => {
    const loud = new Float32Array([0.95, -0.9, 0.5])
    const { samples, gain } = normalize(loud)
    expect(gain).toBe(1)
    expect(samples).toBe(loud)
  })

  it('does not clip', () => {
    const { samples } = normalize(new Float32Array([0.3, -0.45, 0.2]))
    expect(peakOf(samples)).toBeLessThanOrEqual(1)
  })

  it('handles digital silence and empty input without dividing by zero', () => {
    const silence = new Float32Array(16)
    expect(normalize(silence).gain).toBe(1)
    expect(normalize(new Float32Array(0)).gain).toBe(1)
  })

  it('preserves waveform shape', () => {
    const wave = new Float32Array([0.01, -0.02, 0.005, -0.01])
    const { samples, gain } = normalize(wave)
    for (let i = 0; i < wave.length; i++) {
      expect(samples[i]).toBeCloseTo(wave[i] * gain, 6)
    }
  })
})

describe('speechThreshold', () => {
  it('sits well above room tone in a quiet room', () => {
    // Quiet room (noise 0.002), normal speech peaking at 0.3.
    const t = speechThreshold(0.002, 0.3)
    expect(t).toBeGreaterThan(0.002)
    expect(t).toBeLessThan(0.3)
  })

  it('rises with a noisy room so ambience does not read as speech', () => {
    const quiet = speechThreshold(0.002, 0.4)
    const noisy = speechThreshold(0.02, 0.4)
    expect(noisy).toBeGreaterThan(quiet)
    expect(noisy).toBeGreaterThan(0.02)
  })

  it('never exceeds a quarter of the loudest block', () => {
    // The rescue case: the user began talking inside the calibration
    // window, so "noise" was measured at speech level. Without the ceiling
    // the threshold would be 5x speech and auto-stop could never fire.
    const t = speechThreshold(0.4, 0.4)
    expect(t).toBeCloseTo(0.1, 5)
    expect(t).toBeLessThan(0.4)
  })

  it('honours the absolute floor in a silent room', () => {
    expect(speechThreshold(0, 0)).toBe(0.004)
    expect(speechThreshold(0, 0.3)).toBe(0.004)
  })

  it('scales with mic gain rather than assuming a level', () => {
    // Same acoustic situation, two mics 50x apart in gain: the threshold
    // should track, not stay fixed.
    const quietMic = speechThreshold(0.0004, 0.006)
    const hotMic = speechThreshold(0.02, 0.3)
    expect(hotMic).toBeGreaterThan(quietMic)
    expect(quietMic).toBeLessThan(0.006)
  })
})

describe('auto-stop', () => {
  // Drive a take as the worklet would: a level every 2.7ms from t=0.
  const run = (
    levelAt: (ms: number) => number,
    untilMs: number,
  ): { stoppedAt: number | null; take: ReturnType<typeof newTake> } => {
    const take = newTake(0)
    for (let ms = 0; ms <= untilMs; ms += 2.7) {
      observeLevel(take, levelAt(ms), ms)
      if (shouldStop(take, ms)) return { stoppedAt: ms, take }
    }
    return { stoppedAt: null, take }
  }

  const ROOM = 0.002
  const SPEECH = 0.3

  it('stops ~2s after speech ends', () => {
    // Room tone, 1s of speech from 0.5s, then silence.
    const { stoppedAt, take } = run((ms) => (ms >= 500 && ms < 1500 ? SPEECH : ROOM), 10_000)
    expect(take.heardSpeech).toBe(true)
    expect(stoppedAt).not.toBeNull()
    expect(stoppedAt as number).toBeGreaterThan(3_000)
    expect(stoppedAt as number).toBeLessThan(3_800)
  })

  it('does not stop while speech continues', () => {
    const { stoppedAt } = run((ms) => (ms < 400 ? ROOM : SPEECH), 10_000)
    expect(stoppedAt).toBeNull()
  })

  it('does not cut off a slow start', () => {
    // Four seconds of silence before the first word — longer than the
    // trailing-silence window — must not end the take.
    const { stoppedAt, take } = run((ms) => (ms >= 4_000 ? SPEECH : ROOM), 5_000)
    expect(stoppedAt).toBeNull()
    expect(take.heardSpeech).toBe(true)
  })

  it('treats steady room tone as silence, not speech', () => {
    // The bug this replaced: a fixed 0.0015 floor meant ambience kept the
    // take alive forever on a normal mic.
    const { take } = run(() => ROOM, 5_000)
    expect(take.heardSpeech).toBe(false)
  })

  it('still works on a mic 50x quieter', () => {
    const { stoppedAt, take } = run((ms) => (ms >= 500 && ms < 1500 ? 0.006 : 0.00004), 10_000)
    expect(take.heardSpeech).toBe(true)
    expect(stoppedAt).not.toBeNull()
  })

  it('stops a take that is never spoken into at the hard cap', () => {
    const { stoppedAt } = run(() => ROOM, 31_000)
    expect(stoppedAt).toBeGreaterThan(30_000)
  })

  it('rescues a take where speech began inside the calibration window', () => {
    // "Noise" is measured at speech level here; the SPEECH_FRACTION ceiling
    // is what keeps the threshold reachable.
    const { stoppedAt, take } = run((ms) => (ms < 1_200 ? SPEECH : ROOM), 10_000)
    expect(take.heardSpeech).toBe(true)
    expect(stoppedAt).not.toBeNull()
  })
})
