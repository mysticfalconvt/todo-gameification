import { createServerFn } from '@tanstack/react-start'
import { authMiddleware } from '../middleware/auth'
import * as service from '../services/categories'
import * as taskService from '../services/tasks'

export const listCategories = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(({ context }) => service.listCategories(context.userId))

export const createCategory = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator(
    (data: { label: string; color?: string; description?: string }) => data,
  )
  .handler(({ data, context }) => service.createCategory(context.userId, data))

export const updateCategory = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator(
    (data: {
      slug: string
      label?: string
      color?: string
      description?: string
    }) => data,
  )
  .handler(({ data, context }) =>
    service.updateCategory(context.userId, data.slug, {
      label: data.label,
      color: data.color,
      description: data.description,
    }),
  )

export const deleteCategory = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator((data: { slug: string }) => data)
  .handler(({ data, context }) =>
    service.deleteCategory(context.userId, data.slug),
  )

export const countUncategorizedTasks = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(({ context }) => taskService.countUncategorizedTasks(context.userId))

export const backfillCategories = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .handler(({ context }) => taskService.backfillCategories(context.userId))
