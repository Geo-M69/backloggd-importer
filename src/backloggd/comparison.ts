/**
 * Pure ownership comparator — Phase 5B Slice 1.
 *
 * This module has NO Playwright or database dependency.  It takes a read-only
 * visible-state summary (as produced by the reader in visible-state.ts) and
 * an ownership proposal, and classifies the proposal as:
 *
 *   - 'already-present' — the exact Steam/Digital entry already exists.
 *   - 'change-needed'   — Steam is absent and the page is safe to add to.
 *   - 'unknown'         — the visible state is too ambiguous to decide.
 *   - 'conflict'        — the proposal contradicts existing visible entries.
 *
 * Rules (see ROADMAP / Phase 5B Slice 1 spec):
 *
 *   - Normalize casing and whitespace only.
 *   - Use a strict alias whitelist.  `Steam` matches Steam; it does NOT match
 *     `Windows PC`, `PC`, or `Steam Deck`.  `Digital` matches Digital; it
 *     does NOT match generic `Owned`.
 *   - Exactly one Steam/Digital entry means `already-present`.
 *   - Steam with a clearly different ownership type means `conflict`.
 *   - Other complete platform entries plus Steam absent plus a complete
 *     ownership read plus one unique additive control means `change-needed`.
 *   - Generic membership, partial rows, incomplete reads, unsupported UI, or
 *     absent/ambiguous additive control means `unknown`.
 *   - Duplicate exact entries or contradictory entries mean `conflict`.
 *   - Ambiguity must NEVER produce `change-needed`.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OwnershipClassification = 'already-present' | 'change-needed' | 'unknown' | 'conflict';

export interface OwnershipProposal {
  /** Expected platform surface text, e.g. 'Steam'. */
  platform: string;
  /** Expected ownership-type surface text, e.g. 'Digital'. */
  ownershipType: string;
}

export interface ComparisonVisibleEntry {
  platform: string | null;
  ownershipType: string | null;
}

export interface ComparisonLibrarySummary {
  completeness: 'complete' | 'partial' | 'ambiguous' | 'unsupported';
  membership: 'present' | 'absent' | 'unknown';
  ownershipEntries: ComparisonVisibleEntry[];
  addControl: 'unique' | 'absent' | 'ambiguous';
  buttonStatus?: {
    value: string;
    evidence: 'btn-play-fill' | 'aria-pressed';
  };
}

export interface ComparisonResult {
  classification: OwnershipClassification;
  /** Concise machine-readable reason code. */
  reasonCode: string;
  /** Visible entries relevant to the classification. */
  relevantEntries: ComparisonVisibleEntry[];
  /**
   * True only when the classification is one the caller may safely act on in
   * a later state-transition slice.  `already-present` and `change-needed` are
   * safe; `unknown` and `conflict` are not.
   */
  safeForTransition: boolean;
  /** Sanitized diagnostic details only — never raw HTML, cookies, or session. */
  diagnostics: {
    normalizedProposalPlatform: string;
    normalizedProposalOwnership: string;
    matchedEntryIndices: number[];
    notes: string[];
  };
}

// ---------------------------------------------------------------------------
// Normalization + strict alias whitelist
// ---------------------------------------------------------------------------

/**
 * Normalize casing and whitespace only: lowercase, trim, collapse internal
 * whitespace to single spaces.
 */
export function normalizeSurfaceText(text: string | null): string | null {
  if (text === null) return null;
  const trimmed = text.trim().toLowerCase().replace(/\s+/g, ' ');
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Strict platform alias whitelist.  A surface form canonicalizes to a known
 * platform key ONLY when its normalized text appears here.  Anything else
 * (e.g. 'windows pc', 'pc', 'steam deck') does NOT canonicalize to 'steam'
 * and therefore cannot match a Steam proposal.
 *
 * Values are the canonical (lowercase) comparison keys.
 */
const PLATFORM_ALIAS_WHITELIST: Record<string, string> = {
  steam: 'steam',
};

/**
 * Strict ownership alias whitelist.  `digital` canonicalizes to `digital`;
 * `owned`, `physical`, `subscription`, etc. do NOT canonicalize to `digital`.
 */
const OWNERSHIP_ALIAS_WHITELIST: Record<string, string> = {
  digital: 'digital',
};

/**
 * Canonicalize a platform surface text against the strict whitelist.
 * Returns the canonical lowercase key, or `null` if the surface form is not
 * an accepted alias for any whitelisted platform.
 */
export function canonicalizePlatform(text: string | null): string | null {
  const normalized = normalizeSurfaceText(text);
  if (normalized === null) return null;
  return PLATFORM_ALIAS_WHITELIST[normalized] ?? null;
}

/**
 * Canonicalize an ownership-type surface text against the strict whitelist.
 */
export function canonicalizeOwnership(text: string | null): string | null {
  const normalized = normalizeSurfaceText(text);
  if (normalized === null) return null;
  return OWNERSHIP_ALIAS_WHITELIST[normalized] ?? null;
}

/**
 * A row is "complete" when both platform and ownership-type have non-empty
 * visible text (regardless of whitelist membership).  Rows whose platform or
 * ownership is missing/null are partial.
 */
function isCompleteEntry(entry: ComparisonVisibleEntry): boolean {
  return entry.platform !== null && entry.ownershipType !== null;
}

// ---------------------------------------------------------------------------
// Duplicate / contradiction detection
// ---------------------------------------------------------------------------

/**
 * Duplicate exact entries: two complete entries whose normalized platform AND
 * normalized ownership text are identical.  (Uses raw normalized text, not
 * whitelist canonicalization, so duplicate 'PlayStation/Physical' rows also
 * count.)
 */
function findDuplicateExactEntryIndices(entries: ComparisonVisibleEntry[]): number[] {
  const seen = new Map<string, number>();
  const dupes: number[] = [];
  entries.forEach((entry, index) => {
    if (!isCompleteEntry(entry)) return;
    const key = `${normalizeSurfaceText(entry.platform)}|${normalizeSurfaceText(entry.ownershipType)}`;
    if (seen.has(key)) {
      dupes.push(index);
    } else {
      seen.set(key, index);
    }
  });
  return dupes;
}

/**
 * Contradictory entries: two complete entries with the same normalized
 * platform text but different normalized ownership text.
 */
function findContradictoryEntryIndices(entries: ComparisonVisibleEntry[]): number[] {
  const byPlatform = new Map<string, { ownership: string; index: number }>();
  const conflicts: number[] = [];
  entries.forEach((entry, index) => {
    if (!isCompleteEntry(entry)) return;
    const pKey = normalizeSurfaceText(entry.platform);
    const oKey = normalizeSurfaceText(entry.ownershipType);
    if (pKey === null || oKey === null) return;
    const existing = byPlatform.get(pKey);
    if (existing) {
      if (existing.ownership !== oKey) {
        conflicts.push(index);
        conflicts.push(existing.index);
      }
    } else {
      byPlatform.set(pKey, { ownership: oKey, index });
    }
  });
  return conflicts;
}

// ---------------------------------------------------------------------------
// Comparator
// ---------------------------------------------------------------------------

/**
 * Compare an ownership proposal against a read-only visible-state summary.
 *
 * Pure: no Playwright, no database, no I/O.  Order of entries does not
 * matter — all matching is by canonical key, not by position.
 */
export function compareOwnership(
  proposal: OwnershipProposal,
  library: ComparisonLibrarySummary,
): ComparisonResult {
  const notes: string[] = [];
  const normalizedProposalPlatform = canonicalizePlatform(proposal.platform) ?? '';
  const normalizedProposalOwnership = canonicalizeOwnership(proposal.ownershipType) ?? '';
  const normalizedRequestedStatus = normalizeSurfaceText(proposal.ownershipType) ?? '';

  if (
    library.membership === 'present' &&
    library.completeness === 'complete' &&
    library.ownershipEntries.length === 0 &&
    normalizedProposalPlatform !== '' &&
    library.buttonStatus?.value === 'Played' &&
    normalizeSurfaceText(library.buttonStatus.value) === normalizedRequestedStatus
  ) {
    notes.push(`button-status-match:${library.buttonStatus.value}`);
    notes.push(`button-status-evidence:${library.buttonStatus.evidence}`);
    return {
      classification: 'already-present',
      reasonCode: 'button-status-match',
      relevantEntries: [],
      safeForTransition: true,
      diagnostics: {
        normalizedProposalPlatform,
        normalizedProposalOwnership: normalizedRequestedStatus,
        matchedEntryIndices: [],
        notes,
      },
    };
  }

  if (normalizedProposalPlatform === '' || normalizedProposalOwnership === '') {
    notes.push('proposal-not-in-strict-whitelist');
    return {
      classification: 'unknown',
      reasonCode: 'proposal-not-whitelisted',
      relevantEntries: [],
      safeForTransition: false,
      diagnostics: {
        normalizedProposalPlatform,
        normalizedProposalOwnership,
        matchedEntryIndices: [],
        notes,
      },
    };
  }

  // Unsupported UI (e.g. generic membership, missing region, login/challenge/
  // rate-limit pages surfaced by the reader as completeness='unsupported').
  if (library.completeness === 'unsupported') {
    notes.push(`completeness-unsupported`);
    return {
      classification: 'unknown',
      reasonCode: 'unsupported-read',
      relevantEntries: [],
      safeForTransition: false,
      diagnostics: {
        normalizedProposalPlatform,
        normalizedProposalOwnership,
        matchedEntryIndices: [],
        notes,
      },
    };
  }

  const entries = library.ownershipEntries;

  // Duplicate exact entries → conflict (ambiguity never becomes change-needed,
  // but explicit duplicates are a conflict, not unknown).
  const duplicateIndices = findDuplicateExactEntryIndices(entries);
  if (duplicateIndices.length > 0) {
    notes.push(`duplicate-exact-entries:${duplicateIndices.length}`);
    return {
      classification: 'conflict',
      reasonCode: 'duplicate-exact-entries',
      relevantEntries: duplicateIndices.map((i) => entries[i]),
      safeForTransition: false,
      diagnostics: {
        normalizedProposalPlatform,
        normalizedProposalOwnership,
        matchedEntryIndices: duplicateIndices,
        notes,
      },
    };
  }

  // Contradictory entries (same platform, different ownership) → conflict.
  const contradictoryIndices = findContradictoryEntryIndices(entries);
  if (contradictoryIndices.length > 0) {
    notes.push(`contradictory-entries:${contradictoryIndices.length}`);
    return {
      classification: 'conflict',
      reasonCode: 'contradictory-entries',
      relevantEntries: contradictoryIndices.map((i) => entries[i]),
      safeForTransition: false,
      diagnostics: {
        normalizedProposalPlatform,
        normalizedProposalOwnership,
        matchedEntryIndices: contradictoryIndices,
        notes,
      },
    };
  }

  // Partial rows → unknown (incomplete read; ambiguity never change-needed).
  if (library.completeness === 'partial') {
    notes.push('partial-rows-present');
    return {
      classification: 'unknown',
      reasonCode: 'partial-read',
      relevantEntries: entries.filter((e) => !isCompleteEntry(e)),
      safeForTransition: false,
      diagnostics: {
        normalizedProposalPlatform,
        normalizedProposalOwnership,
        matchedEntryIndices: [],
        notes,
      },
    };
  }

  // Ambiguous completeness (e.g. duplicate visible regions) → unknown.
  if (library.completeness === 'ambiguous') {
    notes.push('ambiguous-completeness');
    return {
      classification: 'unknown',
      reasonCode: 'ambiguous-read',
      relevantEntries: [],
      safeForTransition: false,
      diagnostics: {
        normalizedProposalPlatform,
        normalizedProposalOwnership,
        matchedEntryIndices: [],
        notes,
      },
    };
  }

  // From here, completeness === 'complete'.

  // Find Steam entries (canonical platform match).
  const steamEntryIndices: number[] = [];
  entries.forEach((entry, index) => {
    if (canonicalizePlatform(entry.platform) === normalizedProposalPlatform) {
      steamEntryIndices.push(index);
    }
  });
  const steamEntries = steamEntryIndices.map((i) => entries[i]);

  // Exactly one Steam/Digital entry → already-present.
  if (steamEntryIndices.length === 1) {
    const onlySteam = steamEntries[0];
    if (canonicalizeOwnership(onlySteam.ownershipType) === normalizedProposalOwnership) {
      notes.push('exact-steam-digital-match');
      return {
        classification: 'already-present',
        reasonCode: 'exact-match',
        relevantEntries: steamEntries,
        safeForTransition: true,
        diagnostics: {
          normalizedProposalPlatform,
          normalizedProposalOwnership,
          matchedEntryIndices: steamEntryIndices,
          notes,
        },
      };
    }
    // Steam present with a clearly different ownership type → conflict.
    notes.push('steam-different-ownership');
    return {
      classification: 'conflict',
      reasonCode: 'steam-ownership-mismatch',
      relevantEntries: steamEntries,
      safeForTransition: false,
      diagnostics: {
        normalizedProposalPlatform,
        normalizedProposalOwnership,
        matchedEntryIndices: steamEntryIndices,
        notes,
      },
    };
  }

  // Multiple Steam entries (without duplicates/contradictions already caught)
  // — should not normally occur, but treat as conflict to be safe.
  if (steamEntryIndices.length > 1) {
    notes.push(`multiple-steam-entries:${steamEntryIndices.length}`);
    return {
      classification: 'conflict',
      reasonCode: 'multiple-steam-entries',
      relevantEntries: steamEntries,
      safeForTransition: false,
      diagnostics: {
        normalizedProposalPlatform,
        normalizedProposalOwnership,
        matchedEntryIndices: steamEntryIndices,
        notes,
      },
    };
  }

  // No Steam entry.  Decide between change-needed and unknown.
  //
  // change-needed requires ALL of:
  //   - Steam absent;
  //   - completeness === 'complete';
  //   - one unique additive control;
  //   - any other complete platform entries present OR an explicitly empty
  //     library (membership === 'absent') — both are safe-to-add shapes.
  //
  // Generic membership (membership === 'present' but no entries) was already
  // surfaced by the reader as completeness='unsupported' and returned above.
  const hasOtherCompleteEntries = entries.some(
    (e) => isCompleteEntry(e) && canonicalizePlatform(e.platform) !== normalizedProposalPlatform,
  );
  const explicitlyEmpty = entries.length === 0 && library.membership === 'absent';

  if ((hasOtherCompleteEntries || explicitlyEmpty) && library.addControl === 'unique') {
    notes.push('steam-absent-unique-add-control');
    return {
      classification: 'change-needed',
      reasonCode: 'steam-absent-safe-add',
      relevantEntries: entries.filter((e) => isCompleteEntry(e)),
      safeForTransition: true,
      diagnostics: {
        normalizedProposalPlatform,
        normalizedProposalOwnership,
        matchedEntryIndices: [],
        notes,
      },
    };
  }

  // Absent/ambiguous additive control, or generic membership without detail,
  // or otherwise incomplete read → unknown.  Ambiguity never becomes
  // change-needed.
  notes.push(
    `add-control:${library.addControl}`,
    `membership:${library.membership}`,
    `other-complete:${hasOtherCompleteEntries}`,
    `empty:${explicitlyEmpty}`,
  );
  return {
    classification: 'unknown',
    reasonCode: 'no-safe-add-path',
    relevantEntries: [],
    safeForTransition: false,
    diagnostics: {
      normalizedProposalPlatform,
      normalizedProposalOwnership,
      matchedEntryIndices: [],
      notes,
    },
  };
}
