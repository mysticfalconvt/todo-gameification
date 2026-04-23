import { createServerFn } from '@tanstack/react-start'
import { authMiddleware } from '../middleware/auth'
import { adminMiddleware } from '../middleware/admin'
import * as service from '../services/wordle'

export const startWordleGame = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const word = await service.pickWordForUser(context.userId)
    if (!word) throw new Error('No wordle words available yet')
    return { word }
  })

export const listWordleWords = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .handler(() => service.listWords())

export const addWordleWords = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .inputValidator((data: { raw: string }) => data)
  .handler(({ data, context }) => service.addWords(data.raw, context.userId))

export const removeWordleWord = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .inputValidator((data: { word: string }) => data)
  .handler(({ data }) => service.removeWord(data.word))
