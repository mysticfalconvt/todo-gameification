import { useState } from 'react'
import { Link, createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import {
  getCommunityGardenFn,
  getGardenFn,
} from '../../server/functions/garden'
import type { GardenPlant } from '../../server/services/garden'
import type {
  CommunityGardenEntry,
  CommunityGardenScope,
} from '../../server/services/communityGarden'

export const Route = createFileRoute('/_authenticated/garden')({
  component: GardenPage,
})

// One species per category, resolved from the category slug. Built-in
// slugs have explicit picks; custom slugs deterministically hash onto
// the same species list so any user's garden stays varied. The eight
// growth stages run seed → grove; late stages repeat emoji at times
// (emoji palette is limited) but milestone decorations keep the card
// visually fresh past `lush`.
type Species =
  | 'tree'
  | 'sunflower'
  | 'bamboo'
  | 'cactus'
  | 'tulip'
  | 'daisy'
  | 'lotus'
  | 'generic'

const BUILTIN_SPECIES: Record<string, Species> = {
  home: 'tree',
  health: 'cactus',
  work: 'bamboo',
  admin: 'lotus',
  social: 'sunflower',
  errands: 'daisy',
  'self-care': 'tulip',
  other: 'generic',
}

const FALLBACK_SPECIES: Species[] = [
  'tree',
  'sunflower',
  'bamboo',
  'cactus',
  'tulip',
  'daisy',
  'lotus',
]

function pickSpecies(slug: string | null): Species {
  if (!slug) return 'generic'
  if (BUILTIN_SPECIES[slug]) return BUILTIN_SPECIES[slug]
  // Tiny deterministic hash → species index so custom categories stay
  // consistent across renders.
  let h = 0
  for (let i = 0; i < slug.length; i++) {
    h = (h * 31 + slug.charCodeAt(i)) | 0
  }
  return FALLBACK_SPECIES[Math.abs(h) % FALLBACK_SPECIES.length]
}

type Stage = GardenPlant['stage']

const SPECIES_EMOJI: Record<Species, Record<Stage, string>> = {
  tree: {
    seed: '🪴',
    sprout: '🌱',
    young: '🌿',
    mature: '🌳',
    blooming: '🌳',
    lush: '🌳',
    ancient: '🌲',
    grove: '🌴',
  },
  sunflower: {
    seed: '🪴',
    sprout: '🌱',
    young: '🌿',
    mature: '🌼',
    blooming: '🌻',
    lush: '🌻',
    ancient: '🌻',
    grove: '🌻',
  },
  bamboo: {
    seed: '🪴',
    sprout: '🌱',
    young: '🌱',
    mature: '🎋',
    blooming: '🎋',
    lush: '🎋',
    ancient: '🎋',
    grove: '🎋',
  },
  cactus: {
    seed: '🪴',
    sprout: '🌱',
    young: '🌵',
    mature: '🌵',
    blooming: '🌺',
    lush: '🌺',
    ancient: '🌵',
    grove: '🌵',
  },
  tulip: {
    seed: '🪴',
    sprout: '🌱',
    young: '🌿',
    mature: '🌷',
    blooming: '🌷',
    lush: '💐',
    ancient: '💐',
    grove: '💐',
  },
  daisy: {
    seed: '🪴',
    sprout: '🌱',
    young: '🌿',
    mature: '🌼',
    blooming: '🌼',
    lush: '🌸',
    ancient: '🌸',
    grove: '🌸',
  },
  lotus: {
    seed: '🪴',
    sprout: '🌱',
    young: '🌿',
    mature: '🪷',
    blooming: '🪷',
    lush: '🪷',
    ancient: '🪷',
    grove: '🪸',
  },
  generic: {
    seed: '🪴',
    sprout: '🌱',
    young: '🌿',
    mature: '🌿',
    blooming: '🌷',
    lush: '🌳',
    ancient: '🌳',
    grove: '🌴',
  },
}

const SPECIES_LABEL: Record<Species, string> = {
  tree: 'Tree',
  sunflower: 'Sunflower',
  bamboo: 'Bamboo',
  cactus: 'Cactus',
  tulip: 'Tulip',
  daisy: 'Daisy',
  lotus: 'Lotus',
  generic: 'Sapling',
}

const STAGE_LABEL: Record<Stage, string> = {
  seed: 'Seedling',
  sprout: 'Sprout',
  young: 'Young',
  mature: 'Mature',
  blooming: 'Blooming',
  lush: 'Lush',
  ancient: 'Ancient',
  grove: 'Grove',
}

// Scale the emoji visibly per stage so the garden reads at a glance.
const STAGE_TEXT_SIZE: Record<Stage, string> = {
  seed: 'text-4xl',
  sprout: 'text-5xl',
  young: 'text-6xl',
  mature: 'text-6xl',
  blooming: 'text-7xl',
  lush: 'text-7xl',
  ancient: 'text-7xl',
  grove: 'text-8xl',
}

const DECORATION_EMOJI: Record<GardenPlant['decorations'][number], string> = {
  butterfly: '🦋',
  bee: '🐝',
  bird: '🐦',
  sparkle: '✨',
}

const DECORATION_AT: Record<GardenPlant['decorations'][number], string> = {
  butterfly: 'top-1 left-2',
  bee: 'top-3 right-2',
  bird: 'bottom-3 left-3',
  sparkle: 'bottom-1 right-1',
}

const MOOD_LABEL: Record<GardenPlant['mood'], string> = {
  thriving: 'Thriving',
  perky: 'Perky',
  content: 'Content',
  thirsty: 'Thirsty',
  wilting: 'Wilting',
  parched: 'Parched',
  dormant: 'Dormant',
}

const MOOD_HINT: Record<GardenPlant['mood'], string> = {
  thriving: 'Freshly watered. Glowing.',
  perky: 'Watered recently. Happy.',
  content: 'Doing fine. A visit soon would help.',
  thirsty: 'Getting dry — time for a watering.',
  wilting: "Hasn't been watered in a week — any completion revives it.",
  parched: 'Severely dry. One small task will bring it back.',
  dormant: 'Complete a task in this category to plant a seed.',
}

// Single-glyph mood indicator for the community card (and the corner
// of the Yours card). Keeps cards scannable without a row of text.
const MOOD_ICON: Record<GardenPlant['mood'], string> = {
  thriving: '✨',
  perky: '💚',
  content: '🙂',
  thirsty: '💧',
  wilting: '🥀',
  parched: '🍂',
  dormant: '💤',
}

// Faded / grayscale treatment intensifies as the plant dries out.
const MOOD_VISUAL: Record<GardenPlant['mood'], string> = {
  thriving: '',
  perky: '',
  content: 'opacity-95',
  thirsty: 'opacity-85',
  wilting: 'grayscale opacity-70',
  parched: 'grayscale opacity-55',
  dormant: 'opacity-40',
}

type Tab = 'yours' | 'community'

function GardenPage() {
  const [tab, setTab] = useState<Tab>('yours')
  return (
    <main className="page-wrap space-y-6 px-4 py-8">
      <header>
        <p className="island-kicker mb-1">Garden</p>
        <h1 className="display-title text-4xl font-bold text-[var(--sea-ink)]">
          {tab === 'yours' ? 'Your progress, growing' : 'The community garden'}
        </h1>
        <p className="mt-2 text-sm text-[var(--sea-ink-soft)]">
          {tab === 'yours'
            ? 'Every task you complete waters a plant in its category. Consistency makes them bloom.'
            : "Plants from other people who've chosen to share their garden. Tap a plant to visit their profile."}
        </p>
      </header>

      <nav
        role="tablist"
        aria-label="Garden view"
        className="island-shell inline-flex gap-1 rounded-full p-1"
      >
        <TabButton active={tab === 'yours'} onClick={() => setTab('yours')}>
          Yours
        </TabButton>
        <TabButton
          active={tab === 'community'}
          onClick={() => setTab('community')}
        >
          Community
        </TabButton>
      </nav>

      {tab === 'yours' ? <YoursPanel /> : <CommunityPanel />}
    </main>
  )
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={[
        'rounded-full px-4 py-1.5 text-sm font-semibold transition',
        active
          ? 'bg-[var(--btn-primary-bg)] text-[var(--btn-primary-fg)]'
          : 'text-[var(--sea-ink-soft)] hover:text-[var(--sea-ink)]',
      ].join(' ')}
    >
      {children}
    </button>
  )
}

function YoursPanel() {
  const query = useQuery({
    queryKey: ['garden'],
    queryFn: () => getGardenFn(),
  })

  const data = query.data
  const plants = Array.isArray(data?.plants) ? data.plants : []

  if (query.isLoading) {
    return <p className="text-[var(--sea-ink-soft)]">Loading…</p>
  }

  if (plants.length === 0) {
    return (
      <section className="island-shell rounded-2xl p-8 text-center">
        <div className="mb-2 text-6xl" aria-hidden>
          🪴
        </div>
        <h2 className="mb-2 text-lg font-bold text-[var(--sea-ink)]">
          An empty pot, waiting
        </h2>
        <p className="text-sm text-[var(--sea-ink-soft)]">
          Complete a task and its category will sprout here.
        </p>
      </section>
    )
  }

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {plants.map((p) => (
          <PlantCard key={p.key} plant={p} />
        ))}
      </div>
      <p className="text-center text-xs text-[var(--sea-ink-soft)]">
        {data?.activePlantCount ?? 0} plant
        {(data?.activePlantCount ?? 0) === 1 ? '' : 's'} ·{' '}
        {data?.totalWaterings ?? 0} total waterings
      </p>
    </>
  )
}

function CommunityPanel() {
  const [scope, setScope] = useState<CommunityGardenScope>('friends')
  const query = useQuery({
    queryKey: ['community-garden', scope],
    queryFn: () => getCommunityGardenFn({ data: { scope } }),
  })
  const entries = query.data?.entries ?? []

  return (
    <section className="space-y-4">
      <div
        role="tablist"
        aria-label="Community scope"
        className="island-shell inline-flex gap-1 rounded-full p-1"
      >
        <TabButton active={scope === 'friends'} onClick={() => setScope('friends')}>
          Friends
        </TabButton>
        <TabButton active={scope === 'global'} onClick={() => setScope('global')}>
          Global
        </TabButton>
      </div>

      {query.isLoading ? (
        <p className="text-[var(--sea-ink-soft)]">Loading…</p>
      ) : entries.length === 0 ? (
        <section className="island-shell rounded-2xl p-8 text-center">
          <div className="mb-2 text-6xl" aria-hidden>
            🌱
          </div>
          <h2 className="mb-2 text-lg font-bold text-[var(--sea-ink)]">
            {scope === 'friends'
              ? 'No friends are sharing gardens yet'
              : 'No public gardens yet'}
          </h2>
          <p className="text-sm text-[var(--sea-ink-soft)]">
            {scope === 'friends'
              ? 'Ask a friend to set their garden to public or friends-only in Settings.'
              : 'When people set their garden to public, their plants appear here.'}
          </p>
        </section>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
            {entries.map((e) => (
              <CommunityPlantCard
                key={`${e.userId}:${e.plant.key}`}
                entry={e}
              />
            ))}
          </div>
          <p className="text-center text-xs text-[var(--sea-ink-soft)]">
            {query.data?.userCount ?? 0} gardener
            {(query.data?.userCount ?? 0) === 1 ? '' : 's'} ·{' '}
            {query.data?.totalWaterings ?? 0} total waterings
          </p>
        </>
      )}
    </section>
  )
}

function CommunityPlantCard({ entry }: { entry: CommunityGardenEntry }) {
  const { plant: p, handle, name } = entry
  const species = pickSpecies(p.categorySlug)
  const emoji = SPECIES_EMOJI[species][p.stage]
  return (
    <Link
      to="/u/$handle"
      params={{ handle }}
      className="island-shell relative block overflow-hidden rounded-xl p-2 no-underline transition hover:shadow-md"
      style={{ borderColor: p.color, borderTopWidth: 3 }}
      aria-label={`${name} (@${handle}) · ${p.label} · ${MOOD_LABEL[p.mood]}`}
      title={`${p.label} · ${SPECIES_LABEL[species]} · ${STAGE_LABEL[p.stage]} · ${MOOD_LABEL[p.mood]}`}
    >
      <span
        className="pointer-events-none absolute right-1.5 top-1.5 text-sm"
        aria-hidden
      >
        {MOOD_ICON[p.mood]}
      </span>
      <div className="mb-0.5 truncate pr-5 text-[11px] font-semibold text-[var(--sea-ink-soft)]">
        @{handle}
      </div>
      <div
        className={`relative flex min-h-[3.5rem] items-center justify-center text-4xl ${MOOD_VISUAL[p.mood]}`}
        aria-hidden
      >
        {emoji}
        {p.decorations.map((d) => (
          <span
            key={d}
            className={`pointer-events-none absolute ${DECORATION_AT[d]} text-sm`}
            aria-hidden
          >
            {DECORATION_EMOJI[d]}
          </span>
        ))}
      </div>
      <div className="mt-1 flex items-baseline justify-between gap-1 text-[11px]">
        <span
          className="truncate font-semibold text-[var(--sea-ink)]"
          style={{ color: p.color }}
        >
          {p.label}
        </span>
        <span className="whitespace-nowrap tabular-nums text-[var(--sea-ink-soft)]">
          {p.waterings}🪴 · {p.currentStreak}d
        </span>
      </div>
    </Link>
  )
}

function PlantCard({ plant: p }: { plant: GardenPlant }) {
  const species = pickSpecies(p.categorySlug)
  const emoji = SPECIES_EMOJI[species][p.stage]
  return (
    <section
      className="island-shell relative overflow-hidden rounded-2xl p-4"
      style={{
        borderColor: p.color,
        borderTopWidth: 4,
      }}
    >
      <span
        className="pointer-events-none absolute right-2 top-2 text-lg"
        aria-hidden
        title={MOOD_LABEL[p.mood]}
      >
        {MOOD_ICON[p.mood]}
      </span>
      <div
        className={`relative flex min-h-[6rem] items-center justify-center ${STAGE_TEXT_SIZE[p.stage]} ${MOOD_VISUAL[p.mood]}`}
        aria-hidden
        title={`${SPECIES_LABEL[species]} · ${STAGE_LABEL[p.stage]}`}
      >
        {emoji}
        {p.decorations.map((d) => (
          <span
            key={d}
            className={`pointer-events-none absolute ${DECORATION_AT[d]} text-xl`}
            aria-hidden
            title={d}
          >
            {DECORATION_EMOJI[d]}
          </span>
        ))}
      </div>
      <header className="mb-2 flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-bold text-[var(--sea-ink)]">{p.label}</h2>
        <span
          className="rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
          style={{ backgroundColor: `${p.color}22`, color: p.color }}
        >
          {SPECIES_LABEL[species]} · {STAGE_LABEL[p.stage]}
        </span>
      </header>
      <dl className="grid grid-cols-3 gap-2 text-center text-xs text-[var(--sea-ink-soft)]">
        <div>
          <dt className="uppercase tracking-wide">Waters</dt>
          <dd className="text-base font-semibold text-[var(--sea-ink)]">
            {p.waterings}
          </dd>
        </div>
        <div>
          <dt className="uppercase tracking-wide">Streak</dt>
          <dd className="text-base font-semibold text-[var(--sea-ink)]">
            {p.currentStreak}d
          </dd>
        </div>
        <div>
          <dt className="uppercase tracking-wide">Best</dt>
          <dd className="text-base font-semibold text-[var(--sea-ink)]">
            {p.longestStreak}d
          </dd>
        </div>
      </dl>
      <p className="mt-3 text-center text-[11px] text-[var(--sea-ink-soft)]">
        <span className="font-semibold">{MOOD_LABEL[p.mood]}.</span>{' '}
        {MOOD_HINT[p.mood]}
      </p>
    </section>
  )
}
