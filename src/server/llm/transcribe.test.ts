import { describe, expect, it } from 'vitest'
import { isLikelyHallucination } from './transcribe'

describe('isLikelyHallucination', () => {
  // Whisper emits these for silence with high confidence, and whisper.cpp's
  // no_speech_prob does not discriminate (measured 7.9e-11 for pure silence
  // vs 1.7e-10 for real speech), so a closed list is the only server-side
  // signal available.
  it('catches the known silence artifacts', () => {
    for (const text of [
      'Thank you.',
      ' Thank you.\n',
      'thank you',
      'THANK YOU!',
      'Thanks for watching!',
      'you',
      'Bye.',
      'Okay.',
      '.',
      'Subtitles by the Amara.org community',
    ]) {
      expect(isLikelyHallucination(text), text).toBe(true)
    }
  })

  it('treats empty and whitespace as nothing said', () => {
    expect(isLikelyHallucination('')).toBe(true)
    expect(isLikelyHallucination('   \n ')).toBe(true)
    expect(isLikelyHallucination('...')).toBe(true)
  })

  it('lets real utterances through', () => {
    for (const text of [
      'I need to mow the lawn on Tuesday afternoon',
      'take out the trash tomorrow',
      'Thank you for the reminder, call Bob',
      'bye bye birdie tickets',
      'you need to call the dentist',
    ]) {
      expect(isLikelyHallucination(text), text).toBe(false)
    }
  })
})
