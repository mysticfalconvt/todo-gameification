import { createServerFn } from '@tanstack/react-start'
import { authMiddleware } from '../middleware/auth'
import * as service from '../services/word-search'

export interface StartWordSearchInput {
  size: 'small' | 'large'
  // null = "Surprise me". Custom themes go through normalizeCustomTheme on
  // the server; presets pass through unchanged.
  theme: string | null
}

function validateInput(data: unknown): StartWordSearchInput {
  if (typeof data !== 'object' || data === null) {
    throw new Error('Invalid input')
  }
  const d = data as Record<string, unknown>
  if (d.size !== 'small' && d.size !== 'large') {
    throw new Error('Invalid size')
  }
  let theme: string | null = null
  if (d.theme === null || typeof d.theme === 'undefined') {
    theme = null
  } else if (typeof d.theme === 'string') {
    if (d.theme.length > 80) throw new Error('Theme too long')
    theme = d.theme
  } else {
    throw new Error('Invalid theme')
  }
  return { size: d.size, theme }
}

export const startWordSearchGame = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator(validateInput)
  .handler(async ({ data, context }) => {
    const game = await service.generateGame({
      userId: context.userId,
      size: data.size,
      theme: data.theme,
    })
    // Don't ship placements to the client — that would let inspect-element
    // reveal every answer. The client validates picks against the words
    // array directly.
    return {
      theme: game.theme,
      isCustom: game.isCustom,
      size: game.size,
      grid: game.grid,
      words: game.words,
    }
  })
