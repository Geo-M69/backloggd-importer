import type { MatchConfidence } from './match.js';

/**
 * Types of changes that can be proposed.
 */
export type ProposalAction = 'add-ownership' | 'update-status' | 'add-to-backlog' | 'mark-played';

/**
 * Processing status of a proposal.
 */
export type ProposalStatus = 'pending' | 'approved' | 'skipped' | 'applied' | 'failed';

/**
 * A proposed change to a Backloggd library entry.
 */
export interface Proposal {
  /** Unique identifier (UUID) */
  id: string;
  /** The import session this proposal belongs to */
  importSessionId: string;
  /** Source Steam AppID */
  steamAppId: number;
  /** Target IGDB game ID */
  igdbId: number;
  /** Target Backloggd slug */
  backloggdSlug: string;
  /** The action to perform */
  action: ProposalAction;
  /** Current processing status */
  status: ProposalStatus;
  /** Confidence of the underlying match */
  matchConfidence: MatchConfidence;
  /** Human-readable notes (e.g. reason for skip or failure) */
  notes: string | null;
  /** ISO timestamp when created */
  createdAt: string;
  /** ISO timestamp when last updated */
  updatedAt: string;
}

/**
 * Create a new Proposal.
 */
export function createProposal(data: {
  id: string;
  importSessionId: string;
  steamAppId: number;
  igdbId: number;
  backloggdSlug: string;
  action: ProposalAction;
  matchConfidence: MatchConfidence;
  notes?: string | null;
}): Proposal {
  const now = new Date().toISOString();
  return {
    id: data.id,
    importSessionId: data.importSessionId,
    steamAppId: data.steamAppId,
    igdbId: data.igdbId,
    backloggdSlug: data.backloggdSlug,
    action: data.action,
    status: 'pending',
    matchConfidence: data.matchConfidence,
    notes: data.notes ?? null,
    createdAt: now,
    updatedAt: now,
  };
}
