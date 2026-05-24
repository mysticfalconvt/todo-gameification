export type Board = (number | null)[][]

export function parseBoard(s: string): Board {
  const out: Board = []
  for (let r = 0; r < 9; r++) {
    const row: (number | null)[] = []
    for (let c = 0; c < 9; c++) {
      const ch = s[r * 9 + c]
      row.push(ch === '.' ? null : Number(ch))
    }
    out.push(row)
  }
  return out
}

export function givenMask(puzzle: string): boolean[][] {
  const out: boolean[][] = []
  for (let r = 0; r < 9; r++) {
    const row: boolean[] = []
    for (let c = 0; c < 9; c++) {
      row.push(puzzle[r * 9 + c] !== '.')
    }
    out.push(row)
  }
  return out
}

export function solutionDigitAt(solution: string, row: number, col: number): number {
  return Number(solution[row * 9 + col])
}

export function boardIsComplete(board: Board): boolean {
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      if (board[r][c] === null) return false
    }
  }
  return true
}

export function isPeer(rA: number, cA: number, rB: number, cB: number): boolean {
  if (rA === rB && cA === cB) return false
  if (rA === rB || cA === cB) return true
  return Math.floor(rA / 3) === Math.floor(rB / 3) &&
    Math.floor(cA / 3) === Math.floor(cB / 3)
}
