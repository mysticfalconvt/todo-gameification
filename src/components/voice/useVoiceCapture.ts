// The voice-capture state machine, kept out of the button so the component
// stays presentational: record -> upload -> draft, plus the failure paths.
import { useCallback, useEffect, useRef, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { toast } from 'sonner'
import { blobToBase64, type RecorderHandle, startRecording } from '../../lib/audio-recorder'
import { captureVoiceTask } from '../../server/functions/voice'
import type { VoiceCaptureResult, VoiceDraft } from '../../server/services/voice'

export type VoicePhase = 'idle' | 'recording' | 'working'

const NO_SPEECH_MESSAGE = "Didn't catch that — try again a bit closer to the mic."

const DENIED_ERRORS = new Set(['NotAllowedError', 'SecurityError'])

const MIC_BLOCKED_MESSAGE =
  'Microphone access is blocked. Allow it in your browser settings to dictate tasks.'

/**
 * Toast text for a failed start, or null when the user cancelled and no
 * message is warranted. Exported for tests — the permission-denied branch is
 * impossible to reach by hand in a headless run.
 */
export function describeStartFailure(err: unknown): string | null {
  if (err instanceof Error && err.message === 'cancelled') return null
  const denied = err instanceof DOMException && DENIED_ERRORS.has(err.name)
  return denied ? MIC_BLOCKED_MESSAGE : 'Could not start recording.'
}

export interface VoiceCapture {
  phase: VoicePhase
  /** 0..1, for the level meter. */
  level: number
  draft: VoiceDraft | null
  transcript: string | null
  /** Speech was captured but the parse failed. */
  degraded: boolean
  toggle: () => void
  dismiss: () => void
}

export function useVoiceCapture(): VoiceCapture {
  const [phase, setPhase] = useState<VoicePhase>('idle')
  const [level, setLevel] = useState(0)
  const [draft, setDraft] = useState<VoiceDraft | null>(null)
  const [transcript, setTranscript] = useState<string | null>(null)
  const [degraded, setDegraded] = useState(false)
  const recorderRef = useRef<RecorderHandle | null>(null)

  // Release the microphone if we unmount mid-take.
  useEffect(() => () => recorderRef.current?.cancel(), [])

  const applyResult = useCallback((result: VoiceCaptureResult) => {
    setPhase('idle')
    if (result.status !== 'ok') {
      console.warn(
        `[voice] ${result.status}${result.detail ? `: ${result.detail}` : ''}`,
        result.transcript,
      )
    }
    if (result.status === 'unavailable') {
      toast.error('Voice capture is offline right now.')
      return
    }
    if (!result.draft) {
      toast.message(NO_SPEECH_MESSAGE)
      return
    }
    setTranscript(result.transcript)
    setDegraded(result.status === 'parse_failed')
    setDraft(result.draft)
  }, [])

  const capture = useMutation({
    mutationFn: async (wav: Blob) =>
      captureVoiceTask({
        data: { audioBase64: await blobToBase64(wav), mimeType: 'audio/wav' },
      }),
    onSuccess: applyResult,
    onError: (err) => {
      setPhase('idle')
      toast.error(err instanceof Error ? err.message : 'Could not process that recording')
    },
  })

  const begin = useCallback(async () => {
    setPhase('recording')
    setLevel(0)
    try {
      const handle = await startRecording({ onLevel: setLevel })
      recorderRef.current = handle
      const result = await handle.done
      recorderRef.current = null
      // The level never rose enough to be speech. Whisper would happily
      // invent a task out of that, so stop rather than upload.
      if (result.silent) {
        setPhase('idle')
        toast.message(NO_SPEECH_MESSAGE)
        return
      }
      setPhase('working')
      capture.mutate(result.wav)
    } catch (err) {
      recorderRef.current = null
      setPhase('idle')
      console.warn('[voice] could not start recording', err)
      const message = describeStartFailure(err)
      if (message) toast.error(message)
    }
  }, [capture])

  const toggle = useCallback(() => {
    if (phase === 'recording') recorderRef.current?.stop()
    else if (phase === 'idle') void begin()
  }, [phase, begin])

  const dismiss = useCallback(() => {
    setDraft(null)
    setTranscript(null)
    setDegraded(false)
  }, [])

  return {
    phase: capture.isPending ? 'working' : phase,
    level,
    draft,
    transcript,
    degraded,
    toggle,
    dismiss,
  }
}
