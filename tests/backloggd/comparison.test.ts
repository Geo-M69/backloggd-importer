import { describe, it, expect } from 'vitest';
import {
  compareOwnership,
  normalizeSurfaceText,
  canonicalizePlatform,
  canonicalizeOwnership,
  type ComparisonLibrarySummary,
} from '../../src/backloggd/comparison.js';

function lib(overrides: Partial<ComparisonLibrarySummary> = {}): ComparisonLibrarySummary {
  return {
    completeness: 'complete',
    membership: 'present',
    ownershipEntries: [],
    addControl: 'unique',
    ...overrides,
  };
}

const STEAM_DIGITAL = { platform: 'Steam', ownershipType: 'Digital' };

describe('ownership comparator', () => {
  // -----------------------------------------------------------------------
  // Normalization + whitelist helpers
  // -----------------------------------------------------------------------

  describe('normalization', () => {
    it('normalizes casing and whitespace', () => {
      expect(normalizeSurfaceText('  StEaM  ')).toBe('steam');
      expect(normalizeSurfaceText('Steam\nDeck')).toBe('steam deck');
      expect(normalizeSurfaceText(null)).toBeNull();
      expect(normalizeSurfaceText('   ')).toBeNull();
    });

    it('canonicalizes whitelisted platforms only', () => {
      expect(canonicalizePlatform('Steam')).toBe('steam');
      expect(canonicalizePlatform('STEAM')).toBe('steam');
      expect(canonicalizePlatform('Steam Deck')).toBeNull();
      expect(canonicalizePlatform('Windows PC')).toBeNull();
      expect(canonicalizePlatform('PC')).toBeNull();
      expect(canonicalizePlatform(null)).toBeNull();
    });

    it('canonicalizes whitelisted ownership types only', () => {
      expect(canonicalizeOwnership('Digital')).toBe('digital');
      expect(canonicalizeOwnership('DIGITAL')).toBe('digital');
      expect(canonicalizeOwnership('Owned')).toBeNull();
      expect(canonicalizeOwnership('Physical')).toBeNull();
      expect(canonicalizeOwnership(null)).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Core classifications
  // -----------------------------------------------------------------------

  describe('exact match', () => {
    it('classifies a single exact Steam/Digital entry as already-present', () => {
      const result = compareOwnership(STEAM_DIGITAL, {
        completeness: 'complete',
        membership: 'present',
        addControl: 'unique',
        ownershipEntries: [{ platform: 'Steam', ownershipType: 'Digital' }],
      });
      expect(result.classification).toBe('already-present');
      expect(result.reasonCode).toBe('exact-match');
      expect(result.safeForTransition).toBe(true);
      expect(result.relevantEntries).toHaveLength(1);
    });

    it('normalizes casing and whitespace before matching', () => {
      const result = compareOwnership(STEAM_DIGITAL, {
        completeness: 'complete',
        membership: 'present',
        addControl: 'unique',
        ownershipEntries: [{ platform: '  StEaM ', ownershipType: '  DiGiTaL  ' }],
      });
      expect(result.classification).toBe('already-present');
    });
  });

  describe('change-needed', () => {
    it('classifies other-platforms-present + Steam absent + unique add control', () => {
      const result = compareOwnership(STEAM_DIGITAL, {
        completeness: 'complete',
        membership: 'present',
        addControl: 'unique',
        ownershipEntries: [
          { platform: 'PlayStation', ownershipType: 'Physical' },
          { platform: 'Xbox', ownershipType: 'Digital' },
        ],
      });
      expect(result.classification).toBe('change-needed');
      expect(result.reasonCode).toBe('steam-absent-safe-add');
      expect(result.safeForTransition).toBe(true);
    });

    it('classifies an explicitly empty library with a unique add control', () => {
      const result = compareOwnership(STEAM_DIGITAL, {
        completeness: 'complete',
        membership: 'absent',
        addControl: 'unique',
        ownershipEntries: [],
      });
      expect(result.classification).toBe('change-needed');
    });

    it('ordering does not matter', () => {
      const entries = [
        { platform: 'Xbox', ownershipType: 'Digital' },
        { platform: 'PlayStation', ownershipType: 'Physical' },
      ];
      const a = compareOwnership(STEAM_DIGITAL, {
        completeness: 'complete',
        membership: 'present',
        addControl: 'unique',
        ownershipEntries: entries,
      });
      const b = compareOwnership(STEAM_DIGITAL, {
        completeness: 'complete',
        membership: 'present',
        addControl: 'unique',
        ownershipEntries: [...entries].reverse(),
      });
      expect(a.classification).toBe('change-needed');
      expect(b.classification).toBe('change-needed');
    });
  });

  describe('conflict', () => {
    it('classifies Steam with a different ownership type as conflict', () => {
      const result = compareOwnership(STEAM_DIGITAL, {
        completeness: 'complete',
        membership: 'present',
        addControl: 'unique',
        ownershipEntries: [{ platform: 'Steam', ownershipType: 'Physical' }],
      });
      expect(result.classification).toBe('conflict');
      expect(result.reasonCode).toBe('steam-ownership-mismatch');
      expect(result.safeForTransition).toBe(false);
    });

    it('generic Owned does not equal Digital (conflict)', () => {
      const result = compareOwnership(STEAM_DIGITAL, {
        completeness: 'complete',
        membership: 'present',
        addControl: 'unique',
        ownershipEntries: [{ platform: 'Steam', ownershipType: 'Owned' }],
      });
      expect(result.classification).toBe('conflict');
    });

    it('classifies duplicate exact entries as conflict', () => {
      const result = compareOwnership(STEAM_DIGITAL, {
        completeness: 'complete',
        membership: 'present',
        addControl: 'unique',
        ownershipEntries: [
          { platform: 'Steam', ownershipType: 'Digital' },
          { platform: 'Steam', ownershipType: 'Digital' },
        ],
      });
      expect(result.classification).toBe('conflict');
      expect(result.reasonCode).toBe('duplicate-exact-entries');
    });

    it('classifies contradictory entries (same platform, different ownership) as conflict', () => {
      const result = compareOwnership(STEAM_DIGITAL, {
        completeness: 'complete',
        membership: 'present',
        addControl: 'unique',
        ownershipEntries: [
          { platform: 'Steam', ownershipType: 'Digital' },
          { platform: 'Steam', ownershipType: 'Physical' },
        ],
      });
      expect(result.classification).toBe('conflict');
      expect(result.reasonCode).toBe('contradictory-entries');
    });
  });

  describe('unknown', () => {
    it('classifies generic membership (unsupported read) as unknown', () => {
      const result = compareOwnership(STEAM_DIGITAL, {
        completeness: 'unsupported',
        membership: 'present',
        addControl: 'unique',
        ownershipEntries: [],
      });
      expect(result.classification).toBe('unknown');
      expect(result.reasonCode).toBe('unsupported-read');
      expect(result.safeForTransition).toBe(false);
    });

    it('classifies partial rows as unknown', () => {
      const result = compareOwnership(STEAM_DIGITAL, {
        completeness: 'partial',
        membership: 'present',
        addControl: 'unique',
        ownershipEntries: [{ platform: 'Steam', ownershipType: null }],
      });
      expect(result.classification).toBe('unknown');
      expect(result.reasonCode).toBe('partial-read');
    });

    it('classifies ambiguous completeness as unknown', () => {
      const result = compareOwnership(STEAM_DIGITAL, {
        completeness: 'ambiguous',
        membership: 'unknown',
        addControl: 'ambiguous',
        ownershipEntries: [],
      });
      expect(result.classification).toBe('unknown');
      expect(result.reasonCode).toBe('ambiguous-read');
    });

    it('classifies absent additive control with Steam absent as unknown', () => {
      const result = compareOwnership(STEAM_DIGITAL, {
        completeness: 'complete',
        membership: 'present',
        addControl: 'absent',
        ownershipEntries: [{ platform: 'PlayStation', ownershipType: 'Physical' }],
      });
      expect(result.classification).toBe('unknown');
    });

    it('classifies ambiguous additive control with Steam absent as unknown', () => {
      const result = compareOwnership(STEAM_DIGITAL, {
        completeness: 'complete',
        membership: 'present',
        addControl: 'ambiguous',
        ownershipEntries: [{ platform: 'PlayStation', ownershipType: 'Physical' }],
      });
      expect(result.classification).toBe('unknown');
    });

    it('rejects a proposal not in the strict whitelist as unknown', () => {
      const result = compareOwnership(
        { platform: 'PC', ownershipType: 'Digital' },
        {
          completeness: 'complete',
          membership: 'present',
          addControl: 'unique',
          ownershipEntries: [{ platform: 'Steam', ownershipType: 'Digital' }],
        },
      );
      expect(result.classification).toBe('unknown');
      expect(result.reasonCode).toBe('proposal-not-whitelisted');
    });
  });

  // -----------------------------------------------------------------------
  // Strict alias behavior
  // -----------------------------------------------------------------------

  describe('strict alias behavior', () => {
    it('Steam Deck does not equal Steam (treated as other platform → change-needed)', () => {
      const result = compareOwnership(STEAM_DIGITAL, {
        completeness: 'complete',
        membership: 'present',
        addControl: 'unique',
        ownershipEntries: [{ platform: 'Steam Deck', ownershipType: 'Digital' }],
      });
      expect(result.classification).toBe('change-needed');
    });

    it('Windows PC does not equal Steam', () => {
      const result = compareOwnership(STEAM_DIGITAL, {
        completeness: 'complete',
        membership: 'present',
        addControl: 'unique',
        ownershipEntries: [{ platform: 'Windows PC', ownershipType: 'Digital' }],
      });
      expect(result.classification).toBe('change-needed');
    });

    it('PC does not equal Steam', () => {
      const result = compareOwnership(STEAM_DIGITAL, {
        completeness: 'complete',
        membership: 'present',
        addControl: 'unique',
        ownershipEntries: [{ platform: 'PC', ownershipType: 'Digital' }],
      });
      expect(result.classification).toBe('change-needed');
    });

    it('generic Owned does not equal Digital even with Steam platform', () => {
      const result = compareOwnership(STEAM_DIGITAL, {
        completeness: 'complete',
        membership: 'present',
        addControl: 'unique',
        ownershipEntries: [{ platform: 'Steam', ownershipType: 'Owned' }],
      });
      expect(result.classification).toBe('conflict');
    });
  });

  // -----------------------------------------------------------------------
  // Ambiguity never becomes change-needed
  // -----------------------------------------------------------------------

  describe('ambiguity never becomes change-needed', () => {
    it('ambiguous completeness never yields change-needed', () => {
      const cases: ComparisonLibrarySummary[] = [
        {
          completeness: 'ambiguous',
          membership: 'unknown',
          addControl: 'unique',
          ownershipEntries: [],
        },
        {
          completeness: 'ambiguous',
          membership: 'present',
          addControl: 'unique',
          ownershipEntries: [
            { platform: 'Steam', ownershipType: 'Digital' },
            { platform: 'Steam', ownershipType: 'Digital' },
          ],
        },
      ];
      for (const library of cases) {
        const result = compareOwnership(STEAM_DIGITAL, library);
        expect(result.classification).not.toBe('change-needed');
      }
    });

    it('partial rows never yield change-needed', () => {
      const result = compareOwnership(STEAM_DIGITAL, {
        completeness: 'partial',
        membership: 'present',
        addControl: 'unique',
        ownershipEntries: [{ platform: 'Steam', ownershipType: null }],
      });
      expect(result.classification).not.toBe('change-needed');
    });

    it('unsupported completeness never yields change-needed', () => {
      const result = compareOwnership(STEAM_DIGITAL, {
        completeness: 'unsupported',
        membership: 'present',
        addControl: 'unique',
        ownershipEntries: [],
      });
      expect(result.classification).not.toBe('change-needed');
    });
  });

  // -----------------------------------------------------------------------
  // Convenience: default library helper sanity
  // -----------------------------------------------------------------------

  it('default helper produces a change-needed for empty absent library', () => {
    const result = compareOwnership(STEAM_DIGITAL, lib({ membership: 'absent' }));
    expect(result.classification).toBe('change-needed');
  });
});
