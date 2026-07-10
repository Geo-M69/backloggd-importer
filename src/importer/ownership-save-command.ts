/**
 * Ownership save command — Phase 5D Slice 1.
 *
 * Minimal confirmed ownership save integration layer.
 *
 * Wires the Phase 5C Slice 4 confirmed ownership save executor
 * (`runConfirmedOwnershipSave`) into the project's import/CLI flow
 * behind an explicit operator action.
 *
 * ## Safety guarantees
 *
 * - Requires explicit `confirmedSaveEnabled` flag — no default path invokes
 *   final save.
 * - Requires non-empty `sessionId`.
 * - Loads durable confirmation rows (`status = 'confirmed'`) and rejects
 *   non-ownership proposal kinds before invoking the save executor.
 * - No confirmed rows → returns empty result without creating a browser
 *   page (caller can check before providing a Page dependency).
 * - Does NOT call `processItem`, `transitionItem`, or `reconcileItem`
 *   directly.
 * - Does NOT mutate `import_items` or `import_item_confirmations` directly.
 * - Delegates all final save behavior to the audited save executor
 *   (`runConfirmedOwnershipSave`).
 * - Save executor results are surfaced without remapping — each
 *   `SaveResultStatus` is preserved as-is.
 */

import type Database from 'better-sqlite3';
import type { Page } from 'playwright';
import { runConfirmedOwnershipSave } from './ownership-save-executor.js';
import type { OwnershipSaveExecutorOptions, SaveResult } from './ownership-save-executor.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Options for {@link executeConfirmedOwnershipSaves}.
 */
export interface ExecuteConfirmedOwnershipSavesOptions {
  /** Database instance. */
  db: Database.Database;
  /** Import session ID — must be non-empty. */
  sessionId: string;
  /**
   * Explicit flag that MUST be set to `true` to enable confirmed ownership
   * final saves.  When `false` or absent, the function throws.
   */
  confirmedSaveEnabled: boolean;
  /** Playwright page for browser automation. */
  page: Page;
  /** Optional timeout passed to page operations. */
  timeout?: number;
  /**
   * Optional custom URL resolver for navigation.
   *
   * Default constructs `https://backloggd.com/games/{slug}/`.
   * Tests override this to point at fixture files.
   */
  resolvePageUrl?: (slug: string) => string;
  /**
   * Dependency injection for the save executor.
   *
   * Defaults to `runConfirmedOwnershipSave` from the Slice 4 executor.
   * Tests provide a mock to verify integration behavior without real
   * browser automation.
   */
  saveExecutor?: typeof runConfirmedOwnershipSave;
}

/**
 * A single result from executing a confirmed ownership save.
 */
export type ExecuteOwnershipSaveResult = SaveResult;

// ---------------------------------------------------------------------------
// Pre-check helpers
// ---------------------------------------------------------------------------

/**
 * Count confirmed confirmation rows for a session.
 *
 * Pure DB read — no browser interaction.
 *
 * Exported so CLI/runner code can pre-check before creating a browser page.
 */
export function countConfirmedRows(db: Database.Database, sessionId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS cnt
       FROM import_item_confirmations
       WHERE import_session_id = ?
         AND status = 'confirmed'`,
    )
    .get(sessionId) as { cnt: number } | undefined;
  return row?.cnt ?? 0;
}

/**
 * Read proposal IDs from confirmed confirmation rows that have a
 * non-ownership proposal kind.  These are rejected by the integration
 * layer before the save executor is invoked.
 */
function findNonOwnershipConfirmedProposalIds(
  db: Database.Database,
  sessionId: string,
): { proposalId: string; proposalKind: string }[] {
  const rows = db
    .prepare(
      `SELECT c.proposal_id, i.proposal_kind
       FROM import_item_confirmations c
       JOIN import_items i ON i.proposal_id = c.proposal_id
       WHERE c.import_session_id = ?
         AND c.status = 'confirmed'
         AND i.proposal_kind != 'ownership'`,
    )
    .all(sessionId) as { proposal_id: string; proposal_kind: string }[];
  return rows.map((r) => ({ proposalId: r.proposal_id, proposalKind: r.proposal_kind }));
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Execute confirmed ownership saves for a session.
 *
 * This is the narrow integration entrypoint that should be called from the
 * CLI or runner after the user has explicitly opted in to final save
 * execution.
 *
 * ## Required preconditions (all must be met)
 *
 * 1. `confirmedSaveEnabled` is `true` (explicit operator action).
 * 2. `sessionId` is non-empty.
 * 3. Durable confirmation rows with `status = 'confirmed'` exist.
 * 4. `page` is a valid Playwright Page (browser dependency).
 *
 * ## Behavior
 *
 * - Returns empty array when no confirmed rows exist, WITHOUT creating
 *   browser navigation (caller should check results and only create a
 *   Page when rows exist).
 * - Rejects confirmed rows whose proposal kind is not `ownership` — those
 *   are not passed to the save executor.
 * - Delegates actual save execution to `runConfirmedOwnershipSave`.
 * - Returns raw `SaveResult` objects without remapping statuses.
 *
 * @throws {Error} If `confirmedSaveEnabled` is not `true`.
 * @throws {Error} If `sessionId` is empty or missing.
 */
export async function executeConfirmedOwnershipSaves(
  options: ExecuteConfirmedOwnershipSavesOptions,
): Promise<ExecuteOwnershipSaveResult[]> {
  // -----------------------------------------------------------------------
  // Safety gate 1: explicit final-save mode flag
  // -----------------------------------------------------------------------
  if (!options.confirmedSaveEnabled) {
    throw new Error(
      'confirmedSaveEnabled must be true to execute confirmed ownership saves. ' +
        'Pass --execute-confirmed-ownership-saves to enable.',
    );
  }

  // -----------------------------------------------------------------------
  // Safety gate 2: non-empty session identifier
  // -----------------------------------------------------------------------
  const sessionId = (options.sessionId ?? '').trim();
  if (sessionId.length === 0) {
    throw new Error('sessionId is required and must be non-empty.');
  }

  // -----------------------------------------------------------------------
  // Check for confirmed rows before any browser work
  // -----------------------------------------------------------------------
  const confirmedCount = countConfirmedRows(options.db, sessionId);
  if (confirmedCount === 0) {
    return [];
  }

  // -----------------------------------------------------------------------
  // Reject non-ownership proposal kinds
  // -----------------------------------------------------------------------
  const nonOwnership = findNonOwnershipConfirmedProposalIds(options.db, sessionId);
  if (nonOwnership.length > 0) {
    const details = nonOwnership.map((r) => `${r.proposalId} (kind=${r.proposalKind})`).join(', ');
    throw new Error(
      `Confirmed rows with non-ownership proposal kinds are not supported: ${details}`,
    );
  }

  // -----------------------------------------------------------------------
  // Delegate to the audited Slice 4 save executor
  // -----------------------------------------------------------------------
  const saveExecutor = options.saveExecutor ?? runConfirmedOwnershipSave;

  const executorOptions: OwnershipSaveExecutorOptions = {
    db: options.db,
    sessionId,
    page: options.page,
    timeout: options.timeout,
    resolvePageUrl: options.resolvePageUrl,
  };

  const results = await saveExecutor(executorOptions);

  return results;
}
