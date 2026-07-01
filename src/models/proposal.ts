/**
 * Types and factories for import proposals.
 *
 * Each active Steam game can produce up to three separate proposal
 * records (ownership, status, playlog) so that the user can review
 * and approve each kind independently.
 */

import type { MatchConfidence } from './match.js';

// ---------------------------------------------------------------------------
// Proposal kinds
// ---------------------------------------------------------------------------

/**
 * Distinct categories of proposed changes.
 * Kept separate so the user can review each kind independently.
 */
export type ProposalKind = 'ownership' | 'status' | 'playlog';

// ---------------------------------------------------------------------------
// Proposal statuses
// ---------------------------------------------------------------------------

/**
 * Processing status of a proposal.
 *
 * `applied` and `failed` are reserved for later milestones (browser
 * interaction) and are not set by the current CLI commands.
 */
export type ProposalStatus =
  'pending' | 'approved' | 'skipped' | 'deferred' | 'blocked' | 'applied' | 'failed';

// ---------------------------------------------------------------------------
// Suggested-payload types
// ---------------------------------------------------------------------------

/**
 * Payload for an `ownership` proposal.
 */
export interface OwnershipSuggestion {
  platform: string;
  ownershipType: string;
}

/**
 * Payload for a `status` proposal.
 */
export interface StatusSuggestion {
  suggestion: 'none' | 'backlog' | 'played';
  reason?: string;
}

/**
 * Payload for a `playlog` proposal.
 */
export interface PlaylogSuggestion {
  enabled: boolean;
  sourcePlaytimeMinutes?: number;
}

/**
 * Union of all suggestion payloads, keyed by proposal kind.
 */
export type SuggestionPayload = OwnershipSuggestion | StatusSuggestion | PlaylogSuggestion;

// ---------------------------------------------------------------------------
// Proposal policy
// ---------------------------------------------------------------------------

/**
 * Configurable policy for controlling which proposals are generated.
 *
 * All fields are optional.  By default only ownership proposals are
 * generated.  Status and playlog suggestions require explicit opt-in.
 */
export interface ProposalPolicy {
  /** When set, create a status proposal for games whose playtime
   *  (in minutes) meets or exceeds this threshold, suggesting "played". */
  playtimeThresholdMinutes?: number;

  /** When true, create a status proposal suggesting "backlog" for
   *  games with zero playtime. */
  suggestBacklogWhenZeroPlaytime?: boolean;

  /** When true, create a playlog proposal carrying only the source
   *  playtime metadata.  No detailed session data is inferred. */
  enablePlaylogSuggestion?: boolean;
}

// ---------------------------------------------------------------------------
// Proposal model
// ---------------------------------------------------------------------------

/**
 * A proposed change to a Backloggd library entry.
 */
export interface Proposal {
  /** Unique identifier (UUID). */
  id: string;
  /** The import session this proposal belongs to. */
  importSessionId: string;
  /** Source Steam AppID. */
  steamAppId: number;
  /** Target IGDB game ID, or null when unmatched. */
  igdbId: number | null;
  /** Target Backloggd slug, or null when unmatched. */
  backloggdSlug: string | null;
  /** Kind of proposal (ownership / status / playlog). */
  proposalKind: ProposalKind;
  /** Current processing status. */
  status: ProposalStatus;
  /** Confidence of the underlying IGDB match. */
  matchConfidence: MatchConfidence;
  /** When 1, this proposal requires explicit human review before approval. */
  requiresManualReview: boolean;
  /** JSON-encoded suggestion payload specific to the proposal kind. */
  suggestedPayload: string | null;
  /** Human-readable notes (e.g. reason for skip or failure). */
  notes: string | null;
  /** User-provided notes about their decision (skip/defer/correct). */
  decisionNotes: string | null;
  /** ISO timestamp when created. */
  createdAt: string;
  /** ISO timestamp when last updated. */
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a new Proposal with default pending status.
 */
export function createProposal(data: {
  id: string;
  importSessionId: string;
  steamAppId: number;
  igdbId: number | null;
  backloggdSlug: string | null;
  proposalKind: ProposalKind;
  matchConfidence: MatchConfidence;
  requiresManualReview?: boolean;
  suggestedPayload?: string | null;
  notes?: string | null;
  decisionNotes?: string | null;
}): Proposal {
  const now = new Date().toISOString();
  return {
    id: data.id,
    importSessionId: data.importSessionId,
    steamAppId: data.steamAppId,
    igdbId: data.igdbId,
    backloggdSlug: data.backloggdSlug,
    proposalKind: data.proposalKind,
    status: 'pending',
    matchConfidence: data.matchConfidence,
    requiresManualReview: data.requiresManualReview ?? false,
    suggestedPayload: data.suggestedPayload ?? null,
    notes: data.notes ?? null,
    decisionNotes: data.decisionNotes ?? null,
    createdAt: now,
    updatedAt: now,
  };
}
