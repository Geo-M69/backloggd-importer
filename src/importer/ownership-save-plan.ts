/**
 * Ownership save plan — Phase 5C Slice 1.
 *
 * This module is a pure "save plan" layer that identifies which approved
 * ownership import items are eligible to be shown to the user for Phase 5C
 * confirmation.
 *
 * It answers:
 *   "Which approved ownership items are safe candidates for a later
 *    user-confirmed Backloggd write?"
 *
 * ## Safety guarantees
 *
 * - No browser/page argument accepted.
 * - Playwright is not imported.
 * - No navigation, no Backloggd reads.
 * - No calls to `readVisibleBackloggdState`, `compareOwnership`,
 *   `runOwnershipComparison`.
 * - No transition of import item state.
 * - No calls to `processItem`, `revealLogOrReviewModal`.
 * - Database-only and deterministic.
 * - Re-running the planner is idempotent.
 */

import type Database from 'better-sqlite3';
import { getItemsBySession } from './import-items.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Regex to parse a reconciliation proof from outcome_reason.
 *
 * The format set by reconcileItem() is:
 *   reconciled:absent:{reason}:checkedAt={checkedAt}
 *
 * Where {reason} is nonempty and {checkedAt} is an ISO-8601 timestamp.
 * The reason must NOT contain the literal substring `:checkedAt=` to
 * prevent ambiguity with the trailing delimiter.
 */
const RECONCILED_ABSENT_RE = /^reconciled:absent:(?<reason>.+):checkedAt=(?<checkedAt>.+)$/;

/** Regex to validate ISO timestamps (accepts date plus at least the hour). */
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Platform and ownership type parsed from a frozen ownership payload.
 */
export interface ParsedOwnershipPayload {
  platform: string;
  ownershipType: string;
}

/**
 * Parsed reconciliation proof extracted from an import item's outcome_reason.
 */
export interface ParsedAbsentProof {
  reason: string;
  checkedAt: string;
}

/**
 * One candidate item in the save plan, with enough human-readable detail
 * for a later user confirmation prompt.
 */
export interface SavePlanCandidate {
  /** Proposal ID (also the import item PK). */
  proposalId: string;
  /** Import session ID. */
  sessionId: string;
  /** Steam AppID. */
  steamAppId: number;
  /** Game title from the games table (may be null). */
  gameTitle: string | null;
  /** Canonical Backloggd slug. */
  backloggdSlug: string | null;
  /** Full Backloggd game-page URL (constructed from slug). */
  backloggdUrl: string | null;
  /** Desired ownership platform (from frozen payload). */
  desiredPlatform: string;
  /** Desired ownership type (from frozen payload). */
  desiredOwnershipType: string;
  /** Prior comparison/reconciliation proof summary. */
  proofSummary: string;
  /** Human-readable explanation safe for user-facing confirmation. */
  explanation: string;
  /** Machine-readable eligibility status — always 'eligible' for candidates. */
  eligibility: 'eligible';
}

/**
 * Counts of eligible and excluded items by category.
 */
export interface SavePlanCounts {
  /** Number of items that passed all checks and appear as candidates. */
  eligibleCandidates: number;
  /** Items whose status is `saved` or `skipped` (terminal). */
  excludedTerminal: number;
  /** Items whose proposal_kind is not `ownership`. */
  excludedUnsupportedKind: number;
  /** Items whose status is not `approved` (excluding terminal), or whose
   *  frozen ownership payload is malformed. */
  excludedMalformedMetadata: number;
  /** Approved ownership items without a valid absent reconciliation proof. */
  excludedMissingOrInvalidAbsentProof: number;
  /** Items whose canonical proposal is missing, session-steam-kind mismatch,
   *  or not in `approved` status. */
  excludedStaleCanonical: number;
}

/**
 * Complete ownership save plan for a session.
 */
export interface OwnershipSavePlan {
  /** Import session ID. */
  sessionId: string;
  /** Deterministically ordered list of eligible candidates. */
  candidates: SavePlanCandidate[];
  /** Counts of eligible and excluded items. */
  counts: SavePlanCounts;
  /** ISO timestamp when the plan was built. */
  builtAt: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse an ownership payload from a frozen payload JSON string.
 *
 * Returns null when the payload is missing, invalid JSON, or lacks the
 * required `platform` and `ownershipType` string fields with nonempty
 * trimmed values.
 */
function parseOwnershipPayload(frozenPayload: string | null): ParsedOwnershipPayload | null {
  if (!frozenPayload) return null;
  try {
    const parsed = JSON.parse(frozenPayload);
    if (typeof parsed.platform !== 'string' || typeof parsed.ownershipType !== 'string') {
      return null;
    }
    const platform = parsed.platform.trim();
    const ownershipType = parsed.ownershipType.trim();
    if (platform.length === 0 || ownershipType.length === 0) return null;
    return { platform, ownershipType };
  } catch {
    return null;
  }
}

/**
 * Parse a reconciliation proof from an import item's outcome_reason.
 *
 * The outcome_reason format set by reconcileItem() is:
 *   reconciled:absent:{reason}:checkedAt={ISO timestamp}
 *
 * Returns null if the string does not match the expected format, or the
 * extracted fields are empty or have an invalid timestamp.
 */
function parseAbsentProof(outcomeReason: string | null): ParsedAbsentProof | null {
  if (!outcomeReason) return null;
  const match = RECONCILED_ABSENT_RE.exec(outcomeReason);
  if (!match?.groups) return null;

  const reason = match.groups.reason.trim();
  const checkedAt = match.groups.checkedAt.trim();

  if (reason.length === 0) return null;

  // Reject reasons containing `:checkedAt=` to prevent delimiter ambiguity.
  // The proof format uses `:checkedAt=` as a literal delimiter; a reason
  // that itself contains that substring would make the parse ambiguous
  // even though the regex backtracks to the last occurrence.
  if (reason.includes(':checkedAt=')) return null;

  // Validate ISO timestamp format (must at least be YYYY-MM-DDTHH:MM:SS)
  if (!ISO_TIMESTAMP_RE.test(checkedAt)) return null;

  // Validate the timestamp represents a real, canonical ISO date.
  // new Date() silently normalises impossible dates (e.g. Feb 31 → Mar 3)
  // and accepts non-canonical variants (missing ms, offset timezones).
  // Round-tripping through toISOString() rejects all of these because
  // toISOString() always emits the canonical UTC form with milliseconds.
  const parsed = new Date(checkedAt);
  if (Number.isNaN(parsed.getTime())) return null;
  if (parsed.toISOString() !== checkedAt) return null;

  return { reason, checkedAt };
}

/**
 * Look up the game title from the games table.
 */
function getGameTitle(db: Database.Database, steamAppId: number): string | null {
  const row = db.prepare('SELECT title FROM games WHERE app_id = ?').get(steamAppId) as
    { title: string } | undefined;
  return row?.title ?? null;
}

// ---------------------------------------------------------------------------
// Plan builder
// ---------------------------------------------------------------------------

/**
 * Options for building an ownership save plan.
 */
export interface BuildSavePlanOptions {
  /** Database instance. */
  db: Database.Database;
  /** Import session ID to build the plan for. */
  sessionId: string;
}

/**
 * Build a deterministic, reviewable ownership save plan for a session.
 *
 * The plan identifies which approved ownership import items are eligible
 * for a later user-confirmed Backloggd write.  It is read-only with respect
 * to Backloggd and browser state — it only reads database rows and validates
 * frozen payloads.
 *
 * Exclusion priority (each item falls into exactly one category):
 *   1. Terminal status (saved / skipped).
 *   2. Non-ownership proposal kind.
 *   3. Non-approved status (importing / failed).
 *   4. Canonical proposal missing, session mismatch, appid mismatch, kind
 *      mismatch, or status not approved.
 *   5. Malformed frozen ownership payload.
 *   6. Missing or invalid absent reconciliation proof.
 *   7. Eligible candidate.
 *
 * @returns The complete save plan with candidates, counts, and metadata.
 */
export function buildOwnershipSavePlan(options: BuildSavePlanOptions): OwnershipSavePlan {
  const { db, sessionId } = options;
  const builtAt = new Date().toISOString();

  const candidates: SavePlanCandidate[] = [];
  const counts: SavePlanCounts = {
    eligibleCandidates: 0,
    excludedTerminal: 0,
    excludedUnsupportedKind: 0,
    excludedMalformedMetadata: 0,
    excludedMissingOrInvalidAbsentProof: 0,
    excludedStaleCanonical: 0,
  };

  // Get all import items for this session (no status filter — we need to
  // evaluate exclusion categories across all items for complete counts).
  const allItems = getItemsBySession(db, sessionId);

  for (const item of allItems) {
    // -----------------------------------------------------------------------
    // 1. Exclusion: terminal items (saved, skipped)
    // -----------------------------------------------------------------------
    if (item.status === 'saved' || item.status === 'skipped') {
      counts.excludedTerminal++;
      continue;
    }

    // -----------------------------------------------------------------------
    // 2. Exclusion: non-ownership proposal kind
    // -----------------------------------------------------------------------
    if (item.proposalKind !== 'ownership') {
      counts.excludedUnsupportedKind++;
      continue;
    }

    // -----------------------------------------------------------------------
    // 3. Exclusion: non-approved status (importing, failed)
    // -----------------------------------------------------------------------
    if (item.status !== 'approved') {
      counts.excludedMalformedMetadata++;
      continue;
    }

    // -----------------------------------------------------------------------
    // 4. Exclusion: stale canonical proposal
    //    Checks: exists, same session, same steam_app_id, kind is ownership,
    //    status is approved, backloggd_slug is nonempty.
    // -----------------------------------------------------------------------
    const canonical = db
      .prepare(
        `SELECT import_session_id, steam_app_id, proposal_kind, status,
                backloggd_slug
         FROM proposals WHERE id = ?`,
      )
      .get(item.proposalId) as
      | {
          import_session_id: string;
          steam_app_id: number;
          proposal_kind: string;
          status: string;
          backloggd_slug: string | null;
        }
      | undefined;

    if (!canonical) {
      counts.excludedStaleCanonical++;
      continue;
    }

    if (canonical.import_session_id !== sessionId) {
      counts.excludedStaleCanonical++;
      continue;
    }

    if (canonical.steam_app_id !== item.steamAppId) {
      counts.excludedStaleCanonical++;
      continue;
    }

    if (canonical.proposal_kind !== 'ownership') {
      counts.excludedStaleCanonical++;
      continue;
    }

    if (canonical.status !== 'approved') {
      counts.excludedStaleCanonical++;
      continue;
    }

    // Canonical backloggd_slug must be nonempty — the user-confirmed save
    // flow needs a safe Backloggd page target.
    const canonicalSlug = (canonical.backloggd_slug ?? '').trim();
    if (canonicalSlug.length === 0) {
      counts.excludedStaleCanonical++;
      continue;
    }

    // -----------------------------------------------------------------------
    // 5. Exclusion: malformed frozen ownership payload
    // -----------------------------------------------------------------------
    const payload = parseOwnershipPayload(item.frozenPayload);
    if (!payload) {
      counts.excludedMalformedMetadata++;
      continue;
    }

    // -----------------------------------------------------------------------
    // 6. Exclusion: missing or invalid absent reconciliation proof
    // -----------------------------------------------------------------------
    const absentProof = parseAbsentProof(item.outcomeReason);
    if (!absentProof) {
      counts.excludedMissingOrInvalidAbsentProof++;
      continue;
    }

    // -----------------------------------------------------------------------
    // 7. Eligible candidate — build candidate record
    // -----------------------------------------------------------------------
    const gameTitle = getGameTitle(db, item.steamAppId);
    const backloggdUrl = `https://backloggd.com/games/${encodeURIComponent(canonicalSlug)}/`;

    candidates.push({
      proposalId: item.proposalId,
      sessionId: item.importSessionId,
      steamAppId: item.steamAppId,
      gameTitle,
      backloggdSlug: canonicalSlug,
      backloggdUrl,
      desiredPlatform: payload.platform,
      desiredOwnershipType: payload.ownershipType,
      proofSummary: absentProof.reason,
      explanation:
        'Steam/Digital ownership is absent on Backloggd; candidate for user-confirmed add.',
      eligibility: 'eligible',
    });
  }

  // -------------------------------------------------------------------------
  // Deterministic sort: by steam_app_id (ascending), then proposal_id (locale)
  // -------------------------------------------------------------------------
  candidates.sort((a, b) => {
    if (a.steamAppId !== b.steamAppId) return a.steamAppId - b.steamAppId;
    return a.proposalId.localeCompare(b.proposalId);
  });

  counts.eligibleCandidates = candidates.length;

  return {
    sessionId,
    candidates,
    counts,
    builtAt,
  };
}
