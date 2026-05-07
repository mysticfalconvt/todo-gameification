// Pure grid generator for the Word Search game. Places each word along one
// of the 8 directions via random-restart backtracking, allowing crossings
// (a cell may be shared by two words if both want the same letter there).
// Words that can't be placed within `attemptsPerWord` tries are dropped —
// the game still ships a playable grid with whatever fit, and the score
// formula uses `placed.length` so no XP is owed for words that never made
// it onto the board.
//
// `buildGrid` is deterministic when given a seeded `rng`, which keeps it
// unit-testable.

export interface Placement {
  word: string
  start: { row: number; col: number }
  end: { row: number; col: number }
  dr: -1 | 0 | 1
  dc: -1 | 0 | 1
}

export interface BuildGridResult {
  grid: string[][]
  placements: Placement[]
}

const DIRS: Array<{ dr: -1 | 0 | 1; dc: -1 | 0 | 1 }> = [
  { dr: 0, dc: 1 },
  { dr: 1, dc: 0 },
  { dr: 1, dc: 1 },
  { dr: 1, dc: -1 },
  { dr: 0, dc: -1 },
  { dr: -1, dc: 0 },
  { dr: -1, dc: -1 },
  { dr: -1, dc: 1 },
]

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

export function buildGrid(
  words: string[],
  size: number,
  rng: () => number = Math.random,
  attemptsPerWord = 200,
): BuildGridResult {
  const grid: string[][] = Array.from({ length: size }, () =>
    Array.from({ length: size }, () => ''),
  )
  const placements: Placement[] = []

  // Place longest first — they're the hardest to fit. Filter anything that
  // can't possibly fit on this board.
  const sortable = words.filter((w) => w.length > 1 && w.length <= size)
  sortable.sort((a, b) => b.length - a.length)

  for (const word of sortable) {
    const place = tryPlaceWord(grid, word, size, rng, attemptsPerWord)
    if (place) {
      placements.push(place)
      writeWord(grid, word, place)
    }
  }

  // Fill empty cells with random letters.
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (grid[r][c] === '') {
        grid[r][c] = ALPHABET[Math.floor(rng() * 26)]
      }
    }
  }

  return { grid, placements }
}

function tryPlaceWord(
  grid: string[][],
  word: string,
  size: number,
  rng: () => number,
  attempts: number,
): Placement | null {
  for (let i = 0; i < attempts; i++) {
    const dir = DIRS[Math.floor(rng() * DIRS.length)]
    const row = Math.floor(rng() * size)
    const col = Math.floor(rng() * size)
    const endR = row + dir.dr * (word.length - 1)
    const endC = col + dir.dc * (word.length - 1)
    if (endR < 0 || endR >= size || endC < 0 || endC >= size) continue
    if (!fits(grid, word, row, col, dir)) continue
    return {
      word,
      start: { row, col },
      end: { row: endR, col: endC },
      dr: dir.dr,
      dc: dir.dc,
    }
  }
  return null
}

function fits(
  grid: string[][],
  word: string,
  row: number,
  col: number,
  dir: { dr: -1 | 0 | 1; dc: -1 | 0 | 1 },
): boolean {
  for (let i = 0; i < word.length; i++) {
    const r = row + dir.dr * i
    const c = col + dir.dc * i
    const existing = grid[r][c]
    if (existing !== '' && existing !== word[i]) return false
  }
  return true
}

function writeWord(grid: string[][], word: string, place: Placement): void {
  for (let i = 0; i < word.length; i++) {
    const r = place.start.row + place.dr * i
    const c = place.start.col + place.dc * i
    grid[r][c] = word[i]
  }
}
