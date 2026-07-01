/**
 * Canonical payload builders for proposal suggestions.
 *
 * Both the proposal generator and the database migration / repair code use
 * these same functions so that migration artifacts are always byte-identical
 * to what the generator produces.
 */
import type { MatchConfidence } from '../models/match.js';
import type { ProposalPolicy } from '../models/proposal.js';

// ---------------------------------------------------------------------------
// Ownership payload
// ---------------------------------------------------------------------------

export interface OwnershipDefaults {
  status: 'pending' | 'blocked';
  requiresManualReview: number;
  payload: string;
  note: string | null;
}

/**
 * Build ownership defaults for a game/match row.
 *
 * Every active game gets an ownership proposal so unmatched/uncertain games
 * remain visible in review.
 */
export function ownershipDefaults(
  igdbId: number | null,
  backloggdSlug: string | null,
  confidence: MatchConfidence | null,
): OwnershipDefaults {
  const hasTarget = igdbId !== null && backloggdSlug !== null;

  let reason: string | null = null;
  if (confidence === null) {
    reason = 'missing_match';
  } else if (confidence === 'unmatched') {
    reason = 'unmatched';
  } else if (confidence === 'ambiguous') {
    reason = 'ambiguous';
  } else if (confidence === 'probable') {
    reason = 'probable';
  }

  if (!hasTarget) {
    reason = reason ?? 'missing_target';
  }

  const payloadBase: Record<string, unknown> = {
    platform: 'steam',
    ownershipType: 'digital',
  };
  if (reason !== null) {
    payloadBase.reason = reason;
  }

  const blocked = confidence === null || confidence === 'unmatched' || !hasTarget;

  return {
    status: blocked ? 'blocked' : 'pending',
    requiresManualReview: reason === null ? 0 : 1,
    payload: JSON.stringify(payloadBase),
    note: reason === null ? null : `requires-manual-review:${reason}`,
  };
}

// ---------------------------------------------------------------------------
// Status payload
// ---------------------------------------------------------------------------

/**
 * Build the JSON payload for a status proposal based on playtime and policy.
 */
export function statusPayload(playtimeMinutes: number, policy: ProposalPolicy): string {
  if (playtimeMinutes === 0 && policy.suggestBacklogWhenZeroPlaytime) {
    return JSON.stringify({ suggestion: 'backlog', reason: 'no-playtime' });
  }
  if (
    policy.playtimeThresholdMinutes !== undefined &&
    playtimeMinutes >= policy.playtimeThresholdMinutes
  ) {
    return JSON.stringify({ suggestion: 'played', reason: 'above-threshold' });
  }
  // No applicable status suggestion.
  return JSON.stringify({ suggestion: 'none' });
}

// ---------------------------------------------------------------------------
// Playlog payload
// ---------------------------------------------------------------------------

/**
 * Build the JSON payload for a playlog proposal.
 */
export function playlogPayload(playtimeMinutes: number): string {
  return JSON.stringify({ enabled: false, sourcePlaytimeMinutes: playtimeMinutes });
}

// ---------------------------------------------------------------------------
// Canonical suggested_payload for migration
// ---------------------------------------------------------------------------

/**
 * Synthesise the canonical suggested_payload string that the generator would
 * produce for a row about to be migrated from the old schema.
 *
 * Used by the old→new rebuild SQL to avoid false-positive drift.
 */
export function canonicalMigrationPayload(
  action: string,
  matchConfidence: MatchConfidence | null,
  playtimeMinutes: number | null | undefined,
): string | null {
  switch (action) {
    case 'add-ownership': {
      // For the purpose of migration, use the match_confidence to determine
      // the reason, mirroring ownershipDefaults() logic.
      const defaults = ownershipDefaults(
        // Assume target exists (old schema required non-null igdb_id).
        1,
        'placeholder',
        matchConfidence,
      );
      return defaults.payload;
    }
    case 'update-status':
    case 'add-to-backlog':
      return JSON.stringify({ suggestion: 'none' });
    case 'mark-played':
      return playlogPayload(playtimeMinutes ?? 0);
    default:
      return null;
  }
}
