import { describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { db } from '../db/client'
import {
  events,
  households,
  householdMembers,
  progression,
  tasks,
} from '../db/schema'
import { withTestUser, withTestUsers } from '../../test/helpers'
import {
  assignKidXp,
  completeInstance,
  createTask,
  deleteTask,
  getProgression,
  listAllTasks,
  listSomedayInstances,
  listTodayInstances,
  setHouseholdChoreXp,
  setKidCompletionXp,
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

  it('crossing a streak milestone grants tokens + a freeze and reports a celebration', async () => {
    await withTestUser(async (u) => {
      const r = await createTask(u.id, {
        title: 'Meditate',
        difficulty: 'small',
        recurrence: null,
        timeOfDay: null,
        someday: false,
      })
      // Seed a 6-day streak whose last completion was ~yesterday, so this
      // completion advances to 7 (the first milestone) with gap === 1.
      await db.insert(progression).values({
        userId: u.id,
        xp: 100,
        level: 2,
        currentStreak: 6,
        longestStreak: 6,
        tokens: 0,
        streakFreezes: 0,
        lastCompletionAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      })

      const today = await listTodayInstances(u.id)
      const inst = today.find((i) => i.taskId === r.id)
      const result = await completeInstance(u.id, inst!.instanceId)

      expect('celebration' in result && result.celebration).toBeTruthy()
      if ('celebration' in result) {
        expect(result.celebration.milestone?.days).toBe(7)
        expect(result.celebration.freezesEarned).toBe(1)
      }

      const p = await getProgression(u.id)
      expect(p.currentStreak).toBe(7)
      expect(p.streakFreezes).toBe(1)
      expect(p.tokens).toBe(3) // 7-day tier bonus
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
        streakFreezes: 0,
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

describe('household someday visibility', () => {
  it('surfaces a no-due-date family task to its assignee, not just the creator', async () => {
    await withHousehold(['admin', 'admin'], async ([creator, assignee], householdId) => {
      await createTask(creator.id, {
        title: 'Take out recycling',
        difficulty: 'small',
        recurrence: null,
        timeOfDay: null,
        someday: true,
        householdId,
        assignedToUserId: assignee.id,
      })

      // The assignee (a different user than the creator) must see it in
      // their Someday list — regression for the bug where Someday keyed
      // on the creator's id and hid family tasks assigned to others.
      const assigneeSomeday = await listSomedayInstances(assignee.id)
      expect(assigneeSomeday.map((t) => t.title)).toContain('Take out recycling')

      // And it never leaked a due date (someday => null due).
      const creatorToday = await listTodayInstances(creator.id)
      expect(creatorToday.map((t) => t.title)).not.toContain('Take out recycling')
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

describe('setKidCompletionXp', () => {
  async function seedKidCompletion(adminId: string, kidId: string) {
    await assignKidXp(adminId, { kidUserId: kidId, xp: 25 })
    const [evt] = await db
      .select()
      .from(events)
      .where(
        and(eq(events.userId, kidId), eq(events.type, 'task.completed')),
      )
    return evt
  }

  it('sets an exact XP and replays progression', async () => {
    await withHousehold(['admin', 'kid'], async ([admin, kid]) => {
      const evt = await seedKidCompletion(admin.id, kid.id)
      const res = await setKidCompletionXp(admin.id, {
        eventId: evt.id,
        xp: 100,
      })
      expect(res.xp).toBe(100)
      // Only one completion, xpFinal overrides multipliers → exactly 100.
      const after = await getProgression(kid.id)
      expect(after.xp).toBe(100)
    })
  })

  it('rejects edits from a kid', async () => {
    await withHousehold(['admin', 'kid'], async ([admin, kid]) => {
      const evt = await seedKidCompletion(admin.id, kid.id)
      await expect(
        setKidCompletionXp(kid.id, { eventId: evt.id, xp: 50 }),
      ).rejects.toThrow(/admins and members/)
    })
  })

  it('rejects a completion from another household', async () => {
    await withHousehold(['admin', 'kid'], async ([admin, kid]) => {
      const evt = await seedKidCompletion(admin.id, kid.id)
      await withHousehold(['admin', 'kid'], async ([outsider]) => {
        await expect(
          setKidCompletionXp(outsider.id, { eventId: evt.id, xp: 50 }),
        ).rejects.toThrow(/not in your household/)
      })
    })
  })
})

describe('setHouseholdChoreXp', () => {
  async function seedChore(ownerId: string, householdId: string) {
    const [t] = await db
      .insert(tasks)
      .values({
        userId: ownerId,
        title: 'Read for 20 min',
        difficulty: 'medium',
        householdId,
      })
      .returning({ id: tasks.id })
    return t.id
  }

  it('sets the parent task xpOverride (future instances inherit it)', async () => {
    await withHousehold(['admin', 'kid'], async ([admin], householdId) => {
      const taskId = await seedChore(admin.id, householdId)
      const res = await setHouseholdChoreXp(admin.id, { taskId, xp: 40 })
      expect(res.xp).toBe(40)
      const row = await db.query.tasks.findFirst({
        where: eq(tasks.id, taskId),
        columns: { xpOverride: true },
      })
      expect(row?.xpOverride).toBe(40)
    })
  })

  it('clears the override when given null', async () => {
    await withHousehold(['admin', 'kid'], async ([admin], householdId) => {
      const taskId = await seedChore(admin.id, householdId)
      await setHouseholdChoreXp(admin.id, { taskId, xp: 40 })
      await setHouseholdChoreXp(admin.id, { taskId, xp: null })
      const row = await db.query.tasks.findFirst({
        where: eq(tasks.id, taskId),
        columns: { xpOverride: true },
      })
      expect(row?.xpOverride).toBeNull()
    })
  })

  it('rejects edits from a kid', async () => {
    await withHousehold(['admin', 'kid'], async ([admin, kid], householdId) => {
      const taskId = await seedChore(admin.id, householdId)
      await expect(
        setHouseholdChoreXp(kid.id, { taskId, xp: 40 }),
      ).rejects.toThrow(/permission|do not have/i)
    })
  })
})
