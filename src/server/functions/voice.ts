// Thin wrapper for voice capture. Logic lives in src/server/services/voice.ts.
import { createServerFn } from '@tanstack/react-start'
import { authMiddleware } from '../middleware/auth'
import * as service from '../services/voice'

export const captureVoiceTask = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator((data: service.CaptureVoiceTaskInput) => {
    if (typeof data?.audioBase64 !== 'string' || !data.audioBase64) {
      throw new Error('audioBase64 is required')
    }
    return data
  })
  .handler(({ data, context }) => service.captureFromAudio(context.userId, data))
