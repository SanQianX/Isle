import { describe, expect, it } from 'vitest';
import { voteTransitions, type VoteValue } from '@/server/services/vote';

/**
 * The vote state machine (DATA_API_STORAGE §2.2).
 *
 * Every cell of the published transition table is asserted, because each one is
 * a way a user can express intent from the UI: tap again to withdraw, tap the
 * other arrow to switch sides.
 */

type Row = { current: VoteValue; requested: VoteValue };

const TABLE: Array<Row & { action: string; scoreDelta: number }> = [
  { current: 0, requested: 1, action: 'insert', scoreDelta: 1 },
  { current: 1, requested: 1, action: 'keep', scoreDelta: 0 },
  { current: 1, requested: 0, action: 'delete', scoreDelta: -1 },
  { current: 1, requested: -1, action: 'insert', scoreDelta: -2 },
  { current: -1, requested: -1, action: 'keep', scoreDelta: 0 },
  { current: -1, requested: 0, action: 'delete', scoreDelta: 1 },
  { current: -1, requested: 1, action: 'insert', scoreDelta: 2 },
  { current: 0, requested: 0, action: 'keep', scoreDelta: 0 },
  { current: 0, requested: -1, action: 'insert', scoreDelta: -1 },
];

describe('voteTransitions', () => {
  it.each(TABLE)('$current -> $requested is $action with delta $scoreDelta', (row) => {
    const transition = voteTransitions(row.current, row.requested);
    expect(transition.action).toBe(row.action);
    expect(transition.scoreDelta).toBe(row.scoreDelta);
  });

  it('never persists a value of 0', () => {
    for (const current of [-1, 0, 1] as VoteValue[]) {
      for (const requested of [-1, 0, 1] as VoteValue[]) {
        expect(voteTransitions(current, requested).value).not.toBe(0);
      }
    }
  });

  it('is idempotent: replaying the same request never moves the score twice', () => {
    for (const target of [-1, 1] as VoteValue[]) {
      const first = voteTransitions(0, target);
      const replay = voteTransitions(target, target);
      expect(first.scoreDelta).toBe(1 * target);
      expect(replay.scoreDelta).toBe(0);
      expect(replay.action).toBe('keep');
    }
  });

  it('withdrawing from neutral is a no-op rather than a delete', () => {
    const transition = voteTransitions(0, 0);
    expect(transition.action).toBe('keep');
    expect(transition.scoreDelta).toBe(0);
  });

  it('switching sides always moves the score by exactly two', () => {
    expect(voteTransitions(1, -1).scoreDelta).toBe(-2);
    expect(voteTransitions(-1, 1).scoreDelta).toBe(2);
  });

  it('reproduces the same score when replayed from an empty vote table', () => {
    // Simulate the real click sequences the UI produces, then replay the same
    // gestures against a from-scratch recount of the vote rows. A visitor holds
    // exactly one current vote, so the whole sequence collapses to one value.
    const sequences: Array<Array<VoteValue>> = [
      [1],
      [1, 0],
      [1, -1],
      [-1, 1],
      [1, 1, 1],
      [1, 0, 1],
      [-1, 0, 1, -1, 0],
      [1, -1, 1, -1],
    ];

    for (const sequence of sequences) {
      let current: VoteValue = 0;
      let running = 0;

      for (const requested of sequence) {
        const transition = voteTransitions(current, requested);
        running += transition.scoreDelta;
        // A delete clears the visitor's vote; insert/keep set it.
        current = transition.action === 'delete' ? 0 : transition.value;
      }

      // The vote row for this visitor, recounted from scratch.
      const rows: VoteValue[] = current === 0 ? [] : [current];
      const recounted = rows.reduce<number>((sum, value) => sum + value, 0);

      expect(running, `sequence ${sequence.join(',')}`).toBe(recounted);
    }
  });

  it('collapses repeated identical clicks to a single vote', () => {
    let current: VoteValue = 0;
    let score = 0;
    // Twenty rapid clicks of the same arrow, as a double-clicking user produces.
    for (let index = 0; index < 20; index += 1) {
      const transition = voteTransitions(current, 1);
      score += transition.scoreDelta;
      current = transition.action === 'delete' ? 0 : transition.value;
    }
    expect(current).toBe(1);
    expect(score).toBe(1);
  });
});
