import { createServerFn } from '@tanstack/react-start'
import { authMiddleware } from '../middleware/auth'
import * as service from '../services/games'

export const listGames = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(() => service.listGames())

export const canPlay = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .inputValidator((data: { gameId: string }) => data)
  .handler(({ data, context }) => service.canPlay(context.userId, data.gameId))

export const finishGame = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator(
    (data: {
      gameId: string
      result: { won: boolean; score: number | null }
    }) => data,
  )
  .handler(({ data, context }) =>
    service.finishGame({
      userId: context.userId,
      gameId: data.gameId,
      result: data.result,
    }),
  )
