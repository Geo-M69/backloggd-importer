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
  kind: string;
  payload: Record<string, unknown> | null;
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
      `SELECT p.steam_app_id,
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
    manifestVersion: '1.0.0',
    generatedAt: new Date().toISOString(),
    sessionId,
    policy,
    summary,
    items,
  };
}

function emptyManifest(sessionId: string, policy: ProposalPolicy | null): ImportManifest {
  return {
    manifestVersion: '1.0.0',
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
