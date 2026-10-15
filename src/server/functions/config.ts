import { createServerFn } from '@tanstack/react-start'
import { isLlmConfigured } from '../llm/scoreTask'
import { isWhisperConfigured } from '../llm/transcribe'

export const getLlmStatus = createServerFn({ method: 'GET' }).handler(
  async (): Promise<{ enabled: boolean }> => {
    return { enabled: isLlmConfigured() }
  },
)

// Gates the microphone button: no Whisper endpoint configured, no button.
export const getVoiceStatus = createServerFn({ method: 'GET' }).handler(
  async (): Promise<{ enabled: boolean }> => {
    return { enabled: isWhisperConfigured() && isLlmConfigured() }
  },
)
