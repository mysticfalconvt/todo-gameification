// MCP tool definitions. Each tool takes a `userId` (threaded in by the
// transport's auth layer) plus its own args, and delegates to the same
// services the REST API and Start server functions use. No new logic here —
// just Zod schemas and a thin translation from {args} → service call.
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import * as tasks from '../services/tasks'

function jsonResult(data: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  }
}

const difficulty = z.enum(['small', 'medium', 'large'])

const recurrenceSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('daily') }),
  z.object({
    type: z.literal('weekly'),
    daysOfWeek: z.array(z.number().int().min(0).max(6)),
  }),
  z.object({ type: z.literal('interval'), days: z.number().int().positive() }),
  z.object({
    type: z.literal('after_completion'),
    days: z.number().int().positive(),
  }),
])

export function registerTools(server: McpServer, getUserId: () => string) {
  server.registerTool(
    'list_today',
    {
      title: "List today's tasks",
      description:
        "Returns open task instances due within the next ~36 hours for the authenticated user. Each item has an instanceId you can pass to complete/skip/snooze tools.",
      inputSchema: {},
    },
    async () => jsonResult(await tasks.listTodayInstances(getUserId())),
  )

  server.registerTool(
    'list_someday',
    {
      title: 'List someday tasks',
      description:
        'Returns undated open task instances (no deadline). Useful when the user says "what could I work on".',
      inputSchema: {},
    },
    async () => jsonResult(await tasks.listSomedayInstances(getUserId())),
  )

  server.registerTool(
    'list_tasks',
    {
      title: 'List all active tasks',
      description:
        'Returns every active task (including someday), with recurrence and snooze state. Not limited to what is due.',
      inputSchema: {},
    },
    async () => jsonResult(await tasks.listAllTasks(getUserId())),
  )

  server.registerTool(
    'get_task',
    {
      title: 'Get task detail',
      description: 'Fetch full detail for a single task by id.',
      inputSchema: { taskId: z.string().uuid() },
    },
    async ({ taskId }) =>
      jsonResult(await tasks.getTask(getUserId(), taskId)),
  )

  server.registerTool(
    'create_task',
    {
      title: 'Create a task',
      description:
        'Create a new task. For someday tasks pass someday=true and omit recurrence/timeOfDay. Difficulty is a hint — the backend LLM may re-score.',
      inputSchema: {
        title: z.string().min(1).max(200),
        notes: z.string().nullable().optional(),
        difficulty: difficulty.default('medium'),
        recurrence: recurrenceSchema.nullable().default(null),
        timeOfDay: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable().default(null),
        someday: z.boolean().default(false),
      },
    },
    async (args) =>
      jsonResult(
        await tasks.createTask(getUserId(), {
          title: args.title,
          notes: args.notes ?? null,
          difficulty: args.difficulty,
          recurrence: args.recurrence,
          timeOfDay: args.timeOfDay,
          someday: args.someday,
        }),
      ),
  )

  server.registerTool(
    'complete_instance',
    {
      title: 'Complete a task instance',
      description:
        'Mark an instance done. Writes a task.completed event, updates progression (XP, streak), and materializes the next instance for recurring tasks. Returns the updated progression.',
      inputSchema: { instanceId: z.string().uuid() },
    },
    async ({ instanceId }) =>
      jsonResult(await tasks.completeInstance(getUserId(), instanceId)),
  )

  server.registerTool(
    'skip_instance',
    {
      title: 'Skip a task instance',
      description:
        "Skip this occurrence without completing it. Records a task.skipped event, does NOT grant XP, but materializes the next instance if the task recurs.",
      inputSchema: { instanceId: z.string().uuid() },
    },
    async ({ instanceId }) =>
      jsonResult(await tasks.skipInstance(getUserId(), instanceId)),
  )

  server.registerTool(
    'snooze_instance',
    {
      title: 'Snooze a task instance',
      description:
        'Hide a single instance from Today for N hours. When the snooze elapses, the instance reappears.',
      inputSchema: {
        instanceId: z.string().uuid(),
        hours: z.number().positive().max(24 * 30),
      },
    },
    async ({ instanceId, hours }) =>
      jsonResult(await tasks.snoozeInstance(getUserId(), instanceId, hours)),
  )

  server.registerTool(
    'snooze_task',
    {
      title: 'Long-snooze a task (task-level)',
      description:
        'Hide an entire task (and stop reminders) until the given ISO timestamp. Pass until=null to un-snooze.',
      inputSchema: {
        taskId: z.string().uuid(),
        until: z.string().datetime().nullable(),
      },
    },
    async ({ taskId, until }) =>
      jsonResult(await tasks.snoozeTask(getUserId(), taskId, until)),
  )

  server.registerTool(
    'delete_task',
    {
      title: 'Delete a task',
      description:
        'Soft-delete a task (active=false). Existing instances stop surfacing and no new ones are materialized.',
      inputSchema: { taskId: z.string().uuid() },
    },
    async ({ taskId }) =>
      jsonResult(await tasks.deleteTask(getUserId(), taskId)),
  )

  server.registerTool(
    'get_progression',
    {
      title: 'Get XP / level / streak',
      description:
        "Returns the user's current progression: XP, level, current streak, longest streak.",
      inputSchema: {},
    },
    async () => jsonResult(await tasks.getProgression(getUserId())),
  )

  server.registerTool(
    'list_recent_activity',
    {
      title: 'Days with completions (last 8d)',
      description:
        "Returns an array of ISO dates (YYYY-MM-DD, in user's local timezone) from the last ~8 days on which the user completed at least one task.",
      inputSchema: {},
    },
    async () => jsonResult(await tasks.listRecentActivity(getUserId())),
  )
}
