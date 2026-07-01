/**
 * Proposal generation from active Steam games and their IGDB match rows.
 *
 * Reads active (stale = 0) games from the database, joins against the
 * matches table, and idempotently creates proposal rows keyed by
 * (import_session_id, steam_app_id, proposal_kind).
 *
 * By default only ownership proposals are created.  Status and playlog
 * proposals require explicit opt-in via the provided policy.
 */

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { MatchConfidence } from '../models/match.js';
import type { ProposalPolicy } from '../models/proposal.js';
import { createImportSession } from '../models/import-session.js';
import type { ImportSession } from '../models/import-session.js';
import { getDatabase } from '../storage/database.js';
import {
  ownershipDefaults as sharedOwnershipDefaults,
  statusPayload as sharedStatusPayload,
  playlogPayload as sharedPlaylogPayload,
} from './payloads.js';

// ---------------------------------------------------------------------------
// Query result row
// ---------------------------------------------------------------------------

interface GameWithMatchRow {
  app_id: number;
  steam_title: string;
  playtime_minutes: number;
  igdb_id: number | null;
  igdb_name: string | null;
  backloggd_slug: string | null;
  confidence: MatchConfidence | null;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Result summary returned by generateProposals(). */
export interface GenerateResult {
  sessionId: string;
  totalGames: number;
  ownershipProposals: number;
  statusProposals: number;
  playlogProposals: number;
  requiresReview: number;
}

/** Options for generateProposals(). */
export interface GenerateOptions {
  /** Existing session ID.  When omitted a new session is created. */
  sessionId?: string;
  /** Policy controlling which proposals are created. */
  policy?: ProposalPolicy;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Determine whether a match confidence requires manual review.
 */
function requiresManualReview(confidence: MatchConfidence | null): boolean {
  if (confidence === null) return true;
  return confidence !== 'exact';
}

/** Proxy to shared ownership defaults. */
function ownershipDefaults(row: GameWithMatchRow) {
  return sharedOwnershipDefaults(row.igdb_id, row.backloggd_slug, row.confidence);
}

// ---------------------------------------------------------------------------
// Session helpers
// ---------------------------------------------------------------------------

/**
 * Return the latest in‑progress session, or null when none exists.
 */
function latestInProgressSession(db: Database.Database): ImportSession | null {
  const row = db
    .prepare(
      `SELECT id, started_at, completed_at, status, total_games,
              matched_games, proposed_changes, approved_changes,
              applied_changes, skipped_games, failed_games, policy_json
       FROM import_sessions
       WHERE status = 'in-progress'
       ORDER BY started_at DESC
       LIMIT 1`,
    )
    .get() as Record<string, unknown> | undefined;

  if (!row) return null;

  return {
    id: row.id as string,
    startedAt: row.started_at as string,
    completedAt: row.completed_at as string | null,
    status: row.status as ImportSession['status'],
    totalGames: row.total_games as number,
    matchedGames: row.matched_games as number,
    proposedChanges: row.proposed_changes as number,
    approvedChanges: row.approved_changes as number,
    appliedChanges: row.applied_changes as number,
    skippedGames: row.skipped_games as number,
    failedGames: row.failed_games as number,
    policyJson: row.policy_json as string | null,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate proposal rows from active Steam games and their IGDB match rows.
 *
 * Idempotent: uses INSERT OR REPLACE keyed on
 * (import_session_id, steam_app_id, proposal_kind) so re‑running never
 * creates duplicate entries.
 *
 * @param db      Database instance.  When omitted uses the global singleton.
 * @param options Generation options including session ID and policy.
 * @returns       A summary of what was generated.
 */
export function generateProposals(
  db?: Database.Database,
  options: GenerateOptions = {},
): GenerateResult {
  const database = db ?? getDatabase();
  const policy: ProposalPolicy = options.policy ?? {};

  // --- Resolve session --------------------------------------------------
  let session: ImportSession;
  if (options.sessionId) {
    // Use the explicitly provided session
    const row = database
      .prepare('SELECT * FROM import_sessions WHERE id = ?')
      .get(options.sessionId) as Record<string, unknown> | undefined;
    if (!row) {
      throw new Error(`Session "${options.sessionId}" not found.`);
    }
    session = {
      id: row.id as string,
      startedAt: row.started_at as string,
      completedAt: row.completed_at as string | null,
      status: row.status as ImportSession['status'],
      totalGames: row.total_games as number,
      matchedGames: row.matched_games as number,
      proposedChanges: row.proposed_changes as number,
      approvedChanges: row.approved_changes as number,
      appliedChanges: row.applied_changes as number,
      skippedGames: row.skipped_games as number,
      failedGames: row.failed_games as number,
      policyJson: row.policy_json as string | null,
    };
  } else {
    // Reuse latest in‑progress session or create a new one
    session =
      latestInProgressSession(database) ?? createImportSession({ id: randomUUID(), totalGames: 0 });
  }

  const sessionId = session.id;
  const policyJson = JSON.stringify(policy);

  // --- Ensure the session exists in the database --------------------------
  const existingSession = database
    .prepare('SELECT id FROM import_sessions WHERE id = ?')
    .get(sessionId) as { id: string } | undefined;
  if (!existingSession) {
    database
      .prepare(
        `INSERT INTO import_sessions (id, started_at, status, total_games, matched_games,
          proposed_changes, approved_changes, applied_changes, skipped_games, failed_games, policy_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sessionId,
        session.startedAt,
        session.status,
        session.totalGames,
        session.matchedGames,
        session.proposedChanges,
        session.approvedChanges,
        session.appliedChanges,
        session.skippedGames,
        session.failedGames,
        policyJson,
      );
  }

  // --- Fetch active games with match data --------------------------------
  const rows = database
    .prepare(
      `SELECT g.app_id,
              g.title AS steam_title,
              g.playtime_minutes,
              m.igdb_id,
              m.igdb_name,
              m.backloggd_slug,
              m.confidence
       FROM games g
       LEFT JOIN matches m ON m.steam_app_id = g.app_id
       WHERE g.stale = 0
       ORDER BY g.app_id`,
    )
    .all() as GameWithMatchRow[];

  // --- Generate proposals ------------------------------------------------
  let ownershipCount = 0;
  let statusCount = 0;
  let playlogCount = 0;
  let reviewCount = 0;

  const upsertStmt = database.prepare(`
    INSERT INTO proposals
      (id, import_session_id, steam_app_id, steam_title,
       igdb_id, igdb_name, backloggd_slug,
       proposal_kind, status, match_confidence,
       requires_manual_review, suggested_payload, notes, decision_notes,
       created_at, updated_at)
    VALUES
      (?, ?, ?, ?,
       ?, ?, ?,
       ?, ?, ?,
       ?, ?, ?, NULL,
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ON CONFLICT(import_session_id, steam_app_id, proposal_kind) DO UPDATE SET
      steam_title = excluded.steam_title,
      igdb_id = excluded.igdb_id,
      igdb_name = excluded.igdb_name,
      backloggd_slug = excluded.backloggd_slug,
      match_confidence = excluded.match_confidence,
      requires_manual_review = excluded.requires_manual_review,
      suggested_payload = excluded.suggested_payload,
      status = CASE
        WHEN proposals.status = 'approved' AND (
             proposals.steam_title           IS NOT excluded.steam_title
          OR proposals.igdb_id               IS NOT excluded.igdb_id
          OR proposals.igdb_name             IS NOT excluded.igdb_name
          OR proposals.backloggd_slug        IS NOT excluded.backloggd_slug
          OR proposals.match_confidence      IS NOT excluded.match_confidence
          OR proposals.requires_manual_review IS NOT excluded.requires_manual_review
          OR proposals.suggested_payload     IS NOT excluded.suggested_payload
        ) THEN 'blocked'
        WHEN proposals.status = 'approved' THEN proposals.status
        WHEN proposals.status IN ('skipped', 'deferred', 'blocked', 'applied', 'failed')
          THEN proposals.status
        ELSE excluded.status
      END,
      notes = CASE
        WHEN proposals.status = 'approved' THEN excluded.notes
        WHEN proposals.notes IS NOT NULL AND length(trim(proposals.notes)) > 0
          THEN proposals.notes
        ELSE excluded.notes
      END,
      decision_notes = CASE
        WHEN proposals.status = 'approved' AND (
             proposals.steam_title           IS NOT excluded.steam_title
          OR proposals.igdb_id               IS NOT excluded.igdb_id
          OR proposals.igdb_name             IS NOT excluded.igdb_name
          OR proposals.backloggd_slug        IS NOT excluded.backloggd_slug
          OR proposals.match_confidence      IS NOT excluded.match_confidence
          OR proposals.requires_manual_review IS NOT excluded.requires_manual_review
          OR proposals.suggested_payload     IS NOT excluded.suggested_payload
        ) THEN
          CASE WHEN proposals.decision_notes IS NOT NULL AND length(trim(proposals.decision_notes)) > 0
            THEN proposals.decision_notes || ' | drift: previously approved target/payload changed — requires re-review'
            ELSE 'drift: previously approved target/payload changed — requires re-review'
          END
        WHEN proposals.decision_notes IS NOT NULL AND length(trim(proposals.decision_notes)) > 0
          THEN proposals.decision_notes
        ELSE excluded.decision_notes
      END,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  `);

  const transaction = database.transaction(() => {
    for (const row of rows) {
      const needsReview = requiresManualReview(row.confidence);
      const hasTarget = row.igdb_id !== null && row.backloggd_slug !== null;

      // --- Ownership proposal (always review-visible for active games) ----
      const ownership = ownershipDefaults(row);
      upsertStmt.run(
        randomUUID(),
        sessionId,
        row.app_id,
        row.steam_title,
        row.igdb_id,
        row.igdb_name,
        row.backloggd_slug,
        'ownership',
        ownership.status,
        row.confidence ?? 'unmatched',
        ownership.requiresManualReview,
        ownership.payload,
        ownership.note,
      );
      ownershipCount++;
      if (ownership.requiresManualReview === 1) reviewCount++;

      // --- Status proposal (always upsert for drift detection) ------------
      // Only count as newly created when policy explicitly opts in.
      const shouldCreateStatus =
        policy.playtimeThresholdMinutes !== undefined ||
        policy.suggestBacklogWhenZeroPlaytime === true;

      {
        const payload = sharedStatusPayload(row.playtime_minutes, policy);
        upsertStmt.run(
          randomUUID(),
          sessionId,
          row.app_id,
          row.steam_title,
          row.igdb_id,
          row.igdb_name,
          row.backloggd_slug,
          'status',
          'pending',
          row.confidence ?? 'unmatched',
          needsReview ? 1 : 0,
          payload,
          null,
        );
        if (shouldCreateStatus && hasTarget) {
          statusCount++;
          if (needsReview) reviewCount++;
        }
      }

      // --- Playlog proposal (always upsert for drift detection) -----------
      {
        const payload = sharedPlaylogPayload(row.playtime_minutes);
        upsertStmt.run(
          randomUUID(),
          sessionId,
          row.app_id,
          row.steam_title,
          row.igdb_id,
          row.igdb_name,
          row.backloggd_slug,
          'playlog',
          'pending',
          row.confidence ?? 'unmatched',
          needsReview ? 1 : 0,
          payload,
          null,
        );
        if (policy.enablePlaylogSuggestion === true && hasTarget) {
          playlogCount++;
          if (needsReview) reviewCount++;
        }
      }
    }

    // --- Update session counters -----------------------------------------
    const totalProposals = ownershipCount + statusCount + playlogCount;

    // Count matched games (games with at least a non‑null IGDB ID)
    const matchedCount = rows.filter((r) => r.igdb_id !== null).length;

    database
      .prepare(
        `UPDATE import_sessions
         SET total_games = ?,
             matched_games = ?,
             proposed_changes = ?,
             policy_json = ?
         WHERE id = ?`,
      )
      .run(rows.length, matchedCount, totalProposals, policyJson, sessionId);
  });

  transaction();

  return {
    sessionId,
    totalGames: rows.length,
    ownershipProposals: ownershipCount,
    statusProposals: statusCount,
    playlogProposals: playlogCount,
    requiresReview: reviewCount,
  };
}
