import { createServerFn } from '@tanstack/react-start'
import { isLlmConfigured } from '../llm/scoreTask'

export const getLlmStatus = createServerFn({ method: 'GET' }).handler(
  async (): Promise<{ enabled: boolean }> => {
    return { enabled: isLlmConfigured() }
  },
)
