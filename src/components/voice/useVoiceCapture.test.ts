import { describe, expect, it } from 'vitest'
import { describeStartFailure } from './useVoiceCapture'

describe('describeStartFailure', () => {
  it('stays silent when the user cancelled', () => {
    expect(describeStartFailure(new Error('cancelled'))).toBeNull()
  })

  it('explains how to fix a blocked microphone', () => {
    for (const name of ['NotAllowedError', 'SecurityError']) {
      const message = describeStartFailure(new DOMException('denied', name))
      expect(message).toContain('Microphone access is blocked')
    }
  })

  it('falls back to a generic message for other failures', () => {
    expect(describeStartFailure(new DOMException('no device', 'NotFoundError'))).toBe(
      'Could not start recording.',
    )
    expect(describeStartFailure(new Error('boom'))).toBe('Could not start recording.')
    expect(describeStartFailure('a string')).toBe('Could not start recording.')
    expect(describeStartFailure(undefined)).toBe('Could not start recording.')
  })
})
