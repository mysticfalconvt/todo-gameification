// Microphone entry point for dictating a task.
//
// Hides itself entirely when voice isn't available — no Whisper endpoint
// configured, or a browser without AudioContext/getUserMedia — matching how
// the other LLM-backed features degrade. All the state lives in
// useVoiceCapture; this file is the rendering.
import { useQuery } from '@tanstack/react-query'
import { isRecordingSupported } from '../../lib/audio-recorder'
import { getVoiceStatus } from '../../server/functions/config'
import { useVoiceCapture, type VoicePhase } from './useVoiceCapture'
import { VoiceReviewSheet } from './VoiceReviewSheet'

const ARIA_LABEL: Record<VoicePhase, string> = {
  idle: 'Add a task by voice',
  recording: 'Stop recording',
  working: 'Processing your recording',
}

function MicButton({
  phase,
  level,
  onToggle,
}: {
  phase: VoicePhase
  level: number
  onToggle: () => void
}) {
  const recording = phase === 'recording'
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={phase === 'working'}
      aria-label={ARIA_LABEL[phase]}
      title="Add a task by voice"
      className="relative inline-flex h-9 w-9 shrink-0 self-center items-center justify-center rounded-full sm:h-10 sm:w-10 border border-[rgba(50,143,151,0.3)] bg-[rgba(79,184,178,0.14)] text-[var(--lagoon-deep)] transition disabled:opacity-60"
    >
      <span
        aria-hidden
        className="absolute inset-0 rounded-full bg-[var(--lagoon)] transition-transform"
        // Pulses with the mic level while recording, invisible otherwise.
        style={{
          opacity: recording ? 0.3 : 0,
          transform: `scale(${1 + Math.min(level, 1) * 0.5})`,
        }}
      />
      <span aria-hidden className="relative">
        {phase === 'working' ? <Spinner /> : <MicIcon recording={recording} />}
      </span>
    </button>
  )
}

// Voice needs both halves: a configured Whisper endpoint on the server and a
// browser that can actually capture audio.
function useVoiceAvailable(): boolean {
  const statusQuery = useQuery({
    queryKey: ['voice-status'],
    queryFn: () => getVoiceStatus(),
    staleTime: 5 * 60_000,
  })
  return statusQuery.data?.enabled === true && isRecordingSupported()
}

export function VoiceCaptureButton() {
  const capture = useVoiceCapture()
  const available = useVoiceAvailable()

  if (!available) return null

  return (
    <>
      <MicButton phase={capture.phase} level={capture.level} onToggle={capture.toggle} />
      {/* Visual feedback is the pulsing halo + stop icon; this is for
          screen readers, and keeps the component safe to drop into any
          layout without the text reflowing it. */}
      <p role="status" className="sr-only">
        {capture.phase === 'recording' ? 'Listening — tap to stop' : ''}
      </p>
      <VoiceReviewSheet
        draft={capture.draft}
        transcript={capture.transcript}
        degraded={capture.degraded}
        onClose={capture.dismiss}
      />
    </>
  )
}

function MicIcon({ recording }: { recording: boolean }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    >
      <title>{recording ? 'Recording' : 'Microphone'}</title>
      {recording ? (
        <rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none" />
      ) : (
        <>
          <rect x="9" y="2" width="6" height="11" rx="3" />
          <path d="M5 11a7 7 0 0 0 14 0" />
          <path d="M12 18v3" />
        </>
      )}
    </svg>
  )
}

function Spinner() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" className="animate-spin">
      <title>Working</title>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" opacity="0.25" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}
