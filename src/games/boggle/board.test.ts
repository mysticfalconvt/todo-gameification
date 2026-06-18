import { describe, expect, it } from 'vitest'
import {
  BOARD_SIZE,
  CELLS,
  adjacent,
  generateBoard,
  scoreForLength,
  tileLetters,
} from './board'

describe('boggle board', () => {
  it('generates a full 4x4 board', () => {
    const board = generateBoard()
    expect(board).toHaveLength(CELLS)
    expect(CELLS).toBe(BOARD_SIZE * BOARD_SIZE)
    for (const tile of board) {
      expect(typeof tile.face).toBe('string')
      expect(tile.face.length).toBeGreaterThan(0)
    }
  })

  it('renders the Qu cube as "Qu" contributing "QU"', () => {
    // Roll many boards; the Q cube can surface "Qu". When it does, it must
    // uppercase to the two-letter "QU".
    let sawQu = false
    for (let i = 0; i < 200 && !sawQu; i++) {
      for (const tile of generateBoard()) {
        if (tile.face === 'Qu') {
          sawQu = true
          expect(tileLetters(tile)).toBe('QU')
        } else {
          expect(tileLetters(tile)).toBe(tile.face.toUpperCase())
          expect(tileLetters(tile)).toHaveLength(1)
        }
      }
    }
    expect(sawQu).toBe(true)
  })

  it('treats 8-way neighbours as adjacent and self/distant as not', () => {
    // Index layout (4x4):
    //  0  1  2  3
    //  4  5  6  7
    //  8  9 10 11
    // 12 13 14 15
    expect(adjacent(5, 5)).toBe(false) // self
    expect(adjacent(5, 6)).toBe(true) // right
    expect(adjacent(5, 1)).toBe(true) // up
    expect(adjacent(5, 0)).toBe(true) // up-left diagonal
    expect(adjacent(5, 10)).toBe(true) // down-right diagonal
    expect(adjacent(5, 7)).toBe(false) // two columns away
    expect(adjacent(3, 4)).toBe(false) // wraps row edge — not adjacent
    expect(adjacent(0, 15)).toBe(false) // opposite corners
  })

  it('scores by Boggle letter-count tiers', () => {
    expect(scoreForLength(3)).toBe(1)
    expect(scoreForLength(4)).toBe(1)
    expect(scoreForLength(5)).toBe(2)
    expect(scoreForLength(6)).toBe(3)
    expect(scoreForLength(7)).toBe(5)
    expect(scoreForLength(8)).toBe(11)
    expect(scoreForLength(12)).toBe(11)
  })
})
