// Shared styling for the little left-edge color bar on household chores
// (used by both the household page and the Today list).
//
// A specific assignee gets their solid member color. Group / free-for-all
// chores get a vertical gradient blending the colors of everyone
// eligible, so "anyone" reads as a mix of the household rather than one
// flat color:
//   adults → admins + members, kids → kids, free-for-all → everyone
// (kiosks excluded — they aren't people who do chores).

export interface BarMember {
  userId: string
  role: 'admin' | 'member' | 'kid' | 'kiosk'
  color: string | null
}

export interface AssigneeBarTarget {
  assignedToUserId: string | null
  assigneeGroup: 'adults' | 'kids' | null
}

export function assigneeBarStyle(
  c: AssigneeBarTarget,
  members: BarMember[],
): { backgroundColor?: string; backgroundImage?: string } {
  if (c.assignedToUserId) {
    const col = members.find((m) => m.userId === c.assignedToUserId)?.color
    return { backgroundColor: col ?? 'var(--line)' }
  }
  const realMembers = members.filter((m) => m.role !== 'kiosk')
  const pool =
    c.assigneeGroup === 'adults'
      ? realMembers.filter((m) => m.role !== 'kid')
      : c.assigneeGroup === 'kids'
        ? realMembers.filter((m) => m.role === 'kid')
        : realMembers
  const colors = pool.map((m) => m.color).filter((x): x is string => !!x)
  if (colors.length === 0) return { backgroundColor: 'var(--line)' }
  if (colors.length === 1) return { backgroundColor: colors[0] }
  return {
    backgroundImage: `linear-gradient(to bottom, ${colors.join(', ')})`,
  }
}
