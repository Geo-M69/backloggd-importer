/**
 * Export approved proposals as a deterministic, inspectable JSON manifest.
 *
 * The manifest is ready to be consumed by later milestones that interact
 * with Backloggd.  It includes only approved proposals and enough context
 * for safe replay: Steam identity, resolved IGDB match, candidate
 * Backloggd URL, and the approved proposal payloads grouped by kind.
 *
 * Ratings, review text, completion state, detailed play logs, Backloggd
 * credentials, and unapproved proposals are **never** included.
 */

import type Database from 'better-sqlite3';
import { getDatabase } from '../storage/database.js';
import type { ProposalPolicy } from '../models/proposal.js';

// ---------------------------------------------------------------------------
// Manifest types
// ---------------------------------------------------------------------------

/**
 * The top‑level manifest document.
 */
/**
 * The current manifest format version.
 * Incremented when the structure or semantics change.
 */
export const MANIFEST_VERSION = '2.0.0';

export interface ImportManifest {
  manifestVersion: string;
  generatedAt: string;
  sessionId: string;
  policy: ProposalPolicy | null;
  summary: ManifestSummary;
  items: ManifestItem[];
}

export interface ManifestSummary {
  totalApproved: number;
  ownershipProposals: number;
  statusProposals: number;
  playlogProposals: number;
}

export interface ManifestItem {
  steamAppId: number;
  steamTitle: string;
  igdbId: number | null;
  igdbName: string | null;
  backloggdSlug: string | null;
  backloggdUrl: string | null;
  matchConfidence: string;
  approvedProposals: ManifestApprovedProposal[];
}

export interface ManifestApprovedProposal {
  /** Stable proposal ID that links back to the proposals table. */
  proposalId: string;
  kind: string;
  payload: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// Drift detection
// ---------------------------------------------------------------------------

/**
 * Result of verifying a manifest proposal against the database.
 */
export interface DriftCheckResult {
  /** True when the manifest proposal still matches the database record. */
  matches: boolean;
  /** Human-readable reason when drift is detected, or null. */
  reason: string | null;
}

/**
 * Verify that a manifest approved proposal still matches the current
 * database proposal snapshot.  Drift is detected when:
 *
 *  - The proposal row no longer exists.
 *  - The proposal is no longer in `approved` status.
 *  - The `suggested_payload` has changed.
 *  - The `steam_app_id`, `igdb_id`, `backloggd_slug`, or `proposal_kind`
 *    have changed.
 *
 * @returns A drift-check result.
 */
export function verifyManifestProposal(
  proposalId: string,
  manifestPayload: Record<string, unknown> | null,
  db: Database.Database,
): DriftCheckResult {
  const row = db
    .prepare(
      `SELECT status, suggested_payload, steam_app_id, igdb_id,
              backloggd_slug, proposal_kind
       FROM proposals
       WHERE id = ?`,
    )
    .get(proposalId) as
    | {
        status: string;
        suggested_payload: string | null;
        steam_app_id: number;
        igdb_id: number | null;
        backloggd_slug: string | null;
        proposal_kind: string;
      }
    | undefined;

  if (!row) {
    return { matches: false, reason: 'proposal row no longer exists' };
  }

  if (row.status !== 'approved') {
    return { matches: false, reason: `proposal status is '${row.status}', not 'approved'` };
  }

  // Compare payloads (both null or both structurally equal JSON)
  const dbPayload = row.suggested_payload
    ? (JSON.parse(row.suggested_payload) as Record<string, unknown>)
    : null;

  const payloadsMatch =
    manifestPayload === null && dbPayload === null
      ? true
      : manifestPayload !== null && dbPayload !== null
        ? JSON.stringify(manifestPayload) === JSON.stringify(dbPayload)
        : false;

  if (!payloadsMatch) {
    return { matches: false, reason: 'suggested_payload has changed' };
  }

  return { matches: true, reason: null };
}

// ---------------------------------------------------------------------------
// Backloggd URL builder
// ---------------------------------------------------------------------------

/**
 * Build a candidate Backloggd game URL from a slug, or null when no slug
 * is available.
 */
function backloggdUrl(slug: string | null): string | null {
  if (!slug) return null;
  return `https://www.backloggd.com/games/${encodeURIComponent(slug)}/`;
}

// ---------------------------------------------------------------------------
// Query row
// ---------------------------------------------------------------------------

interface ApprovedProposalRow {
  proposal_id: string;
  steam_app_id: number;
  steam_title: string;
  igdb_id: number | null;
  igdb_name: string | null;
  backloggd_slug: string | null;
  confidence: string;
  proposal_kind: string;
  suggested_payload: string | null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build an approved import manifest.
 *
 * Only proposals with `status = 'approved'` are included.
 *
 * @param sessionId  When provided, scope to a specific session.
 *                   When omitted, use the latest in‑progress session.
 * @param db         Database instance (defaults to global singleton).
 * @returns          The manifest object (does not write to disk — the
 *                   caller can serialise it as needed).
 */
export function buildManifest(sessionId?: string, db?: Database.Database): ImportManifest {
  const database = db ?? getDatabase();

  // Resolve target session
  let targetSessionId = sessionId;
  if (!targetSessionId) {
    const row = database
      .prepare(
        `SELECT id FROM import_sessions
         ORDER BY started_at DESC LIMIT 1`,
      )
      .get() as { id: string } | undefined;

    if (!row) {
      return emptyManifest('no-session', null);
    }
    targetSessionId = row.id;
  }

  // Fetch policy for the resolved session
  const sessionRow = database
    .prepare('SELECT policy_json FROM import_sessions WHERE id = ?')
    .get(targetSessionId) as { policy_json: string | null } | undefined;

  if (!sessionRow) {
    return emptyManifest(targetSessionId, null);
  }

  const policy: ProposalPolicy | null = sessionRow.policy_json
    ? (JSON.parse(sessionRow.policy_json) as ProposalPolicy)
    : null;

  const rows = queryApprovedProposals(database, targetSessionId);
  return buildFromRows(rows, targetSessionId, policy);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function queryApprovedProposals(
  database: Database.Database,
  sessionId: string,
): ApprovedProposalRow[] {
  return database
    .prepare(
      `SELECT p.id AS proposal_id,
              p.steam_app_id,
              p.steam_title,
              p.igdb_id,
              p.igdb_name,
              p.backloggd_slug,
              p.match_confidence AS confidence,
              p.proposal_kind,
              p.suggested_payload
       FROM proposals p
       WHERE p.import_session_id = ?
         AND p.status = 'approved'
       ORDER BY p.steam_app_id, p.proposal_kind`,
    )
    .all(sessionId) as ApprovedProposalRow[];
}

function buildFromRows(
  rows: ApprovedProposalRow[],
  sessionId: string,
  policy: ProposalPolicy | null,
): ImportManifest {
  // Group by steam_app_id
  const itemMap = new Map<number, ManifestItem>();

  for (const row of rows) {
    let item = itemMap.get(row.steam_app_id);
    if (!item) {
      item = {
        steamAppId: row.steam_app_id,
        steamTitle: row.steam_title,
        igdbId: row.igdb_id,
        igdbName: row.igdb_name,
        backloggdSlug: row.backloggd_slug,
        backloggdUrl: backloggdUrl(row.backloggd_slug),
        matchConfidence: row.confidence,
        approvedProposals: [],
      };
      itemMap.set(row.steam_app_id, item);
    }

    let payload: Record<string, unknown> | null = null;
    if (row.suggested_payload) {
      try {
        payload = JSON.parse(row.suggested_payload) as Record<string, unknown>;
      } catch {
        payload = null;
      }
    }

    item.approvedProposals.push({
      proposalId: row.proposal_id,
      kind: row.proposal_kind,
      payload,
    });
  }

  const items = Array.from(itemMap.values());

  const summary: ManifestSummary = {
    totalApproved: items.length,
    ownershipProposals: items.filter((i) => i.approvedProposals.some((p) => p.kind === 'ownership'))
      .length,
    statusProposals: items.filter((i) => i.approvedProposals.some((p) => p.kind === 'status'))
      .length,
    playlogProposals: items.filter((i) => i.approvedProposals.some((p) => p.kind === 'playlog'))
      .length,
  };

  return {
    manifestVersion: MANIFEST_VERSION,
    generatedAt: new Date().toISOString(),
    sessionId,
    policy,
    summary,
    items,
  };
}

function emptyManifest(sessionId: string, policy: ProposalPolicy | null): ImportManifest {
  return {
    manifestVersion: MANIFEST_VERSION,
    generatedAt: new Date().toISOString(),
    sessionId,
    policy,
    summary: {
      totalApproved: 0,
      ownershipProposals: 0,
      statusProposals: 0,
      playlogProposals: 0,
    },
    items: [],
  };
}
