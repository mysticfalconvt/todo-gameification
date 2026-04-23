// GitHub PR reviewer integration.
//
// One provider per user, stored in `user_integrations`. We poll GitHub's
// issue-search API for `review-requested:@me is:pr is:open` and mirror
// the result into tasks (creating missing ones, auto-completing ones
// that fell off the list).
//
// Task dedup is via `tasks.external_ref = "github-pr-<prId>"` — a
// partial unique index (user_id, external_ref) keeps a second call
// from double-inserting.
//
// Token requirements: a **classic PAT** with `repo` scope. Fine-grained
// PATs return an empty result set against org private repos unless the
// org admin has explicitly enabled fine-grained tokens in org settings —
// which most orgs leave off. Classic tokens also need to be SSO-
// authorized for each org via the tokens page if SSO is enforced;
// without that, the search API silently returns 0 results.
// `review-requested:@me` only matches PRs requesting you personally, not
// PRs requesting a team you're on — add team-review-requested to the
// query if that matters later.
import { and, eq, inArray, like } from 'drizzle-orm'
import { db } from '../db/client'
import {
  taskInstances,
  tasks,
  userCategories,
  userIntegrations,
} from '../db/schema'
import { completeInstance } from './tasks'

// Prefix we write to `last_poll_error` when the failure was auth-related
// (expired / revoked token). Used to short-circuit future polls until
// the user reconnects — see `isTokenKnownBad`.
const AUTH_ERROR_PREFIX = 'AUTH: '

async function resolveCategorySlugs(
  userId: string,
  candidates: readonly string[],
): Promise<Map<string, string | null>> {
  const rows = await db
    .select({ slug: userCategories.slug })
    .from(userCategories)
    .where(
      and(
        eq(userCategories.userId, userId),
        inArray(userCategories.slug, [...candidates]),
      ),
    )
  const available = new Set(rows.map((r) => r.slug))
  return new Map(
    candidates.map((slug) => [slug, available.has(slug) ? slug : null]),
  )
}

function isTokenKnownBad(integration: {
  tokenExpiresAt: Date | null
  lastPollError: string | null
}): boolean {
  if (
    integration.tokenExpiresAt &&
    integration.tokenExpiresAt.getTime() <= Date.now()
  ) {
    return true
  }
  if (integration.lastPollError?.startsWith(AUTH_ERROR_PREFIX)) return true
  return false
}

const GITHUB_API = 'https://api.github.com'
const USER_AGENT = 'todo-gameification-integration'
const PROVIDER = 'github'

// External ref for the "renew your token" task. One per user thanks to
// the partial unique index on (user_id, external_ref).
const TOKEN_EXPIRY_REF = 'github-token-expiry'

// How far out we start nagging.
const TOKEN_EXPIRY_WARN_MS = 5 * 24 * 60 * 60 * 1000

export interface GithubIntegrationStatus {
  connected: boolean
  externalId: string | null
  pollIntervalMinutes: number
  lastPolledAt: string | null
  lastPollError: string | null
  tokenExpiresAt: string | null
}

export interface GithubReviewPr {
  prId: number
  repoFullName: string
  number: number
  title: string
  htmlUrl: string
}

interface GithubUser {
  login: string
}

interface SearchIssuesResponse {
  items: Array<{
    id: number
    number: number
    title: string
    html_url: string
    repository_url: string
    pull_request?: { url: string }
  }>
}

export class GithubAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GithubAuthError'
  }
}

interface GithubFetchResult<T> {
  data: T
  tokenExpiresAt: Date | null
}

// Parses GitHub's `github-authentication-token-expiration` header. The
// format is `YYYY-MM-DD HH:MM:SS UTC` — Date can't parse that directly,
// so we rewrite it into an ISO-ish string before handing to the parser.
// Returns null for classic PATs without expiration (no header) or for
// anything we can't parse.
function parseExpirationHeader(headerValue: string | null): Date | null {
  if (!headerValue) return null
  const trimmed = headerValue.trim()
  const normalized = trimmed.replace(' UTC', 'Z').replace(' ', 'T')
  const ms = Date.parse(normalized)
  if (Number.isNaN(ms)) return null
  return new Date(ms)
}

async function githubFetch<T>(
  token: string,
  path: string,
): Promise<GithubFetchResult<T>> {
  const res = await fetch(`${GITHUB_API}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': USER_AGENT,
    },
  })
  const expHeader = res.headers.get('github-authentication-token-expiration')
  const tokenExpiresAt = parseExpirationHeader(expHeader)
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    const message = `GitHub ${path} → ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`
    if (res.status === 401) throw new GithubAuthError(message)
    throw new Error(message)
  }
  const data = (await res.json()) as T
  return { data, tokenExpiresAt }
}

function repoFromRepositoryUrl(repositoryUrl: string): string {
  // repository_url looks like "https://api.github.com/repos/owner/name"
  const marker = '/repos/'
  const idx = repositoryUrl.indexOf(marker)
  return idx >= 0 ? repositoryUrl.slice(idx + marker.length) : repositoryUrl
}

export interface FetchGithubUserResult {
  login: string
  tokenExpiresAt: Date | null
}

export async function fetchGithubUser(
  token: string,
): Promise<FetchGithubUserResult> {
  const { data, tokenExpiresAt } = await githubFetch<GithubUser>(token, '/user')
  return { login: data.login, tokenExpiresAt }
}

export interface FetchReviewRequestedResult {
  prs: GithubReviewPr[]
  tokenExpiresAt: Date | null
}

export async function fetchReviewRequestedPrs(
  token: string,
): Promise<FetchReviewRequestedResult> {
  const q = encodeURIComponent('is:pr is:open review-requested:@me archived:false')
  const { data, tokenExpiresAt } = await githubFetch<SearchIssuesResponse>(
    token,
    `/search/issues?q=${q}&per_page=50`,
  )
  const prs = data.items
    .filter((item) => item.pull_request) // search/issues returns both; filter to PRs
    .map((item) => ({
      prId: item.id,
      repoFullName: repoFromRepositoryUrl(item.repository_url),
      number: item.number,
      title: item.title,
      htmlUrl: item.html_url,
    }))
  return { prs, tokenExpiresAt }
}

export async function getGithubIntegration(
  userId: string,
): Promise<GithubIntegrationStatus> {
  const row = await db.query.userIntegrations.findFirst({
    where: and(
      eq(userIntegrations.userId, userId),
      eq(userIntegrations.provider, PROVIDER),
    ),
  })
  if (!row) {
    return {
      connected: false,
      externalId: null,
      pollIntervalMinutes: 5,
      lastPolledAt: null,
      lastPollError: null,
      tokenExpiresAt: null,
    }
  }
  return {
    connected: true,
    externalId: row.externalId,
    pollIntervalMinutes: row.pollIntervalMinutes,
    lastPolledAt: row.lastPolledAt?.toISOString() ?? null,
    lastPollError: row.lastPollError,
    tokenExpiresAt: row.tokenExpiresAt?.toISOString() ?? null,
  }
}

export async function upsertGithubIntegration(
  userId: string,
  input: { token: string; pollIntervalMinutes?: number },
): Promise<GithubIntegrationStatus> {
  const token = input.token.trim()
  if (!token) throw new Error('token required')

  // Validate before persisting — better a wrong token fails here with a
  // clear error than quietly sitting in the DB failing every poll.
  let externalId: string
  let tokenExpiresAt: Date | null
  try {
    const me = await fetchGithubUser(token)
    externalId = me.login
    tokenExpiresAt = me.tokenExpiresAt
  } catch (err) {
    throw new Error(
      `Could not verify GitHub token: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  const pollIntervalMinutes = Math.max(
    1,
    Math.min(1440, Math.floor(input.pollIntervalMinutes ?? 5)),
  )

  await db
    .insert(userIntegrations)
    .values({
      userId,
      provider: PROVIDER,
      externalId,
      token,
      pollIntervalMinutes,
      tokenExpiresAt,
    })
    .onConflictDoUpdate({
      target: [userIntegrations.userId, userIntegrations.provider],
      set: {
        externalId,
        token,
        pollIntervalMinutes,
        tokenExpiresAt,
        lastPollError: null,
        updatedAt: new Date(),
      },
    })

  // If there's an open "renew your token" task left over from the
  // previous expiring/expired token, complete it — the user just fixed
  // it, give them the XP.
  await completeTokenExpiryTaskIfOpen(userId)

  return getGithubIntegration(userId)
}

export async function updateGithubPollInterval(
  userId: string,
  pollIntervalMinutes: number,
): Promise<GithubIntegrationStatus> {
  const minutes = Math.max(1, Math.min(1440, Math.floor(pollIntervalMinutes)))
  const result = await db
    .update(userIntegrations)
    .set({ pollIntervalMinutes: minutes, updatedAt: new Date() })
    .where(
      and(
        eq(userIntegrations.userId, userId),
        eq(userIntegrations.provider, PROVIDER),
      ),
    )
    .returning({ userId: userIntegrations.userId })
  if (result.length === 0) throw new Error('not connected')
  return getGithubIntegration(userId)
}

export async function removeGithubIntegration(userId: string): Promise<void> {
  await db
    .delete(userIntegrations)
    .where(
      and(
        eq(userIntegrations.userId, userId),
        eq(userIntegrations.provider, PROVIDER),
      ),
    )
}

export interface GithubSyncResult {
  created: number
  completed: number
  errors: string[]
}

// The workhorse. Called from the cron handler and from the "Sync now"
// button. Reads the integration row, fetches PRs, then reconciles:
// - each open PR without a task → insert task + instance
// - each existing github-task whose PR is gone → complete the instance
export async function syncReviewTasksForUser(
  userId: string,
): Promise<GithubSyncResult> {
  const integration = await db.query.userIntegrations.findFirst({
    where: and(
      eq(userIntegrations.userId, userId),
      eq(userIntegrations.provider, PROVIDER),
    ),
  })
  if (!integration) {
    return { created: 0, completed: 0, errors: ['not connected'] }
  }

  // If we already know the token is dead, don't waste an API call. The
  // user has to reconnect to re-enable polling; upsertGithubIntegration
  // clears lastPollError and writes a fresh tokenExpiresAt, which
  // naturally lifts this gate.
  if (isTokenKnownBad(integration)) {
    await ensureTokenExpiryTask(userId, integration.tokenExpiresAt).catch(
      (e) => console.error('[github] ensureTokenExpiryTask failed', e),
    )
    return { created: 0, completed: 0, errors: ['token_invalid'] }
  }

  let prs: GithubReviewPr[]
  let tokenExpiresAt: Date | null = integration.tokenExpiresAt ?? null
  try {
    const result = await fetchReviewRequestedPrs(integration.token)
    prs = result.prs
    tokenExpiresAt = result.tokenExpiresAt ?? tokenExpiresAt
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const stored =
      err instanceof GithubAuthError ? `${AUTH_ERROR_PREFIX}${message}` : message
    await db
      .update(userIntegrations)
      .set({
        lastPolledAt: new Date(),
        lastPollError: stored,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(userIntegrations.userId, userId),
          eq(userIntegrations.provider, PROVIDER),
        ),
      )
    // 401 = token revoked/expired → nudge the user with a task.
    if (err instanceof GithubAuthError) {
      await ensureTokenExpiryTask(userId, null).catch((e) =>
        console.error('[github] ensureTokenExpiryTask failed', e),
      )
    }
    return { created: 0, completed: 0, errors: [message] }
  }

  const categorySlugs = await resolveCategorySlugs(userId, ['work'])
  const prCategory = categorySlugs.get('work') ?? null

  const existing = await db
    .select({
      id: tasks.id,
      externalRef: tasks.externalRef,
      active: tasks.active,
    })
    .from(tasks)
    .where(
      and(
        eq(tasks.userId, userId),
        like(tasks.externalRef, 'github-pr-%'),
      ),
    )

  const existingByRef = new Map(
    existing.map((t) => [t.externalRef as string, t]),
  )
  const incomingRefs = new Set(prs.map((p) => `github-pr-${p.prId}`))

  const errors: string[] = []
  let created = 0
  let completed = 0

  // Create tasks for new PRs.
  for (const pr of prs) {
    const ref = `github-pr-${pr.prId}`
    if (existingByRef.has(ref)) continue
    try {
      await db.transaction(async (tx) => {
        const [task] = await tx
          .insert(tasks)
          .values({
            userId,
            title: `Review PR: ${pr.title}`,
            notes: `${pr.repoFullName}#${pr.number}\n${pr.htmlUrl}`,
            difficulty: 'medium',
            categorySlug: prCategory,
            externalRef: ref,
            visibility: 'private',
          })
          .returning({ id: tasks.id })
        await tx.insert(taskInstances).values({
          taskId: task.id,
          userId,
          dueAt: new Date(),
        })
      })
      created += 1
    } catch (err) {
      // If a concurrent poll just created this, the unique index fires —
      // that's fine, skip.
      const message = err instanceof Error ? err.message : String(err)
      if (!/tasks_user_external_ref_idx|duplicate key/i.test(message)) {
        errors.push(`create ${ref}: ${message}`)
      }
    }
  }

  // Auto-complete tasks whose PR is no longer review-requested.
  for (const [ref, task] of existingByRef) {
    if (incomingRefs.has(ref)) continue
    if (!task.active) continue
    // Find the open instance for this task (should be at most one).
    const openInstance = await db.query.taskInstances.findFirst({
      where: and(
        eq(taskInstances.taskId, task.id),
        eq(taskInstances.userId, userId),
      ),
      orderBy: (t, { desc }) => [desc(t.createdAt)],
    })
    if (!openInstance) continue
    if (openInstance.completedAt || openInstance.skippedAt) continue
    try {
      await completeInstance(userId, openInstance.id)
      completed += 1
    } catch (err) {
      errors.push(
        `complete ${ref}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  await db
    .update(userIntegrations)
    .set({
      lastPolledAt: new Date(),
      lastPollError: errors.length > 0 ? errors.join('; ').slice(0, 500) : null,
      tokenExpiresAt,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(userIntegrations.userId, userId),
        eq(userIntegrations.provider, PROVIDER),
      ),
    )

  // If the token is within the warning window, create (or keep) a task
  // nudging the user to renew. Skip if there's no expiry (no-expiration
  // classic PATs exist).
  if (tokenExpiresAt) {
    const msUntil = tokenExpiresAt.getTime() - Date.now()
    if (msUntil <= TOKEN_EXPIRY_WARN_MS) {
      await ensureTokenExpiryTask(userId, tokenExpiresAt).catch((e) =>
        console.error('[github] ensureTokenExpiryTask failed', e),
      )
    }
  }

  return { created, completed, errors }
}

// Ensures one open task with external_ref="github-token-expiry" exists
// for the user. The partial unique index makes this idempotent even
// across concurrent polls. Passing `expiresAt = null` means "already
// expired / revoked" (from a 401).
async function ensureTokenExpiryTask(
  userId: string,
  expiresAt: Date | null,
): Promise<void> {
  const existing = await db.query.tasks.findFirst({
    where: and(
      eq(tasks.userId, userId),
      eq(tasks.externalRef, TOKEN_EXPIRY_REF),
      eq(tasks.active, true),
    ),
  })
  if (existing) return

  const title = 'Renew your GitHub token'
  const notes = expiresAt
    ? `Expires ${expiresAt.toISOString().slice(0, 10)}. Open Settings → GitHub reviews → paste a fresh token.\nhttps://github.com/settings/tokens`
    : `GitHub rejected the current token (expired or revoked). Open Settings → GitHub reviews → paste a fresh token.\nhttps://github.com/settings/tokens`

  const categorySlugs = await resolveCategorySlugs(userId, ['admin'])
  const categorySlug = categorySlugs.get('admin') ?? null

  try {
    await db.transaction(async (tx) => {
      const [task] = await tx
        .insert(tasks)
        .values({
          userId,
          title,
          notes,
          difficulty: 'small',
          categorySlug,
          externalRef: TOKEN_EXPIRY_REF,
          visibility: 'private',
        })
        .returning({ id: tasks.id })
      await tx.insert(taskInstances).values({
        taskId: task.id,
        userId,
        dueAt: new Date(),
      })
    })
  } catch (err) {
    // Partial unique index fired — concurrent create, fine.
    const message = err instanceof Error ? err.message : String(err)
    if (!/tasks_user_external_ref_idx|duplicate key/i.test(message)) {
      throw err
    }
  }
}

// Called from upsertGithubIntegration on a successful reconnect: if the
// user had an open renew-your-token task, complete it and hand out the
// XP (goes through the normal completeInstance path).
async function completeTokenExpiryTaskIfOpen(userId: string): Promise<void> {
  const task = await db.query.tasks.findFirst({
    where: and(
      eq(tasks.userId, userId),
      eq(tasks.externalRef, TOKEN_EXPIRY_REF),
      eq(tasks.active, true),
    ),
  })
  if (!task) return
  const openInstance = await db.query.taskInstances.findFirst({
    where: and(
      eq(taskInstances.taskId, task.id),
      eq(taskInstances.userId, userId),
    ),
    orderBy: (t, { desc }) => [desc(t.createdAt)],
  })
  if (!openInstance) return
  if (openInstance.completedAt || openInstance.skippedAt) return
  await completeInstance(userId, openInstance.id).catch((err) => {
    console.error('[github] completeTokenExpiryTaskIfOpen failed', err)
  })
}

// Returns userIds that have a GitHub integration and whose
// last_polled_at is older than their poll_interval_minutes (or is null).
// Called from the cron handler — the cron fires every minute but per-user
// cadence is controlled here.
export async function listDueUsers(now: Date = new Date()): Promise<string[]> {
  const rows = await db
    .select({
      userId: userIntegrations.userId,
      pollIntervalMinutes: userIntegrations.pollIntervalMinutes,
      lastPolledAt: userIntegrations.lastPolledAt,
      lastPollError: userIntegrations.lastPollError,
      tokenExpiresAt: userIntegrations.tokenExpiresAt,
    })
    .from(userIntegrations)
    .where(eq(userIntegrations.provider, PROVIDER))

  return rows
    .filter((r) => {
      // Don't keep hammering a dead token. The user has to reconnect to
      // clear lastPollError + write a fresh tokenExpiresAt, which
      // naturally lifts this gate.
      if (isTokenKnownBad(r)) return false
      if (!r.lastPolledAt) return true
      const ageMs = now.getTime() - r.lastPolledAt.getTime()
      return ageMs >= r.pollIntervalMinutes * 60_000
    })
    .map((r) => r.userId)
}
