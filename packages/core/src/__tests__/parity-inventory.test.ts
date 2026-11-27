import { describe, expect, it } from 'vitest';
import {
  APPROVED_PARITY_EXCEPTION_IDS,
  PARITY_INVENTORY,
  type ParityCategory,
} from '../testing/parity-inventory.js';

describe('Room & Web parity inventory (PRD v0.15 R5)', () => {
  it('has unique IDs, zero unclosed gaps, and covers every required category', () => {
    const ids = new Set<string>();
    const categories = new Set<ParityCategory>();
    const gaps: string[] = [];

    for (const item of PARITY_INVENTORY) {
      expect(ids.has(item.id), `duplicate inventory id: ${item.id}`).toBe(false);
      ids.add(item.id);
      categories.add(item.category);

      expect(item.webLocation.trim().length).toBeGreaterThan(0);
      expect(item.capability.trim().length).toBeGreaterThan(0);

      if (item.status === 'gap') {
        gaps.push(item.id);
      } else if (item.status === 'parity') {
        expect(
          item.roomCounterpart && item.roomCounterpart.trim().length > 0,
          `${item.id} marked parity must declare a roomCounterpart`,
        ).toBe(true);
      } else if (item.status === 'exception') {
        expect(
          item.exceptionReason && item.exceptionReason.trim().length > 0,
          `${item.id} marked exception must declare an exceptionReason`,
        ).toBe(true);
      }
    }

    expect(gaps, `unclosed parity gaps: ${gaps.join(', ')}`).toEqual([]);

    const requiredCategories: ParityCategory[] = [
      'config',
      'project',
      'work',
      'review_merge',
      'history',
      'statistics',
      'triage',
    ];
    for (const cat of requiredCategories) {
      expect(categories.has(cat), `missing parity category: ${cat}`).toBe(true);
    }
  });

  it('allows ONLY the three PRD-approved web-only exceptions (R5c)', () => {
    const exceptionIds = PARITY_INVENTORY
      .filter((item) => item.status === 'exception')
      .map((item) => item.id)
      .sort();

    expect(exceptionIds).toEqual([...APPROVED_PARITY_EXCEPTION_IDS].sort());
  });
});
