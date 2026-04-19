import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { getGardenFn } from '../../server/functions/garden'
import type { GardenPlant } from '../../server/services/garden'

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
  perky: 'Perky',
  thirsty: 'Thirsty',
  wilting: 'Wilting',
  dormant: 'Dormant',
}

const MOOD_HINT: Record<GardenPlant['mood'], string> = {
  perky: 'Watered recently. Thriving.',
  thirsty: 'Could use a visit soon.',
  wilting: "Hasn't been watered in a while — any completion revives it.",
  dormant: 'Complete a task in this category to plant a seed.',
}

function GardenPage() {
  const query = useQuery({
    queryKey: ['garden'],
    queryFn: () => getGardenFn(),
  })

  const data = query.data
  const plants = Array.isArray(data?.plants) ? data.plants : []

  return (
    <main className="page-wrap space-y-6 px-4 py-8">
      <header>
        <p className="island-kicker mb-1">Garden</p>
        <h1 className="display-title text-4xl font-bold text-[var(--sea-ink)]">
          Your progress, growing
        </h1>
        <p className="mt-2 text-sm text-[var(--sea-ink-soft)]">
          Every task you complete waters a plant in its category. Consistency
          makes them bloom.
        </p>
      </header>

      {query.isLoading ? (
        <p className="text-[var(--sea-ink-soft)]">Loading…</p>
      ) : plants.length === 0 ? (
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
      ) : (
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
      )}
    </main>
  )
}

function PlantCard({ plant: p }: { plant: GardenPlant }) {
  const moodClass: Record<GardenPlant['mood'], string> = {
    perky: '',
    thirsty: 'opacity-90',
    wilting: 'grayscale opacity-70',
    dormant: 'opacity-50',
  }
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
      <div
        className={`relative flex min-h-[6rem] items-center justify-center ${STAGE_TEXT_SIZE[p.stage]} ${moodClass[p.mood]}`}
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
