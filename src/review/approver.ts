/**
 * Bulk‑approve proposals that are safe to auto‑approve.
 *
 * Only `pending` ownership proposals with `exact` match confidence
 * and `requires_manual_review = 0` are eligible.  Ambiguous, probable,
 * unmatched, status, playlog, skipped, deferred, and blocked proposals
 * are never touched by bulk approval.
 */

import type Database from 'better-sqlite3';
import { getDatabase } from '../storage/database.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ApproveResult {
  approved: number;
  skipped: number;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Bulk‑approve all eligible exact‑match ownership proposals for a session.
 *
 * Eligibility criteria:
 * - proposal_kind = 'ownership'
 * - status = 'pending'
 * - match_confidence = 'exact'
 * - requires_manual_review = 0
 *
 * @param sessionId  The import session to operate on.
 *                   When omitted, uses the latest in‑progress session.
 * @param db         Database instance (defaults to global singleton).
 * @returns          Count of approved and skipped proposals.
 */
export function approveExactMatches(sessionId?: string, db?: Database.Database): ApproveResult {
  const database = db ?? getDatabase();

  // Resolve session when not provided
  let targetSessionId = sessionId;
  if (!targetSessionId) {
    const row = database
      .prepare(
        `SELECT id FROM import_sessions
         WHERE status = 'in-progress'
         ORDER BY started_at DESC LIMIT 1`,
      )
      .get() as { id: string } | undefined;
    if (!row) {
      return { approved: 0, skipped: 0 };
    }
    targetSessionId = row.id;
  }

  // Count eligible proposals
  const eligible = database
    .prepare(
      `SELECT COUNT(*) AS cnt FROM proposals
       WHERE import_session_id = ?
         AND proposal_kind = 'ownership'
         AND status = 'pending'
         AND match_confidence = 'exact'
         AND requires_manual_review = 0`,
    )
    .get(targetSessionId) as { cnt: number };

  if (eligible.cnt === 0) {
    return { approved: 0, skipped: 0 };
  }

  // Approve them
  const updateResult = database
    .prepare(
      `UPDATE proposals
       SET status = 'approved',
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE import_session_id = ?
         AND proposal_kind = 'ownership'
         AND status = 'pending'
         AND match_confidence = 'exact'
         AND requires_manual_review = 0`,
    )
    .run(targetSessionId);

  // Update session counters
  const approvedCount = updateResult.changes;
  database
    .prepare(
      `UPDATE import_sessions
       SET approved_changes = approved_changes + ?
       WHERE id = ?`,
    )
    .run(approvedCount, targetSessionId);

  return { approved: approvedCount, skipped: 0 };
}
