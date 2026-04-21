// Per-user category taxonomy. One category per task.
//
// Seeded lazily on first listCategories call — avoids needing a signup hook
// and works retroactively for any user that existed before this shipped.
import { and, eq } from 'drizzle-orm'
import { db } from '../db/client'
import { tasks, userCategories } from '../db/schema'

export interface Category {
  slug: string
  label: string
  color: string
  description: string
  sortOrder: number
}

const DESCRIPTION_MAX = 280

const DEFAULT_CATEGORIES: Category[] = [
  { slug: 'home', label: 'Home', color: '#4fb8b2', description: '', sortOrder: 0 },
  { slug: 'health', label: 'Health', color: '#e07a5f', description: '', sortOrder: 1 },
  { slug: 'work', label: 'Work', color: '#6a9bd8', description: '', sortOrder: 2 },
  { slug: 'admin', label: 'Admin', color: '#9a7fcf', description: '', sortOrder: 3 },
  { slug: 'social', label: 'Social', color: '#f2c14e', description: '', sortOrder: 4 },
  { slug: 'errands', label: 'Errands', color: '#6fab7a', description: '', sortOrder: 5 },
  { slug: 'self-care', label: 'Self-care', color: '#c187c5', description: '', sortOrder: 6 },
  { slug: 'other', label: 'Other', color: '#8f8f8f', description: '', sortOrder: 7 },
]

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/
const COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/

function slugify(label: string): string {
  return label
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

async function seedDefaults(userId: string): Promise<void> {
  await db
    .insert(userCategories)
    .values(DEFAULT_CATEGORIES.map((c) => ({ ...c, userId })))
    .onConflictDoNothing()
}

export async function listCategories(userId: string): Promise<Category[]> {
  let rows = await db.query.userCategories.findMany({
    where: eq(userCategories.userId, userId),
    orderBy: (t, { asc }) => [asc(t.sortOrder), asc(t.slug)],
  })
  if (rows.length === 0) {
    await seedDefaults(userId)
    rows = await db.query.userCategories.findMany({
      where: eq(userCategories.userId, userId),
      orderBy: (t, { asc }) => [asc(t.sortOrder), asc(t.slug)],
    })
  }
  return rows.map((r) => ({
    slug: r.slug,
    label: r.label,
    color: r.color,
    description: r.description,
    sortOrder: r.sortOrder,
  }))
}

export async function createCategory(
  userId: string,
  input: { label: string; color?: string; description?: string },
): Promise<Category> {
  const label = input.label?.trim()
  if (!label) throw new Error('label required')
  if (label.length > 40) throw new Error('label too long')
  const color = input.color?.trim() || '#8f8f8f'
  if (!COLOR_RE.test(color)) throw new Error('invalid color (use #RRGGBB)')
  const description = (input.description ?? '').trim()
  if (description.length > DESCRIPTION_MAX) throw new Error('description too long')
  const slug = slugify(label)
  if (!slug || !SLUG_RE.test(slug)) throw new Error('label produced invalid slug')

  // Ensure defaults exist first so a brand-new user who creates a custom
  // category before loading the list still gets the 8 seeds.
  await listCategories(userId)

  const existing = await db.query.userCategories.findFirst({
    where: and(
      eq(userCategories.userId, userId),
      eq(userCategories.slug, slug),
    ),
  })
  if (existing) throw new Error('category already exists')

  const max = await db.query.userCategories.findFirst({
    where: eq(userCategories.userId, userId),
    orderBy: (t, { desc }) => [desc(t.sortOrder)],
  })
  const sortOrder = (max?.sortOrder ?? -1) + 1

  const [row] = await db
    .insert(userCategories)
    .values({ userId, slug, label, color, description, sortOrder })
    .returning()
  return {
    slug: row.slug,
    label: row.label,
    color: row.color,
    description: row.description,
    sortOrder: row.sortOrder,
  }
}

export async function updateCategory(
  userId: string,
  slug: string,
  patch: { label?: string; color?: string; description?: string },
): Promise<Category> {
  if (!slug) throw new Error('slug required')
  const setValues: Record<string, unknown> = {}
  if (patch.label !== undefined) {
    const label = patch.label.trim()
    if (!label) throw new Error('label required')
    if (label.length > 40) throw new Error('label too long')
    setValues.label = label
  }
  if (patch.color !== undefined) {
    if (!COLOR_RE.test(patch.color)) throw new Error('invalid color')
    setValues.color = patch.color
  }
  if (patch.description !== undefined) {
    const description = patch.description.trim()
    if (description.length > DESCRIPTION_MAX) throw new Error('description too long')
    setValues.description = description
  }
  if (Object.keys(setValues).length === 0) {
    throw new Error('nothing to update')
  }
  const updated = await db
    .update(userCategories)
    .set(setValues)
    .where(
      and(eq(userCategories.userId, userId), eq(userCategories.slug, slug)),
    )
    .returning()
  if (updated.length === 0) throw new Error('category not found')
  const r = updated[0]
  return {
    slug: r.slug,
    label: r.label,
    color: r.color,
    description: r.description,
    sortOrder: r.sortOrder,
  }
}

export async function deleteCategory(
  userId: string,
  slug: string,
): Promise<{ slug: string; reassigned: number }> {
  if (!slug) throw new Error('slug required')
  return db.transaction(async (tx) => {
    const reassigned = await tx
      .update(tasks)
      .set({ categorySlug: null, updatedAt: new Date() })
      .where(and(eq(tasks.userId, userId), eq(tasks.categorySlug, slug)))
      .returning({ id: tasks.id })
    const removed = await tx
      .delete(userCategories)
      .where(
        and(eq(userCategories.userId, userId), eq(userCategories.slug, slug)),
      )
      .returning({ slug: userCategories.slug })
    if (removed.length === 0) throw new Error('category not found')
    return { slug: removed[0].slug, reassigned: reassigned.length }
  })
}
