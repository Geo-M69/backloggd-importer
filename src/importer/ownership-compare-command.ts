/**
 * Ownership compare command — Phase 5D Slice 3.
 *
 * Minimal explicit operator path to run the Phase 5B read-only ownership
 * comparison runner from the CLI, preparing ownership save-plan candidates
 * without any final-save or confirmation behavior.
 *
 * ## Safety guarantees
 *
 * - No final save behavior — does not call `runConfirmedOwnershipSave`.
 * - No confirmation creation — does not call `applyOwnershipConfirmationSelection`.
 * - No staging — does not call `stageOwnershipInBrowser` or
 *   `runConfirmedOwnershipStaging`.
 * - Does not call `processItem`, `transitionItem`, or `reconcileItem` directly.
 * - Delegates all comparison state changes to the audited Phase 5B runner
 *   (`runOwnershipComparison`).
 * - Does not mutate `import_items` directly — only through the comparison runner.
 * - Does not define final-save selectors or write-guard allowance logic.
 * - Pre-checks approved ownership count before browser creation.
 * - Only approved ownership items are eligible for comparison.
 * - Status/playlog proposals are ignored/rejected by the comparison runner.
 *
 * ## Required behavior
 *
 * 1. Explicit non-empty trimmed `--session <id>`.
 * 2. Explicit read-only comparison command/script (this module).
 * 3. Existing DB/session state.
 * 4. Shared browser automation path when browser work is needed.
 */

import type Database from 'better-sqlite3';
import type { Page } from 'playwright';
import {
  runOwnershipComparison,
  type OwnershipComparisonRunnerResult,
} from './ownership-comparison-runner.js';
import type { ImportItem } from './import-items.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Options for {@link runOwnershipCompareCommand}.
 */
export interface OwnershipCompareCommandOptions {
  /** Database instance. */
  db: Database.Database;
  /** Import session ID — must be non-empty after trim. */
  sessionId: string;
  /** Playwright page for browser automation. */
  page: Page;
  /** Timeout passed to page read operations. */
  timeout?: number;
  /**
   * Custom URL resolver for navigation.
   *
   * Default constructs `https://backloggd.com/games/{slug}/`.
   * Tests override this to point at fixture files.
   */
  resolvePageUrl?: (slug: string, item: ImportItem) => string;
}

/**
 * Result of running the ownership compare command.
 *
 * This is a thin wrapper around {@link OwnershipComparisonRunnerResult}
 * that preserves all distinct statuses.
 */
export type OwnershipCompareResult = OwnershipComparisonRunnerResult;

// ---------------------------------------------------------------------------
// Pre-check helpers
// ---------------------------------------------------------------------------

/**
 * Count approved ownership import items for a session.
 *
 * Pure DB read — no browser interaction.
 *
 * Returns 0 when there are no approved ownership items, allowing callers
 * to avoid browser creation entirely.
 */
export function countApprovedOwnershipItems(db: Database.Database, sessionId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS cnt
       FROM import_items
       WHERE import_session_id = ?
         AND proposal_kind = 'ownership'
         AND status = 'approved'`,
    )
    .get(sessionId) as { cnt: number } | undefined;
  return row?.cnt ?? 0;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Run the read-only ownership comparison for a session.
 *
 * This is the narrow integration entrypoint that should be called from the
 * CLI after the user has explicitly opted in via the `ownership:compare`
 * command.
 *
 * ## Required preconditions (all must be met)
 *
 * 1. `sessionId` is non-empty.
 * 2. Approved ownership import items exist for the session.
 * 3. `page` is a valid Playwright Page (browser dependency).
 *
 * ## Behavior
 *
 * - Counts approved ownership items before delegating to the comparison
 *   runner.  If none, returns a zero-initialized result without invoking
 *   the runner (caller can avoid browser creation).
 * - Delegates all comparison state changes to `runOwnershipComparison`.
 * - Returns raw `OwnershipComparisonRunnerResult` with all distinct
 *   statuses preserved.
 *
 * @throws {Error} If `sessionId` is empty or whitespace-only.
 */
export async function runOwnershipCompareCommand(
  options: OwnershipCompareCommandOptions,
): Promise<OwnershipCompareResult> {
  // -----------------------------------------------------------------------
  // Safety gate: non-empty session identifier
  // -----------------------------------------------------------------------
  const sessionId = (options.sessionId ?? '').trim();
  if (sessionId.length === 0) {
    throw new Error('sessionId is required and must be non-empty.');
  }

  // -----------------------------------------------------------------------
  // Pre-check: approved ownership items exist before any browser work
  // -----------------------------------------------------------------------
  const approvedCount = countApprovedOwnershipItems(options.db, sessionId);
  if (approvedCount === 0) {
    return {
      processed: 0,
      alreadyPresent: 0,
      changeNeeded: 0,
      conflict: 0,
      unknown: 0,
      leftImporting: 0,
      malformed: 0,
      unsupportedKind: 0,
    };
  }

  // -----------------------------------------------------------------------
  // Delegate to the audited Phase 5B comparison runner
  // -----------------------------------------------------------------------
  const runnerOptions = {
    db: options.db,
    sessionId,
    page: options.page,
    timeout: options.timeout,
    resolvePageUrl: options.resolvePageUrl,
  };

  const result = await runOwnershipComparison(runnerOptions);

  return result;
}

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------

/**
 * Determine whether a comparison result contains any "unsafe" outcomes
 * that should cause a nonzero process exit.
 *
 * Unsafe outcomes are:
 * - `conflict` > 0
 * - `unknown` > 0
 * - `leftImporting` > 0
 * - `malformed` > 0
 *
 * Returns `true` if any unsafe outcome is present (caller should exit
 * nonzero), `false` otherwise.
 */
export function hasUnsafeComparisonOutcomes(result: OwnershipCompareResult): boolean {
  return (
    result.conflict > 0 || result.unknown > 0 || result.leftImporting > 0 || result.malformed > 0
  );
}

/**
 * Format a single status line for a comparison result field.
 */
function formatStatusLine(label: string, count: number): string {
  return `  ${label}: ${count}`;
}

/**
 * Format the comparison result for display.
 */
export function formatCompareResult(result: OwnershipCompareResult): string {
  const lines: string[] = [];
  lines.push('Ownership comparison result:');
  lines.push('');

  lines.push(formatStatusLine('Processed', result.processed));
  lines.push(formatStatusLine('Already present', result.alreadyPresent));
  lines.push(formatStatusLine('Change needed', result.changeNeeded));
  lines.push(formatStatusLine('Conflict', result.conflict));
  lines.push(formatStatusLine('Unknown', result.unknown));
  lines.push(formatStatusLine('Left importing', result.leftImporting));
  lines.push(formatStatusLine('Malformed', result.malformed));
  lines.push(formatStatusLine('Unsupported kind', result.unsupportedKind));

  return lines.join('\n');
}

export default null;
