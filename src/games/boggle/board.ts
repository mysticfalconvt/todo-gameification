// Board generation, adjacency, and scoring for Boggle.
//
// Uses the standard 1987 16-cube Boggle set. The classic "Qu" cube face is
// kept as a single tile rendered "Qu" and contributing "QU" to a word — so
// "QU" counts as two letters for length/scoring, matching real Boggle.

// Each string is one cube; one character per face. The 'q' face is the
// special Qu tile (lowercased here only to flag it; expanded below).
const DICE: readonly string[][] = [
  ['A', 'A', 'E', 'E', 'G', 'N'],
  ['A', 'B', 'B', 'J', 'O', 'O'],
  ['A', 'C', 'H', 'O', 'P', 'S'],
  ['A', 'F', 'F', 'K', 'P', 'S'],
  ['A', 'O', 'O', 'T', 'T', 'W'],
  ['C', 'I', 'M', 'O', 'T', 'U'],
  ['D', 'E', 'I', 'L', 'R', 'X'],
  ['D', 'E', 'L', 'R', 'V', 'Y'],
  ['D', 'I', 'S', 'T', 'T', 'Y'],
  ['E', 'E', 'G', 'H', 'N', 'W'],
  ['E', 'E', 'I', 'N', 'S', 'U'],
  ['E', 'H', 'R', 'T', 'V', 'W'],
  ['E', 'I', 'O', 'S', 'S', 'T'],
  ['E', 'L', 'R', 'T', 'T', 'Y'],
  ['H', 'I', 'M', 'N', 'U', 'Qu'],
  ['H', 'L', 'N', 'N', 'R', 'Z'],
]

export const BOARD_SIZE = 4 // 4×4
const CELLS = BOARD_SIZE * BOARD_SIZE

// A tile's `face` is what to display ("A" or "Qu"). Its word contribution is
// simply face.toUpperCase() ("A" / "QU").
export type Tile = { face: string }

function shuffle<T>(arr: T[]): T[] {
  // Fisher–Yates. Math.random is fine in app/runtime code.
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

// Roll each cube to a random face, then shuffle cube positions into the grid.
export function generateBoard(): Tile[] {
  const rolled = DICE.map((faces) => ({
    face: faces[Math.floor(Math.random() * faces.length)],
  }))
  return shuffle(rolled)
}

// The string a tile contributes to a word ("A", "QU").
export function tileLetters(tile: Tile): string {
  return tile.face.toUpperCase()
}

// 8-way adjacency on the flat 0..15 index space.
export function adjacent(a: number, b: number): boolean {
  if (a === b) return false
  const ra = Math.floor(a / BOARD_SIZE)
  const ca = a % BOARD_SIZE
  const rb = Math.floor(b / BOARD_SIZE)
  const cb = b % BOARD_SIZE
  return Math.abs(ra - rb) <= 1 && Math.abs(ca - cb) <= 1
}

// Classic Boggle scoring by letter count (Qu = two letters). Words shorter
// than 3 letters are invalid and never reach this.
export function scoreForLength(len: number): number {
  if (len <= 4) return 1
  if (len === 5) return 2
  if (len === 6) return 3
  if (len === 7) return 5
  return 11 // 8+
}

export { CELLS }
