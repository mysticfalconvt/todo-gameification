// Sudoku puzzle source.
//
// One verified base puzzle (the classic Wikipedia example, 30 clues, known
// to be uniquely solvable). At pick time we apply transformations that
// preserve both Sudoku validity and uniqueness:
//   - digit permutation (relabel 1..9 → a random permutation)
//   - row swap within each band, column swap within each stack
//   - band swap (rows 0-2 ↔ 3-5 ↔ 6-8), stack swap (same for columns)
// That gives effectively infinite variants from a tiny data footprint.
//
// Difficulty:
//   - 'hard' uses the base puzzle as-is (~30 clues)
//   - 'easy' reveals 10 extra solution cells, taking the clue count to ~40

const BASE_PUZZLE =
  '53..7....' +
  '6..195...' +
  '.98....6.' +
  '8...6...3' +
  '4..8.3..1' +
  '7...2...6' +
  '.6....28.' +
  '...419..5' +
  '....8..79'

const BASE_SOLUTION =
  '534678912' +
  '672195348' +
  '198342567' +
  '859761423' +
  '426853791' +
  '713924856' +
  '961537284' +
  '287419635' +
  '345286179'

const EASY_EXTRA_CLUES = 10

function shuffled<T>(arr: readonly T[]): T[] {
  const out = arr.slice()
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

function digitPermutation(): Record<string, string> {
  const targets = shuffled(['1', '2', '3', '4', '5', '6', '7', '8', '9'])
  const map: Record<string, string> = {}
  const sources = ['1', '2', '3', '4', '5', '6', '7', '8', '9']
  for (let i = 0; i < 9; i++) map[sources[i]] = targets[i]
  map['.'] = '.'
  return map
}

function mapDigits(grid: string, perm: Record<string, string>): string {
  let out = ''
  for (let i = 0; i < grid.length; i++) out += perm[grid[i]] ?? grid[i]
  return out
}

function rowsOf(grid: string): string[] {
  const rows: string[] = []
  for (let r = 0; r < 9; r++) rows.push(grid.slice(r * 9, r * 9 + 9))
  return rows
}

function fromRows(rows: string[]): string {
  return rows.join('')
}

function permuteRows(grid: string, rowOrder: number[]): string {
  const rows = rowsOf(grid)
  return rowOrder.map((r) => rows[r]).join('')
}

function permuteCols(grid: string, colOrder: number[]): string {
  const rows = rowsOf(grid)
  const out: string[] = []
  for (const row of rows) {
    let nr = ''
    for (const c of colOrder) nr += row[c]
    out.push(nr)
  }
  return fromRows(out)
}

function randomRowOrder(): number[] {
  // Shuffle rows within each band (0-2, 3-5, 6-8), then shuffle bands.
  const band0 = shuffled([0, 1, 2])
  const band1 = shuffled([3, 4, 5])
  const band2 = shuffled([6, 7, 8])
  const bandOrder = shuffled([band0, band1, band2])
  return bandOrder.flat()
}

function randomColOrder(): number[] {
  const stack0 = shuffled([0, 1, 2])
  const stack1 = shuffled([3, 4, 5])
  const stack2 = shuffled([6, 7, 8])
  const stackOrder = shuffled([stack0, stack1, stack2])
  return stackOrder.flat()
}

function transform(
  puzzle: string,
  solution: string,
): { puzzle: string; solution: string } {
  const perm = digitPermutation()
  let p = mapDigits(puzzle, perm)
  let s = mapDigits(solution, perm)
  const rowOrder = randomRowOrder()
  p = permuteRows(p, rowOrder)
  s = permuteRows(s, rowOrder)
  const colOrder = randomColOrder()
  p = permuteCols(p, colOrder)
  s = permuteCols(s, colOrder)
  return { puzzle: p, solution: s }
}

export interface PuzzlePair {
  puzzle: string
  solution: string
}

export function pickRandomPuzzle(difficulty: 'easy' | 'hard'): PuzzlePair {
  const { puzzle, solution } = transform(BASE_PUZZLE, BASE_SOLUTION)
  if (difficulty === 'hard') return { puzzle, solution }

  // Easy: reveal extra cells from the solution to lower the clue density.
  const blanks: number[] = []
  for (let i = 0; i < puzzle.length; i++) {
    if (puzzle[i] === '.') blanks.push(i)
  }
  const extras = new Set(shuffled(blanks).slice(0, EASY_EXTRA_CLUES))
  let easy = ''
  for (let i = 0; i < puzzle.length; i++) {
    easy += extras.has(i) ? solution[i] : puzzle[i]
  }
  return { puzzle: easy, solution }
}
