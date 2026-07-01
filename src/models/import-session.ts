/**
 * Overall status of an import session.
 */
export type SessionStatus = 'in-progress' | 'paused' | 'completed' | 'aborted';

/**
 * Tracks the state and progress of an import session.
 */
export interface ImportSession {
  /** Unique identifier (UUID) */
  id: string;
  /** ISO timestamp when the session started */
  startedAt: string;
  /** ISO timestamp when the session completed or was aborted, or null */
  completedAt: string | null;
  /** Current session status */
  status: SessionStatus;
  /** Total number of Steam games in scope */
  totalGames: number;
  /** Number of games with a resolved match */
  matchedGames: number;
  /** Number of proposals generated */
  proposedChanges: number;
  /** Number of proposals approved by the user */
  approvedChanges: number;
  /** Number of proposals successfully applied */
  appliedChanges: number;
  /** Number of games skipped */
  skippedGames: number;
  /** Number of proposals that failed */
  failedGames: number;
  /** JSON snapshot of the ProposalPolicy used for this session (nullable) */
  policyJson: string | null;
}

/**
 * Create a new ImportSession.
 */
export function createImportSession(data: {
  id: string;
  totalGames: number;
  policyJson?: string | null;
}): ImportSession {
  return {
    id: data.id,
    startedAt: new Date().toISOString(),
    completedAt: null,
    status: 'in-progress',
    totalGames: data.totalGames,
    matchedGames: 0,
    proposedChanges: 0,
    approvedChanges: 0,
    appliedChanges: 0,
    skippedGames: 0,
    failedGames: 0,
    policyJson: data.policyJson ?? null,
  };
}
