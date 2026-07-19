/**
 * Ownership comparison runner — Phase 5B Slice 2.
 *
 * Wires the read-only Backloggd ownership reader/comparator (Phase 5B Slice 1)
 * into the Phase 5A import item state machine.
 *
 * This coordinator processes approved ownership import items by:
 *   1. navigating the matched Backloggd game page;
 *   2. reading visible ownership state with `readVisibleBackloggdState`;
 *   3. comparing it with the approved ownership proposal using `compareOwnership`;
 *   4. updating the import item checkpoint according to the comparison result.
 *
 * No account writes, no staging, no user-confirmation.  Write-guarded tests
 * prove no mutation occurs.
 */

import type Database from 'better-sqlite3';
import type { Page } from 'playwright';
import {
  getItemsBySession,
  getItem,
  transitionItem,
  reconcileItem,
  recalculateSessionCounters,
} from './import-items.js';
import type { ImportItem, ReconciliationProof } from './import-items.js';
import { readVisibleBackloggdState } from '../backloggd/visible-state.js';
import { compareOwnership } from '../backloggd/comparison.js';
import type { OwnershipProposal } from '../backloggd/comparison.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OwnershipComparisonRunnerResult {
  /** Number of approved ownership items processed. */
  processed: number;
  /** Items that became `skipped` because ownership already present. */
  alreadyPresent: number;
  /** Items that returned to `approved` because ownership change is needed. */
  changeNeeded: number;
  /** Items that became `failed` due to a conflict. */
  conflict: number;
  /** Items that became `failed` due to an unknown/deterministic read. */
  unknown: number;
  /** Items left `importing` because the page read failed or browser disappeared. */
  leftImporting: number;
  /** Items that became `failed` because the frozen payload was malformed. */
  malformed: number;
  /** Items skipped because they are not ownership kind. */
  unsupportedKind: number;
  /** Session-level blocker that stopped further processing, if detected. */
  sessionBlocker?: 'login' | 'challenge' | 'rate-limit';
  /** True when --max-items caused a clean stop before all items were processed. */
  completedDueToBatchLimit?: boolean;
  /** Breakdown of unsupported-read failure reasons (diagnostic notes → count). */
  unsupportedReadDetailCounts?: Record<string, number>;
}

export interface OwnershipComparisonRunnerOptions {
  /** Database instance. */
  db: Database.Database;
  /** Import session ID to process items for. */
  sessionId: string;
  /** Playwright page, navigable by the runner. */
  page: Page;
  /** Timeout passed to `readVisibleBackloggdState`. */
  timeout?: number;
  /**
   * Custom URL resolver for navigation.
   *
   * Default constructs `https://backloggd.com/games/{slug}/`.
   * Tests override this to point at fixture files, e.g.
   * `(item) => \`file:///fixtures/${slug}.html\``.
   */
  resolvePageUrl?: (slug: string, item: ImportItem) => string;
  /**
   * Maximum number of approved ownership items to process in this run.
   * Items beyond the limit remain approved and retryable.
   * Must be a positive integer.
   */
  maxItems?: number;
  /**
   * Delay in milliseconds between slug group page reads.
   * Helps avoid rate-limiting under aggressive re-reads.
   * Must be a non-negative integer.
   */
  delayMs?: number;
  /** Injectable sleep function for testing. Defaults to `setTimeout`-based delay. */
  sleep?: (ms: number) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BACKLOGGD_GAME_BASE = 'https://backloggd.com/games/';

/**
 * Parse an ownership proposal from a frozen payload JSON string.
 *
 * Returns null when the payload is missing, not valid JSON, or lacks the
 * required `platform` and `ownershipType` string fields.
 */
function parseOwnershipPayload(frozenPayload: string | null): OwnershipProposal | null {
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
 * Look up the game title from the games table.
 */
function getGameTitle(db: Database.Database, steamAppId: number): string | null {
  const row = db.prepare('SELECT title FROM games WHERE app_id = ?').get(steamAppId) as
    { title: string } | undefined;
  return row?.title ?? null;
}

/**
 * Sanitize a reason string for use as outcome_reason / last_error.
 * Only allows alphanumeric, colon, underscore, hyphen.
 */
function sanitizeReason(reason: string): string {
  return reason.replace(/[^a-zA-Z0-9:_-]/g, '_').substring(0, 200);
}

function isSessionBlockerPageType(
  pageType: string,
): pageType is 'login' | 'challenge' | 'rate-limit' {
  return pageType === 'login' || pageType === 'challenge' || pageType === 'rate-limit';
}

// ---------------------------------------------------------------------------
// Default URL resolver
// ---------------------------------------------------------------------------

function defaultResolvePageUrl(slug: string): string {
  // Ensure the slug is URL-safe and ends with a trailing slash
  const encoded = encodeURIComponent(slug);
  return `${BACKLOGGD_GAME_BASE}${encoded}/`;
}

// ---------------------------------------------------------------------------
// State transition helpers
// ---------------------------------------------------------------------------

/**
 * Map a comparison classification to the appropriate state transition.
 *
 * Returns a thunk that performs the transition or reconciliation.
 */
function applyComparisonResult(
  db: Database.Database,
  proposalId: string,
  classification: string,
  reasonCode: string,
  diagnosticNotes?: string[],
): void {
  switch (classification) {
    case 'already-present': {
      transitionItem(db, proposalId, 'skipped', {
        outcomeReason: `already-present:ownership`,
      });
      break;
    }
    case 'change-needed': {
      const checkedAt = new Date().toISOString();
      const proof: ReconciliationProof = {
        result: 'absent',
        checkedAt,
        reason: `ownership-change-needed:${reasonCode}`,
      };
      reconcileItem(db, proposalId, proof);
      break;
    }
    case 'conflict': {
      transitionItem(db, proposalId, 'failed', {
        outcomeReason: sanitizeReason(`conflict:ownership:${reasonCode}`),
        lastError: sanitizeReason(`Conflict: ownership ${reasonCode}`),
      });
      break;
    }
    case 'unknown': {
      const lastError = diagnosticNotes?.length
        ? sanitizeReason(diagnosticNotes[0].substring(0, 200))
        : sanitizeReason(`Unknown: ownership ${reasonCode}`);
      transitionItem(db, proposalId, 'failed', {
        outcomeReason: sanitizeReason(`unknown:ownership:${reasonCode}`),
        lastError,
      });
      break;
    }
    default: {
      // Safety net for unrecognised classifications.
      transitionItem(db, proposalId, 'failed', {
        outcomeReason: sanitizeReason(
          `unknown:ownership:unexpected-classification:${classification}`,
        ),
        lastError: sanitizeReason(`Unexpected classification: ${classification}`),
      });
    }
  }
}

async function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Process all approved ownership import items for a session.
 *
 * Validation occurs in three phases before any browser work:
 *
 *   Phase A — Pre-payload metadata: confirm canonical proposal exists,
 *     belongs to this session, matches steam_app_id, has kind `ownership`,
 *     and status `approved`.  No slug is fetched in this phase.
 *
 *   Phase B — Payload validation: parse and validate frozen ownership
 *     payload.  Malformed payloads fail before any slug lookup.
 *
 *   Phase C — Page-target lookup: fetch canonical backloggd_slug, group
 *     by slug, navigate, read visible state, and compare.
 *
 * For each item that reaches Phase C the runner:
 *   1. Transitions `approved → importing`.
 *   2. Navigates the page to the matched Backloggd game page.
 *   3. Reads visible ownership state.
 *   4. Compares the approved ownership proposal to visible state.
 *   5. Applies the checkpoint result.
 *
 * Session counters are recalculated after processing.
 *
 * Multiple ownership proposals for the same canonical slug share a single
 * page navigation and read.  Each proposal is compared independently.
 *
 * @returns A summary of processed items and their outcomes.
 */
export async function runOwnershipComparison(
  options: OwnershipComparisonRunnerOptions,
): Promise<OwnershipComparisonRunnerResult> {
  const { db, sessionId, page, timeout } = options;
  const resolvePageUrl = options.resolvePageUrl ?? defaultResolvePageUrl;
  const sleep = options.sleep ?? defaultSleep;

  const result: OwnershipComparisonRunnerResult = {
    processed: 0,
    alreadyPresent: 0,
    changeNeeded: 0,
    conflict: 0,
    unknown: 0,
    leftImporting: 0,
    malformed: 0,
    unsupportedKind: 0,
  };

  // -------------------------------------------------------------------------
  // 1. Gather approved ownership items
  // -------------------------------------------------------------------------
  const allItems = getItemsBySession(db, sessionId, 'approved');
  const ownershipItems = allItems.filter((item) => item.proposalKind === 'ownership');
  const nonOwnershipItems = allItems.filter((item) => item.proposalKind !== 'ownership');

  // Non-ownership items are not processed by this slice.
  result.unsupportedKind = nonOwnershipItems.length;

  if (ownershipItems.length === 0) {
    return result;
  }

  // -------------------------------------------------------------------------
  // 1b. Apply maxItems limit — slice approved items to the requested batch size
  // -------------------------------------------------------------------------
  const itemsToProcess =
    options.maxItems !== undefined ? ownershipItems.slice(0, options.maxItems) : ownershipItems;

  if (itemsToProcess.length === 0) {
    return result;
  }

  // -------------------------------------------------------------------------
  // 2. Validate each ownership item against canonical proposals and payload
  //    BEFORE any browser work (Findings 1 & 2 — Phase 5B Slice 2).
  //
  //    Validation happens in three phases:
  //
  //    Phase A — Pre-payload metadata validation (no slug lookup).
  //      Confirms canonical proposal exists, belongs to this session,
  //      matches steam_app_id, has kind `ownership`, and status `approved`.
  //
  //    Phase B — Payload validation.
  //      Parses the frozen ownership payload.  If malformed, fails before
  //      any slug lookup, grouping, navigation, or page read.
  //
  //    Phase C — Page-target lookup.
  //      Only after Phase A and B pass: fetch canonical backloggd_slug,
  //      group by slug, and proceed to read-only navigation/comparison.
  // -------------------------------------------------------------------------

  /**
   * Validated item ready for page-read grouping.
   */
  interface ValidatedItem {
    item: ImportItem;
    proposal: OwnershipProposal;
    slug: string;
  }
  const validatedItems: ValidatedItem[] = [];

  for (const item of itemsToProcess) {
    // -----------------------------------------------------------------------
    // Phase A — Pre-payload metadata validation (no slug)
    // -----------------------------------------------------------------------
    const canonicalMeta = db
      .prepare(
        `SELECT import_session_id, steam_app_id, proposal_kind, status
         FROM proposals WHERE id = ?`,
      )
      .get(item.proposalId) as
      | {
          import_session_id: string;
          steam_app_id: number;
          proposal_kind: string;
          status: string;
        }
      | undefined;

    if (!canonicalMeta) {
      transitionItem(db, item.proposalId, 'importing');
      transitionItem(db, item.proposalId, 'failed', {
        outcomeReason: 'malformed:ownership:metadata-mismatch',
        lastError: 'Canonical proposal not found',
      });
      result.malformed++;
      continue;
    }

    if (canonicalMeta.import_session_id !== sessionId) {
      transitionItem(db, item.proposalId, 'importing');
      transitionItem(db, item.proposalId, 'failed', {
        outcomeReason: 'malformed:ownership:metadata-mismatch',
        lastError: 'Canonical proposal belongs to different session',
      });
      result.malformed++;
      continue;
    }

    if (canonicalMeta.steam_app_id !== item.steamAppId) {
      transitionItem(db, item.proposalId, 'importing');
      transitionItem(db, item.proposalId, 'failed', {
        outcomeReason: 'malformed:ownership:metadata-mismatch',
        lastError: 'Canonical steam_app_id mismatch',
      });
      result.malformed++;
      continue;
    }

    if (canonicalMeta.proposal_kind !== 'ownership') {
      transitionItem(db, item.proposalId, 'importing');
      transitionItem(db, item.proposalId, 'failed', {
        outcomeReason: 'malformed:ownership:metadata-mismatch',
        lastError: 'Canonical proposal kind is not ownership',
      });
      result.malformed++;
      continue;
    }

    if (item.proposalKind !== canonicalMeta.proposal_kind) {
      transitionItem(db, item.proposalId, 'importing');
      transitionItem(db, item.proposalId, 'failed', {
        outcomeReason: 'malformed:ownership:metadata-mismatch',
        lastError: 'Import item proposal_kind mismatch',
      });
      result.malformed++;
      continue;
    }

    // --- Finding 1: Canonical proposal must be approved ---
    if (canonicalMeta.status !== 'approved') {
      transitionItem(db, item.proposalId, 'importing');
      transitionItem(db, item.proposalId, 'failed', {
        outcomeReason: 'malformed:ownership:metadata-mismatch',
        lastError: 'Canonical proposal status is not approved',
      });
      result.malformed++;
      continue;
    }

    // -----------------------------------------------------------------------
    // Phase B — Payload validation (no slug, no navigation, no page read)
    // -----------------------------------------------------------------------
    const parsedProposal = parseOwnershipPayload(item.frozenPayload);
    if (!parsedProposal) {
      transitionItem(db, item.proposalId, 'importing');
      transitionItem(db, item.proposalId, 'failed', {
        outcomeReason: 'malformed:ownership:invalid-payload',
        lastError: 'Ownership frozen payload is missing or malformed',
      });
      result.malformed++;
      continue;
    }

    // -----------------------------------------------------------------------
    // Phase C — Page-target lookup (only after Phase A and B pass)
    // -----------------------------------------------------------------------
    const slugRow = db
      .prepare('SELECT backloggd_slug FROM proposals WHERE id = ?')
      .get(item.proposalId) as { backloggd_slug: string | null } | undefined;

    if (!slugRow?.backloggd_slug) {
      transitionItem(db, item.proposalId, 'importing');
      transitionItem(db, item.proposalId, 'failed', {
        outcomeReason: 'unknown:ownership:no-slug',
        lastError: 'No backloggd_slug found for proposal',
      });
      result.unknown++;
      continue;
    }

    validatedItems.push({
      item,
      proposal: parsedProposal,
      slug: slugRow.backloggd_slug,
    });
  }

  if (validatedItems.length === 0) {
    recalculateSessionCounters(db, sessionId);
    return result;
  }

  // -------------------------------------------------------------------------
  // 3. Group validated items by canonical page target (slug) for shared reads
  //
  //    Grouping by slug (rather than steamAppId) ensures that items pointing
  //    at different Backloggd pages never share a single page read.
  // -------------------------------------------------------------------------
  const bySlug = new Map<string, ValidatedItem[]>();
  for (const vi of validatedItems) {
    const group = bySlug.get(vi.slug);
    if (group) {
      group.push(vi);
    } else {
      bySlug.set(vi.slug, [vi]);
    }
  }

  // -------------------------------------------------------------------------
  // 4. Process each slug group
  // -------------------------------------------------------------------------
  let isFirstSlugGroup = true;
  for (const [slug, slugItems] of bySlug) {
    // Delay before each group except the first (pacing between page reads)
    if (!isFirstSlugGroup && options.delayMs !== undefined && options.delayMs > 0) {
      await sleep(options.delayMs);
    }
    isFirstSlugGroup = false;
    // 4a. Re-check each item is still approved (defensive — avoid races)
    const stillApproved = slugItems.filter((vi) => {
      const fresh = getItem(db, vi.item.proposalId);
      return fresh !== null && fresh.status === 'approved';
    });

    if (stillApproved.length === 0) continue;

    // 4b. Transition all items in this group to importing
    for (const vi of stillApproved) {
      try {
        transitionItem(db, vi.item.proposalId, 'importing');
      } catch {
        // If transition fails (e.g. illegal state), skip this item
        continue;
      }
    }

    // Re-check which ones actually transitioned
    const importingItems = stillApproved.filter((vi) => {
      const fresh = getItem(db, vi.item.proposalId);
      return fresh !== null && fresh.status === 'importing';
    });

    if (importingItems.length === 0) continue;

    // 4c. Look up game title
    const firstItem = importingItems[0];
    const gameTitle = getGameTitle(db, firstItem.item.steamAppId);

    // 4d. Navigate to the game page
    let visibleState: Awaited<ReturnType<typeof readVisibleBackloggdState>> | null = null;
    try {
      const targetUrl = resolvePageUrl(slug, firstItem.item);
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: timeout ?? 10000 });
      visibleState = await readVisibleBackloggdState(page, gameTitle ?? '', slug, { timeout });
    } catch {
      // Browser disappearance or page-read failure — leave all items importing
      // for later reconciliation (Phase 5C or explicit retry).
      result.leftImporting += importingItems.length;
      continue;
    }

    // 4e. Verify the page is usable (not a blocker page)
    if (!visibleState.game.verified || visibleState.diagnostics.pageType !== 'game') {
      // If the page is a blocker (login/challenge/rate-limit) or unverified,
      // fail only the current slug group deterministically.  Session-level
      // blockers then stop the runner so later approved rows remain retryable.
      const pageType = visibleState.diagnostics.pageType;
      const reasonCode = pageType !== 'game' ? `page-type:${pageType}` : 'game-verification-failed';
      for (const vi of importingItems) {
        transitionItem(db, vi.item.proposalId, 'failed', {
          outcomeReason: sanitizeReason(`unknown:ownership:${reasonCode}`),
          lastError: sanitizeReason(`Page not ready: ${reasonCode}`),
        });
        result.unknown++;
      }
      if (isSessionBlockerPageType(pageType)) {
        result.sessionBlocker = pageType;
        break;
      }
      continue;
    }

    // 4f. Compare each proposal independently
    for (const vi of importingItems) {
      // Proposal was already parsed and validated in step 2 (Finding 1)
      const comparison = compareOwnership(vi.proposal, visibleState.library);

      // Capture diagnostic notes from visible-state reader
      const diagnosticNotes =
        comparison.reasonCode === 'unsupported-read' ? visibleState.diagnostics.notes : undefined;

      // Apply result
      applyComparisonResult(
        db,
        vi.item.proposalId,
        comparison.classification,
        comparison.reasonCode,
        diagnosticNotes,
      );

      // Accumulate unsupported-read diagnostic detail breakdown
      if (
        comparison.reasonCode === 'unsupported-read' &&
        diagnosticNotes &&
        diagnosticNotes.length > 0
      ) {
        result.unsupportedReadDetailCounts ??= {};
        const noteKey = sanitizeReason(diagnosticNotes[0].substring(0, 80));
        result.unsupportedReadDetailCounts[noteKey] =
          (result.unsupportedReadDetailCounts[noteKey] ?? 0) + 1;
      }

      // Tally
      switch (comparison.classification) {
        case 'already-present':
          result.alreadyPresent++;
          break;
        case 'change-needed':
          result.changeNeeded++;
          break;
        case 'conflict':
          result.conflict++;
          break;
        case 'unknown':
          result.unknown++;
          break;
        default:
          result.unknown++;
          break;
      }
      result.processed++;
    }
  }

  // -------------------------------------------------------------------------
  // 4h. Mark batch-limit completion if maxItems was active and we stopped
  //     cleanly (no session blocker) with items remaining unprocessed.
  // -------------------------------------------------------------------------
  if (
    options.maxItems !== undefined &&
    !result.sessionBlocker &&
    ownershipItems.length > options.maxItems
  ) {
    result.completedDueToBatchLimit = true;
  }

  // -------------------------------------------------------------------------
  // 5. Recalculate session counters
  // -------------------------------------------------------------------------
  recalculateSessionCounters(db, sessionId);

  return result;
}
