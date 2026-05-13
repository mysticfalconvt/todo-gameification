// Renders a member pill — flashy "Lifetime ✨" for lifetime, simpler
// "Member" for annual. Returns null for free / unknown so callers can
// drop it inline without guarding the call site. Annual gets an outlined
// pill so it's visibly distinct from lifetime's filled chip — both
// clearly outrank free, but the founder pill stays the prize.
//
// `size`:
//   - 'inline' (default): chip-sized, fits in nav rows / list rows.
//   - 'large': beefier, used on profile / settings headers.

interface Props {
  tier: 'free' | 'trial' | 'annual' | 'lifetime' | null | undefined
  size?: 'inline' | 'large'
  className?: string
}

export function MemberBadge({ tier, size = 'inline', className }: Props) {
  if (tier !== 'lifetime' && tier !== 'annual') return null
  const sizeClasses =
    size === 'large'
      ? 'px-3 py-1 text-xs'
      : 'px-1.5 py-0.5 text-[10px]'
  const variantClasses =
    tier === 'lifetime'
      ? 'bg-[rgba(50,143,151,0.14)] text-[var(--lagoon-deep)]'
      : 'border border-[rgba(50,143,151,0.4)] text-[var(--lagoon-deep)]'
  const label = tier === 'lifetime' ? 'Lifetime' : 'Member'
  const title = tier === 'lifetime' ? 'Lifetime member' : 'Member'
  return (
    <span
      title={title}
      aria-label={title}
      className={[
        'inline-flex items-center gap-1 rounded-full font-bold uppercase tracking-wide',
        variantClasses,
        sizeClasses,
        className ?? '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {tier === 'lifetime' ? <span aria-hidden>✨</span> : null}
      {label}
    </span>
  )
}
