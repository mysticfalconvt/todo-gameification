import { createFileRoute } from '@tanstack/react-router'
import { authedRoute, jsonOk, readJson } from '../../../../../server/api/rest'
import * as service from '../../../../../server/services/tasks'

interface CompleteBody {
  // Optional override of who receives the XP/streak. For household
  // chores: admins may credit any household member; members may credit
  // themselves or the chore's assignee; kids may only credit
  // themselves. Personal tasks reject this field entirely.
  creditUserId?: string
  // Skip the "unchecked steps" confirmation step. Existing dialog
  // behavior in the UI; surfaced here so an external dashboard can
  // force-complete a chore with checklist items.
  force?: boolean
}

// POST /api/v1/instances/:instanceId/complete
// Mark an instance done. For personal tasks, current behavior. For
// household chores, an optional `{ creditUserId }` body lets the
// caller redirect credit (subject to role-based permissions enforced
// by the service).
export const Route = createFileRoute(
  '/api/v1/instances/$instanceId/complete',
)({
  server: {
    handlers: {
      POST: authedRoute(async ({ request, userId, params }) => {
        // Body is optional — many clients will send no body at all,
        // so tolerate JSON parse failures gracefully here.
        let body: CompleteBody = {}
        if (request.headers.get('content-length')) {
          try {
            body = await readJson<CompleteBody>(request)
          } catch {
            body = {}
          }
        }
        const data = await service.completeInstance(
          userId,
          params.instanceId,
          { creditUserId: body.creditUserId, force: body.force },
        )
        return jsonOk(data)
      }),
    },
  },
})
