import { describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { db } from '../db/client'
import { events, households, householdMembers } from '../db/schema'
import { withTestUser, withTestUsers } from '../../test/helpers'
import {
  assignKidXp,
  completeInstance,
  createTask,
  deleteTask,
  getProgression,
  listAllTasks,
  listTodayInstances,
  updateTask,
} from './tasks'

// Happy-path contract tests for src/server/services/tasks.ts. These run
// against the dev DB (isolated per-test via testuser_<random> IDs). Any
// drift between the service's returned shape and what the Start server
// fns / REST routes delegate to would show up here.

describe('tasks service', () => {
  it('createTask inserts a task + first instance, returns id', async () => {
    await withTestUser(async (u) => {
      const r = await createTask(u.id, {
        title: 'Write tests',
        difficulty: 'medium',
        recurrence: null,
        timeOfDay: null,
        someday: false,
      })
      expect(r.id).toBeTruthy()
      const all = await listAllTasks(u.id)
      expect(all).toHaveLength(1)
      expect(all[0].title).toBe('Write tests')
      expect(all[0].visibility).toBe('friends') // default
    })
  })

  it('createTask rejects empty title', async () => {
    await withTestUser(async (u) => {
      await expect(
        createTask(u.id, {
          title: '   ',
          difficulty: 'medium',
          recurrence: null,
          timeOfDay: null,
          someday: false,
        }),
      ).rejects.toThrow(/title is required/)
    })
  })

  it('createTask rejects invalid difficulty', async () => {
    await withTestUser(async (u) => {
      await expect(
        createTask(u.id, {
          title: 'bad diff',
          // @ts-expect-error — deliberate invalid input
          difficulty: 'epic',
          recurrence: null,
          timeOfDay: null,
          someday: false,
        }),
      ).rejects.toThrow(/invalid difficulty/)
    })
  })

  it('createTask accepts and round-trips visibility', async () => {
    await withTestUser(async (u) => {
      const r = await createTask(u.id, {
        title: 'Secret chore',
        difficulty: 'small',
        recurrence: null,
        timeOfDay: null,
        someday: false,
        visibility: 'private',
      })
      const all = await listAllTasks(u.id)
      expect(all.find((t) => t.id === r.id)?.visibility).toBe('private')
    })
  })

  it('updateTask patches title + notes + visibility', async () => {
    await withTestUser(async (u) => {
      const r = await createTask(u.id, {
        title: 'old title',
        difficulty: 'medium',
        recurrence: null,
        timeOfDay: null,
        someday: false,
      })
      await updateTask(u.id, {
        taskId: r.id,
        title: 'new title',
        notes: 'some notes',
        difficulty: 'medium',
        recurrence: null,
        timeOfDay: null,
        visibility: 'public',
      })
      const all = await listAllTasks(u.id)
      const t = all.find((x) => x.id === r.id)!
      expect(t.title).toBe('new title')
      expect(t.notes).toBe('some notes')
      expect(t.visibility).toBe('public')
    })
  })

  it('updateTask rejects updating a task owned by a different user', async () => {
    await withTestUser(async (u1) => {
      const r = await createTask(u1.id, {
        title: 'mine',
        difficulty: 'medium',
        recurrence: null,
        timeOfDay: null,
        someday: false,
      })
      await withTestUser(async (u2) => {
        await expect(
          updateTask(u2.id, {
            taskId: r.id,
            title: 'stolen',
            notes: null,
            difficulty: 'medium',
            recurrence: null,
            timeOfDay: null,
          }),
        ).rejects.toThrow(/not found/)
      })
    })
  })

  it('deleteTask soft-deletes (active=false) and hides from list', async () => {
    await withTestUser(async (u) => {
      const r = await createTask(u.id, {
        title: 'goodbye',
        difficulty: 'small',
        recurrence: null,
        timeOfDay: null,
        someday: false,
      })
      await deleteTask(u.id, r.id)
      const all = await listAllTasks(u.id)
      expect(all.find((t) => t.id === r.id)).toBeUndefined()
    })
  })

  it('completeInstance bumps XP and streak; progression reflects it', async () => {
    await withTestUser(async (u) => {
      const r = await createTask(u.id, {
        title: 'Brush teeth',
        difficulty: 'small',
        recurrence: null,
        timeOfDay: null,
        someday: false,
      })
      // Fetch the auto-created instance via listTodayInstances.
      const today = await listTodayInstances(u.id)
      const inst = today.find((i) => i.taskId === r.id)
      expect(inst).toBeTruthy()
      await completeInstance(u.id, inst!.instanceId)
      const p = await getProgression(u.id)
      expect(p.xp).toBeGreaterThan(0)
      expect(p.currentStreak).toBe(1)
      expect(p.longestStreak).toBeGreaterThanOrEqual(1)
    })
  })

  it('getProgression returns zero-state for a new user', async () => {
    await withTestUser(async (u) => {
      const p = await getProgression(u.id)
      expect(p).toEqual({
        xp: 0,
        level: 1,
        currentStreak: 0,
        longestStreak: 0,
        tokens: 0,
      })
    })
  })

  it('listTodayInstances filters to the calling user only', async () => {
    await withTestUser(async (a) => {
      await createTask(a.id, {
        title: 'A task',
        difficulty: 'small',
        recurrence: null,
        timeOfDay: null,
        someday: false,
      })
      await withTestUser(async (b) => {
        const aToday = await listTodayInstances(a.id)
        const bToday = await listTodayInstances(b.id)
        expect(aToday).toHaveLength(1)
        expect(bToday).toHaveLength(0)
      })
    })
  })
})

// Set up a household with the given roles and run `fn`. Tears down the
// household (cascades to members) before user cleanup, since
// households.created_by_user_id is ON DELETE RESTRICT.
async function withHousehold(
  roles: Array<'admin' | 'member' | 'kid'>,
  fn: (
    users: { id: string; handle: string }[],
    householdId: string,
  ) => Promise<void>,
): Promise<void> {
  await withTestUsers(roles.length, async (users) => {
    const [hh] = await db
      .insert(households)
      .values({ name: 'Test House', createdByUserId: users[0].id })
      .returning({ id: households.id })
    await db.insert(householdMembers).values(
      users.map((u, i) => ({
        householdId: hh.id,
        userId: u.id,
        role: roles[i],
      })),
    )
    try {
      await fn(users, hh.id)
    } finally {
      await db.delete(households).where(eq(households.id, hh.id))
    }
  })
}

describe('assignKidXp', () => {
  it('awards XP to a kid as a completed-chore event', async () => {
    await withHousehold(['admin', 'kid'], async ([admin, kid]) => {
      const res = await assignKidXp(admin.id, { kidUserId: kid.id, xp: 25 })
      expect(res.xpAwarded).toBeGreaterThanOrEqual(25)
      expect(res.newXp).toBe(res.xpAwarded)

      const prog = await getProgression(kid.id)
      expect(prog.xp).toBe(res.newXp)

      const rows = await db
        .select()
        .from(events)
        .where(
          and(eq(events.userId, kid.id), eq(events.type, 'task.completed')),
        )
      expect(rows).toHaveLength(1)
    })
  })

  it('rejects assignment by a kid', async () => {
    await withHousehold(['admin', 'kid'], async ([, kid]) => {
      await expect(
        assignKidXp(kid.id, { kidUserId: kid.id, xp: 10 }),
      ).rejects.toThrow(/admins and members/)
    })
  })

  it('rejects assigning to a non-kid member', async () => {
    await withHousehold(['admin', 'member'], async ([admin, member]) => {
      await expect(
        assignKidXp(admin.id, { kidUserId: member.id, xp: 10 }),
      ).rejects.toThrow(/only be assigned to kids/i)
    })
  })

  it('rejects out-of-range XP', async () => {
    await withHousehold(['admin', 'kid'], async ([admin, kid]) => {
      await expect(
        assignKidXp(admin.id, { kidUserId: kid.id, xp: 0 }),
      ).rejects.toThrow(/between 1 and 1000/)
      await expect(
        assignKidXp(admin.id, { kidUserId: kid.id, xp: 5000 }),
      ).rejects.toThrow(/between 1 and 1000/)
    })
  })
})
