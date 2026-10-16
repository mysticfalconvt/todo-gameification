// Microphone capture for voice task entry.
//
// Deliberately not MediaRecorder. One AudioContext gives us three things at
// once that MediaRecorder can't without extra plumbing:
//   1. raw PCM, so we emit exactly the 16kHz mono WAV Whisper wants and the
//      server needs no ffmpeg transcode;
//   2. a running level, for the "I can hear you" meter;
//   3. silence detection, so recording stops on its own.
// It also erases the cross-browser container problem — Android Chrome emits
// webm/opus and iOS Safari mp4/aac, and we'd otherwise have to handle both.

export const TARGET_SAMPLE_RATE = 16_000

/** Hard cap on a single utterance. */
const MAX_RECORDING_MS = 30_000

/** Stop once the level has been below the floor this long, after speech. */
const SILENCE_TAIL_MS = 2_000

/**
 * Opening window treated as room tone, to calibrate the noise floor. People
 * tap the button and then start talking, so the first moments are ambience.
 */
const CALIBRATION_MS = 350

/** Speech is taken to be this many times above the measured noise floor. */
const NOISE_MULTIPLIER = 5

/** Absolute floor, for a silent room where the noise estimate is ~0. */
const MIN_SPEECH_RMS = 0.004

/**
 * Ceiling on the speech threshold, as a fraction of the loudest block so
 * far. This is what rescues a take where the user started talking inside
 * the calibration window: the "noise" estimate is then speech-level, and
 * without this the threshold would be so high that nothing counts as
 * speech and auto-stop never fires.
 */
const SPEECH_FRACTION = 0.25

/** Throttle for the level meter callback. */
const LEVEL_REPORT_MS = 50

/**
 * Peak RMS a take must reach for us to believe anything was said at all.
 * This only has to clear a muted or disconnected input — real levelling is
 * `normalize`'s job — so it is NOT a quality threshold and must not be tuned
 * as one. Whisper still invents text for pure silence; isLikelyHallucination
 * on the server is the second layer.
 */
const MIN_PEAK_RMS = 0.0012

/** Normalised takes peak here, leaving a little headroom under clipping. */
const TARGET_PEAK = 0.9

/** Cap on normalisation gain, so near-silence isn't blown up into noise. */
const MAX_GAIN = 60

// Posts each render quantum back to the main thread. Loaded from a Blob URL
// so it needs no separately-served asset and no Vite worker config.
const WORKLET_SOURCE = `
class RecorderProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (channel && channel.length) this.port.postMessage(new Float32Array(channel))
    return true
  }
}
registerProcessor('voice-recorder', RecorderProcessor)
`

export interface RecordingResult {
  /** 16kHz mono 16-bit WAV. */
  wav: Blob
  durationMs: number
  peakRms: number
  /** True when the level never rose enough to be speech. */
  silent: boolean
}

/**
 * Level above which a block counts as speech for the auto-stop timer.
 *
 * Deliberately relative, not absolute. Mic gain varies by orders of
 * magnitude across devices — a fixed value tuned on one laptop either cuts
 * a quiet mic off mid-sentence or, on a hot one, never fires because room
 * tone already clears it.
 */
export function speechThreshold(noisePeak: number, peakRms: number): number {
  const fromNoise = Math.max(MIN_SPEECH_RMS, noisePeak * NOISE_MULTIPLIER)
  const ceiling = Math.max(MIN_SPEECH_RMS, peakRms * SPEECH_FRACTION)
  return Math.min(fromNoise, ceiling)
}

/** Rolling analysis of a take, driven one block at a time. */
export interface TakeState {
  startedAt: number
  /** Last moment the level cleared the speech threshold. */
  lastLoudAt: number
  /** Loudest block seen during the opening calibration window. */
  noisePeak: number
  /** Loudest block of the whole take. */
  peakRms: number
  heardSpeech: boolean
}

export function newTake(startedAt: number): TakeState {
  return { startedAt, lastLoudAt: startedAt, noisePeak: 0, peakRms: 0, heardSpeech: false }
}

/** Fold one block's level into the take. */
export function observeLevel(take: TakeState, level: number, now: number): void {
  if (level > take.peakRms) take.peakRms = level

  if (now - take.startedAt < CALIBRATION_MS) {
    // Still sampling room tone; nothing counts as speech yet, and the take
    // must not look idle while we calibrate.
    if (level > take.noisePeak) take.noisePeak = level
    take.lastLoudAt = now
    return
  }

  if (level >= speechThreshold(take.noisePeak, take.peakRms)) {
    take.lastLoudAt = now
    take.heardSpeech = true
  }
}

/**
 * Trailing silence ends a take, but only once something was actually said —
 * otherwise a slow start would cut the user off before they began. The hard
 * cap always applies.
 */
export function shouldStop(take: TakeState, now: number): boolean {
  if (take.heardSpeech && now - take.lastLoudAt > SILENCE_TAIL_MS) return true
  return now - take.startedAt > MAX_RECORDING_MS
}

export function rms(samples: Float32Array): number {
  if (samples.length === 0) return 0
  let sum = 0
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
  return Math.sqrt(sum / samples.length)
}

/**
 * Downsample to 16kHz. Integer ratios (48k and 32k, the common cases) use a
 * box average, which doubles as a crude anti-alias filter; other rates fall
 * back to linear interpolation.
 */
export function downsample(input: Float32Array, fromRate: number): Float32Array {
  if (fromRate === TARGET_SAMPLE_RATE || input.length === 0) return input
  const ratio = fromRate / TARGET_SAMPLE_RATE
  const outLength = Math.floor(input.length / ratio)
  const out = new Float32Array(outLength)

  if (Number.isInteger(ratio)) {
    const step = ratio
    for (let i = 0; i < outLength; i++) {
      let sum = 0
      const start = i * step
      for (let j = 0; j < step; j++) sum += input[start + j] ?? 0
      out[i] = sum / step
    }
    return out
  }

  for (let i = 0; i < outLength; i++) {
    const pos = i * ratio
    const lower = Math.floor(pos)
    const frac = pos - lower
    const a = input[lower] ?? 0
    const b = input[lower + 1] ?? a
    out[i] = a + (b - a) * frac
  }
  return out
}

/** Mono 16-bit PCM WAV. */
export function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)

  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
  }

  writeAscii(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  writeAscii(8, 'WAVE')
  writeAscii(12, 'fmt ')
  view.setUint32(16, 16, true) // PCM chunk size
  view.setUint16(20, 1, true) // format: PCM
  view.setUint16(22, 1, true) // channels: mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // byte rate
  view.setUint16(32, 2, true) // block align
  view.setUint16(34, 16, true) // bits per sample
  writeAscii(36, 'data')
  view.setUint32(40, samples.length * 2, true)

  let offset = 44
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true)
    offset += 2
  }
  return new Blob([buffer], { type: 'audio/wav' })
}

/**
 * Scale a take so its loudest sample sits near full scale.
 *
 * Mic input level varies by orders of magnitude across devices, and Whisper
 * transcribes a quiet signal markedly worse than a well-levelled one. Doing
 * this here means capture quality stops depending on the user's hardware
 * gain, and lets the silence gate be a bare liveness check rather than a
 * threshold that has to be right for every laptop.
 */
export function normalize(samples: Float32Array): { samples: Float32Array; gain: number } {
  let peak = 0
  for (let i = 0; i < samples.length; i++) {
    const magnitude = Math.abs(samples[i])
    if (magnitude > peak) peak = magnitude
  }
  if (peak === 0) return { samples, gain: 1 }

  const gain = Math.min(MAX_GAIN, TARGET_PEAK / peak)
  if (gain <= 1) return { samples, gain: 1 }

  const out = new Float32Array(samples.length)
  for (let i = 0; i < samples.length; i++) out[i] = samples[i] * gain
  return { samples: out, gain }
}

export function concatSamples(chunks: Float32Array[]): Float32Array {
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const out = new Float32Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

export function isRecordingSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof navigator?.mediaDevices?.getUserMedia === 'function' &&
    typeof window.AudioContext === 'function'
  )
}

export interface RecorderHandle {
  /** Resolves when recording ends — by silence, timeout, or stop(). */
  done: Promise<RecordingResult>
  stop: () => void
  cancel: () => void
}

export interface StartRecordingOptions {
  /** Called ~60x/sec with the current level, 0..1, for the meter. */
  onLevel?: (level: number) => void
}

/**
 * Opens the microphone and records until silence, the 30s cap, or stop().
 * Rejects if permission is denied — callers surface that as an explainer.
 */
export async function startRecording(options: StartRecordingOptions = {}): Promise<RecorderHandle> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  })

  // Deliberately NOT `new AudioContext({ sampleRate: 16000 })`. Forcing a
  // rate the capture device doesn't natively run at makes Chrome hand back
  // a silent MediaStreamSource rather than resampling it, which looks
  // exactly like the user saying nothing. Take whatever rate the hardware
  // gives us and resample in `downsample` on the way out.
  const context = new AudioContext()
  const workletUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'text/javascript' }))

  // Definite assignment: the Promise executor runs synchronously.
  let settle!: (result: RecordingResult) => void
  let fail!: (err: Error) => void
  const done = new Promise<RecordingResult>((resolve, reject) => {
    settle = resolve
    fail = reject
  })

  const chunks: Float32Array[] = []
  const startedAt = performance.now()
  const take = newTake(startedAt)
  let finished = false
  let lastLevelAt = 0

  const teardown = () => {
    for (const track of stream.getTracks()) track.stop()
    void context.close().catch(() => {})
    URL.revokeObjectURL(workletUrl)
  }

  const finish = () => {
    if (finished) return
    finished = true
    const durationMs = performance.now() - startedAt
    teardown()
    const captured = concatSamples(chunks)
    const reduced = downsample(captured, context.sampleRate)
    const { samples, gain } = normalize(reduced)
    const silent = take.peakRms < MIN_PEAK_RMS
    const wav = encodeWav(samples, TARGET_SAMPLE_RATE)
    // The only client-side failure that is otherwise invisible: the user
    // spoke (or thinks they did) and nothing was uploaded. Everything that
    // reaches the server is tracked in llm_call_log / /admin/llm instead.
    if (silent) {
      console.warn(
        `[voice] take rejected: peakRms=${take.peakRms.toFixed(4)} floor=${MIN_PEAK_RMS} ` +
          `gain=${gain.toFixed(1)}x samples=${captured.length}@${context.sampleRate}Hz ` +
          `${Math.round(durationMs)}ms`,
      )
    }
    settle({ wav, durationMs, peakRms: take.peakRms, silent })
  }

  try {
    // A context can start suspended depending on autoplay policy; a
    // suspended context never runs the worklet, so no audio is captured.
    if (context.state === 'suspended') await context.resume()
    await context.audioWorklet.addModule(workletUrl)
    const source = context.createMediaStreamSource(stream)
    const node = new AudioWorkletNode(context, 'voice-recorder')

    node.port.onmessage = (event: MessageEvent<Float32Array>) => {
      if (finished) return
      const block = event.data
      chunks.push(block)

      const now = performance.now()
      const level = rms(block)
      observeLevel(take, level, now)
      // The worklet posts a block every ~2.7ms; reporting each one would mean
      // ~125 React renders a second. 20/s is plenty for a level meter.
      if (now - lastLevelAt >= LEVEL_REPORT_MS) {
        lastLevelAt = now
        options.onLevel?.(Math.min(1, level * 12))
      }
      if (shouldStop(take, now)) finish()
    }

    source.connect(node)
    // Keep the graph pulling without routing mic audio back to the speakers.
    node.connect(context.destination)
  } catch (err) {
    teardown()
    fail(err instanceof Error ? err : new Error('Could not start recording'))
  }

  return {
    done,
    stop: finish,
    cancel: () => {
      if (finished) return
      finished = true
      teardown()
      fail(new Error('cancelled'))
    },
  }
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer()
  const bytes = new Uint8Array(buffer)
  let binary = ''
  // Chunked to stay clear of the argument-count limit on large recordings.
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}
