/**
 * Import items — the state machine and persistence layer for tracking
 * individual approved proposals through the import pipeline.
 *
 * Each approved proposal becomes one import item.  Every account mutation
 * (ownership, status, playlog) gets its own checkpoint and confirmation.
 *
 * Phase 5A covers schema, seeding, transitions, selection, reconciliation,
 * and counter recalculation.  Browser save and Backloggd comparison are
 * explicitly out of scope — they are added in Phases 5B and 5C.
 */

import type Database from 'better-sqlite3';
import type { ImportManifest } from '../review/manifest.js';
import { verifyManifestProposal, MANIFEST_VERSION } from '../review/manifest.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Status values for an import item.
 *
 * - `approved`: ready to be picked up for processing.
 * - `importing`: currently being processed (browser work in progress).
 * - `saved`: successfully applied — terminal state.
 * - `skipped`: user declined or already present — terminal state.
 * - `failed`: error occurred — only retryable via explicit command.
 */
export type ImportItemStatus = 'approved' | 'importing' | 'saved' | 'skipped' | 'failed';

/**
 * A single import item — one approved proposal tracked through the pipeline.
 */
export interface ImportItem {
  proposalId: string;
  importSessionId: string;
  steamAppId: number;
  proposalKind: string;
  frozenPayload: string | null;
  status: ImportItemStatus;
  attemptCount: number;
  outcomeReason: string | null;
  lastError: string | null;
  lastAttemptAt: string | null;
  verifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Transition table
// ---------------------------------------------------------------------------

/**
 * Legal state transitions.
 * Key = from state, value = set of allowed to states.
 */
const LEGAL_TRANSITIONS: Record<ImportItemStatus, ReadonlySet<ImportItemStatus>> = {
  approved: new Set(['importing']),
  importing: new Set(['saved', 'skipped', 'failed']),
  saved: new Set(),
  skipped: new Set(),
  failed: new Set(['importing']), // only via explicit --retry-failed
};

/**
 * Terminal states that must never be changed by any normal workflow.
 */
const TERMINAL_STATES: ReadonlySet<ImportItemStatus> = new Set(['saved', 'skipped']);

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

/**
 * Thrown when an illegal state transition is attempted.
 */
export class IllegalTransitionError extends Error {
  constructor(
    public readonly proposalId: string,
    public readonly from: ImportItemStatus,
    public readonly to: ImportItemStatus,
  ) {
    super(
      `Illegal transition for item "${proposalId}": ${from} → ${to}. ` +
        `Allowed from "${from}": [${Array.from(LEGAL_TRANSITIONS[from] ?? []).join(', ')}]`,
    );
    this.name = 'IllegalTransitionError';
  }
}

/**
 * Thrown when a manifest proposal fails drift detection.
 */
export class ManifestDriftError extends Error {
  constructor(
    public readonly proposalId: string,
    public readonly reason: string,
  ) {
    super(`Manifest drift detected for proposal "${proposalId}": ${reason}`);
    this.name = 'ManifestDriftError';
  }
}

// ---------------------------------------------------------------------------
// Item query helpers
// ---------------------------------------------------------------------------

const ITEM_COLUMNS = `
  proposal_id, import_session_id, steam_app_id, proposal_kind,
  frozen_payload, status, attempt_count, outcome_reason, last_error,
  last_attempt_at, verified_at, created_at, updated_at
`;

function rowToItem(row: Record<string, unknown>): ImportItem {
  return {
    proposalId: row.proposal_id as string,
    importSessionId: row.import_session_id as string,
    steamAppId: row.steam_app_id as number,
    proposalKind: row.proposal_kind as string,
    frozenPayload: row.frozen_payload as string | null,
    status: row.status as ImportItemStatus,
    attemptCount: row.attempt_count as number,
    outcomeReason: row.outcome_reason as string | null,
    lastError: row.last_error as string | null,
    lastAttemptAt: row.last_attempt_at as string | null,
    verifiedAt: row.verified_at as string | null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

/**
 * Get a single import item by proposal ID.
 */
export function getItem(db: Database.Database, proposalId: string): ImportItem | null {
  const row = db
    .prepare(
      `SELECT ${ITEM_COLUMNS}
       FROM import_items
       WHERE proposal_id = ?`,
    )
    .get(proposalId) as Record<string, unknown> | undefined;

  return row ? rowToItem(row) : null;
}

/**
 * Get all import items for a session, optionally filtered by status.
 */
export function getItemsBySession(
  db: Database.Database,
  sessionId: string,
  status?: ImportItemStatus | ImportItemStatus[],
): ImportItem[] {
  if (status === undefined) {
    const rows = db
      .prepare(
        `SELECT ${ITEM_COLUMNS}
         FROM import_items
         WHERE import_session_id = ?
         ORDER BY steam_app_id, proposal_kind`,
      )
      .all(sessionId) as Record<string, unknown>[];

    return rows.map(rowToItem);
  }

  const statuses = Array.isArray(status) ? status : [status];
  const placeholders = statuses.map(() => '?').join(', ');

  const rows = db
    .prepare(
      `SELECT ${ITEM_COLUMNS}
       FROM import_items
       WHERE import_session_id = ?
         AND status IN (${placeholders})
       ORDER BY steam_app_id, proposal_kind`,
    )
    .all(sessionId, ...statuses) as Record<string, unknown>[];

  return rows.map(rowToItem);
}

// ---------------------------------------------------------------------------
// Seeding: manifest → import_items
// ---------------------------------------------------------------------------

/**
 * Result of a seeding operation.
 */
export interface SeedResult {
  /** Total number of approved proposals in the manifest. */
  totalManifestProposals: number;
  /** Number of import_items rows created. */
  created: number;
  /** Number of proposals skipped due to drift detection. */
  drifted: number;
  /** Number of proposals already present (idempotent load). */
  alreadyPresent: number;
  /** Number of proposals in terminal states that were preserved. */
  preserved: number;
}

/**
 * Seed the import_items table from an approved manifest.
 *
 * The function uses a two-phase approach:
 *
 * Phase 1 — Preflight: verify every manifest proposal against the database.
 *   If ANY proposal is missing, unapproved, or drifted, the entire manifest
 *   is rejected before any `import_items` row is inserted/updated.
 *
 * Phase 2 — Mutation: only runs when every proposal passed preflight.
 *   Canonical database values (import_session_id, steam_app_id, proposal_kind)
 *   are fetched from the proposals table and used instead of trusting the
 *   manifest's metadata.  Manifest/database mismatches in these fields are
 *   treated as drift.
 *
 * Idempotent: re-running with the same manifest produces the same result
 * and does not reset terminal states.
 *
 * @throws ManifestDriftError  When any proposal fails preflight or any
 *   manifest metadata mismatches the canonical database values.
 */
export function seedApprovedManifest(db: Database.Database, manifest: ImportManifest): SeedResult {
  // -----------------------------------------------------------------------
  // Phase 1 — Preflight: validate every proposal before any mutation
  // -----------------------------------------------------------------------
  interface CanonicalRow {
    import_session_id: string;
    steam_app_id: number;
    proposal_kind: string;
    suggested_payload: string | null;
    status: string;
  }

  const canonicalMap = new Map<string, CanonicalRow>();

  for (const item of manifest.items) {
    for (const proposal of item.approvedProposals) {
      // 1a. Verify manifest proposal against DB (existence, status, payload)
      const drift = verifyManifestProposal(proposal.proposalId, proposal.payload, db);
      if (!drift.matches) {
        throw new ManifestDriftError(proposal.proposalId, drift.reason ?? 'unknown drift');
      }

      // 1b. Fetch canonical DB values and validate metadata
      const canonical = db
        .prepare(
          `SELECT import_session_id, steam_app_id, proposal_kind,
                  suggested_payload, status
           FROM proposals
           WHERE id = ?`,
        )
        .get(proposal.proposalId) as CanonicalRow | undefined;

      if (!canonical) {
        throw new ManifestDriftError(proposal.proposalId, 'proposal disappeared during preflight');
      }

      // 1c. Verify manifest metadata matches canonical DB values
      if (canonical.import_session_id !== manifest.sessionId) {
        throw new ManifestDriftError(
          proposal.proposalId,
          `manifest sessionId "${manifest.sessionId}" does not match ` +
            `proposal import_session_id "${canonical.import_session_id}"`,
        );
      }

      if (canonical.steam_app_id !== item.steamAppId) {
        throw new ManifestDriftError(
          proposal.proposalId,
          `manifest steam_app_id ${item.steamAppId} does not match ` +
            `proposal steam_app_id ${canonical.steam_app_id}`,
        );
      }

      if (canonical.proposal_kind !== proposal.kind) {
        throw new ManifestDriftError(
          proposal.proposalId,
          `manifest proposal_kind "${proposal.kind}" does not match ` +
            `proposal proposal_kind "${canonical.proposal_kind}"`,
        );
      }

      canonicalMap.set(proposal.proposalId, canonical);
    }
  }

  // -----------------------------------------------------------------------
  // Phase 2 — Mutation: all proposals validated, now seed import_items
  // -----------------------------------------------------------------------
  const result: SeedResult = {
    totalManifestProposals: 0,
    created: 0,
    drifted: 0,
    alreadyPresent: 0,
    preserved: 0,
  };

  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO import_items
      (proposal_id, import_session_id, steam_app_id, proposal_kind,
       frozen_payload, status, attempt_count, outcome_reason, last_error,
       last_attempt_at, verified_at, created_at, updated_at)
    VALUES
      (?, ?, ?, ?,
       ?, 'approved', 0, NULL, NULL,
       NULL, NULL,
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  `);

  const updatePreservedStmt = db.prepare(`
    UPDATE import_items
    SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE proposal_id = ?
  `);

  const transaction = db.transaction(() => {
    for (const item of manifest.items) {
      for (const proposal of item.approvedProposals) {
        result.totalManifestProposals++;
        const canonical = canonicalMap.get(proposal.proposalId);
        /* v8 ignore next 3 — defensive: preflight guarantees existence */
        if (!canonical) {
          throw new ManifestDriftError(
            proposal.proposalId,
            'canonical row missing during mutation',
          );
        }

        // Check if the item already exists
        const existing = db
          .prepare('SELECT status FROM import_items WHERE proposal_id = ?')
          .get(proposal.proposalId) as { status: string } | undefined;

        if (existing) {
          if (TERMINAL_STATES.has(existing.status as ImportItemStatus)) {
            result.preserved++;
            updatePreservedStmt.run(proposal.proposalId);
          } else {
            result.alreadyPresent++;
          }
          continue;
        }

        // Insert new row using canonical DB values
        insertStmt.run(
          proposal.proposalId,
          canonical.import_session_id,
          canonical.steam_app_id,
          canonical.proposal_kind,
          canonical.suggested_payload,
        );
        result.created++;
      }
    }
  });

  transaction();

  return result;
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/**
 * Options for selecting the next import item.
 */
export interface SelectOptions {
  /** When true, include failed items (for --retry-failed). */
  retryFailed?: boolean;
  /** Specific steam_app_ids to scope selection to. */
  steamAppIds?: number[];
}

/**
 * Select the next import item eligible for processing.
 *
 * Default behaviour returns any `approved` item.
 * With `retryFailed: true`, also returns `failed` items.
 *
 * Never returns `importing`, `saved`, or `skipped` items.
 *
 * @returns The selected item, or null if nothing is eligible.
 */
export function selectNextItem(
  db: Database.Database,
  sessionId: string,
  options: SelectOptions = {},
): ImportItem | null {
  const statuses: string[] = ['approved'];
  if (options.retryFailed) {
    statuses.push('failed');
  }

  let query: string;
  const params: unknown[] = [];

  if (options.steamAppIds && options.steamAppIds.length > 0) {
    const appPlaceholders = options.steamAppIds.map(() => '?').join(', ');
    const statusPlaceholders = statuses.map(() => '?').join(', ');
    query = `
      SELECT ${ITEM_COLUMNS}
      FROM import_items
      WHERE import_session_id = ?
        AND status IN (${statusPlaceholders})
        AND steam_app_id IN (${appPlaceholders})
      ORDER BY
        CASE status WHEN 'approved' THEN 0 WHEN 'failed' THEN 1 END,
        attempt_count ASC,
        steam_app_id ASC
      LIMIT 1
    `;
    params.push(sessionId, ...statuses, ...options.steamAppIds);
  } else {
    const statusPlaceholders = statuses.map(() => '?').join(', ');
    query = `
      SELECT ${ITEM_COLUMNS}
      FROM import_items
      WHERE import_session_id = ?
        AND status IN (${statusPlaceholders})
      ORDER BY
        CASE status WHEN 'approved' THEN 0 WHEN 'failed' THEN 1 END,
        attempt_count ASC,
        steam_app_id ASC
      LIMIT 1
    `;
    params.push(sessionId, ...statuses);
  }

  const row = db.prepare(query).get(...params) as Record<string, unknown> | undefined;
  return row ? rowToItem(row) : null;
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

/**
 * Reconcile importing items after a restart.
 *
 * In Phase 5A there is no visible Backloggd reconciliation layer, so
 * `importing` items are left in their current state.  They are marked
 * as needing reconciliation via a note in `outcome_reason`.
 *
 * A future Backloggd comparison layer (Phase 5B) can resolve them.
 *
 * @returns Count of importing items left unresolved.
 */
export function reconcileImportingItems(db: Database.Database, sessionId: string): number {
  const result = db
    .prepare(
      `UPDATE import_items
       SET outcome_reason = CASE
         WHEN outcome_reason IS NULL OR outcome_reason = ''
         THEN 'needs-reconciliation: importing after restart'
         ELSE outcome_reason || '; needs-reconciliation: importing after restart'
       END,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE import_session_id = ?
         AND status = 'importing'
         AND (outcome_reason IS NULL OR outcome_reason NOT LIKE '%needs-reconciliation%')`,
    )
    .run(sessionId);

  return result.changes;
}

// ---------------------------------------------------------------------------
// State transitions
// ---------------------------------------------------------------------------

/**
 * Transition an import item to a new status.
 *
 * Validates the transition against the legal transition table.
 * Returns the updated item, or throws IllegalTransitionError.
 *
 * @param db            Database instance.
 * @param proposalId    The item to transition.
 * @param toStatus      Target status.
 * @param options       Optional metadata (reason, error).
 */
export function transitionItem(
  db: Database.Database,
  proposalId: string,
  toStatus: ImportItemStatus,
  options: {
    outcomeReason?: string | null;
    lastError?: string | null;
  } = {},
): ImportItem {
  const item = getItem(db, proposalId);
  if (!item) {
    throw new Error(`Import item "${proposalId}" not found.`);
  }

  const fromStatus = item.status;
  const allowed = LEGAL_TRANSITIONS[fromStatus];

  if (!allowed || !allowed.has(toStatus)) {
    throw new IllegalTransitionError(proposalId, fromStatus, toStatus);
  }

  const now = new Date().toISOString();
  const updates: string[] = ['status = ?', 'updated_at = ?'];
  const params: unknown[] = [toStatus, now];

  if (toStatus === 'importing') {
    updates.push('attempt_count = attempt_count + 1');
    updates.push('last_attempt_at = ?');
    params.push(now);
  }

  if (toStatus === 'saved') {
    updates.push('verified_at = ?');
    params.push(now);
  }

  if (options.outcomeReason !== undefined) {
    updates.push('outcome_reason = ?');
    params.push(options.outcomeReason);
  }

  if (options.lastError !== undefined) {
    updates.push('last_error = ?');
    params.push(options.lastError);
  }

  params.push(proposalId);

  db.prepare(
    `UPDATE import_items
     SET ${updates.join(', ')}
     WHERE proposal_id = ?`,
  ).run(...params);

  return getItem(db, proposalId) as ImportItem;
}

// ---------------------------------------------------------------------------
// Reconciliation — importing → approved
// ---------------------------------------------------------------------------

/**
 * Proof that a Backloggd comparison was performed and no account change
 * happened, allowing an `importing` item to return to `approved` without
 * requiring a browser save.
 */
export interface ReconciliationProof {
  /** The reconciler's determination. */
  result: 'absent';
  /** ISO timestamp when the comparison was performed. */
  checkedAt: string;
  /** Human-readable explanation. */
  reason: string;
}

/**
 * Reconcile an `importing` item back to `approved` after explicit
 * verification that no Backloggd account change occurred.
 *
 * This is the **only** way to transition `importing → approved`.
 * Calling the generic `transitionItem(…, 'approved')` on an `importing`
 * item will throw `IllegalTransitionError`.
 *
 * @param db          Database instance.
 * @param proposalId  The item to reconcile.
 * @param proof       Proof of the reconciliation check.
 * @returns           The updated item.
 * @throws            If the item is not found, not in `importing` status,
 *                    or the proof is incomplete.
 */
/**
 * Regex to quickly reject obviously invalid ISO timestamps.
 * Accepts formats like "2026-07-05T12:34:56Z" or "2026-07-05T12:34:56.789Z"
 * or with a timezone offset.
 */
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

/**
 * Validate a reconciliation proof, throwing if any field is invalid.
 */
function validateReconciliationProof(proof: ReconciliationProof): void {
  if (proof.result !== 'absent') {
    throw new Error(
      `Reconciliation proof result must be 'absent', got '${proof.result}'. ` +
        `Only 'absent' (no account change detected) allows re-queuing.`,
    );
  }

  if (!proof.checkedAt || proof.checkedAt.trim().length === 0) {
    throw new Error('Reconciliation proof checkedAt must be a nonempty timestamp.');
  }

  if (!ISO_TIMESTAMP_RE.test(proof.checkedAt.trim())) {
    throw new Error(
      `Reconciliation proof checkedAt is not a valid ISO timestamp: "${proof.checkedAt}".`,
    );
  }

  const parsed = new Date(proof.checkedAt);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Reconciliation proof checkedAt is not a valid date: "${proof.checkedAt}".`);
  }

  if (!proof.reason || proof.reason.trim().length === 0) {
    throw new Error('Reconciliation proof reason must be nonempty.');
  }
}

/**
 * Reconcile an `importing` item back to `approved` after explicit
 * verification that no Backloggd account change occurred.
 *
 * This is the **only** way to transition `importing → approved`.
 * Calling the generic `transitionItem(…, 'approved')` on an `importing`
 * item will throw `IllegalTransitionError`.
 *
 * Proof requirements:
 *   - `result` must be `'absent'`.
 *   - `checkedAt` must be a nonempty valid ISO timestamp.
 *   - `reason.trim()` must be nonempty.
 *
 * @param db          Database instance.
 * @param proposalId  The item to reconcile.
 * @param proof       Proof of the reconciliation check.
 * @returns           The updated item.
 * @throws            If the item is not found, not in `importing` status,
 *                    or the proof is invalid.
 */
export function reconcileItem(
  db: Database.Database,
  proposalId: string,
  proof: ReconciliationProof,
): ImportItem {
  const item = getItem(db, proposalId);
  if (!item) {
    throw new Error(`Import item "${proposalId}" not found.`);
  }

  if (item.status !== 'importing') {
    throw new IllegalTransitionError(proposalId, item.status, 'approved');
  }

  validateReconciliationProof(proof);

  const now = new Date().toISOString();
  const outcomeReason = `reconciled:${proof.result}:${proof.reason}:checkedAt=${proof.checkedAt}`;

  db.prepare(
    `UPDATE import_items
     SET status = 'approved',
         outcome_reason = ?,
         updated_at = ?
     WHERE proposal_id = ? AND status = 'importing'`,
  ).run(outcomeReason, now, proposalId);

  return getItem(db, proposalId) as ImportItem;
}

// ---------------------------------------------------------------------------
// Counter recalculation
// ---------------------------------------------------------------------------

/**
 * Recalculate session counters from the import_items table.
 *
 * This replaces blind increments and ensures counters are always accurate
 * after any series of transitions, restarts, or retries.
 *
 * Updates the following fields on the import_sessions row:
 *   - approved_changes (count of approved + importing items)
 *   - applied_changes  (count of saved items)
 *   - skipped_games    (count of skipped items)
 *   - failed_games     (count of failed items)
 *
 * approved_changes is set to the count of items that are either `approved`
 * (queued but not yet processed) or `importing` (in-flight).
 */
export function recalculateSessionCounters(db: Database.Database, sessionId: string): void {
  const counts = db
    .prepare(
      `SELECT
         SUM(CASE WHEN status IN ('approved', 'importing') THEN 1 ELSE 0 END) AS active_count,
         SUM(CASE WHEN status = 'saved'    THEN 1 ELSE 0 END) AS saved_count,
         SUM(CASE WHEN status = 'skipped'  THEN 1 ELSE 0 END) AS skipped_count,
         SUM(CASE WHEN status = 'failed'   THEN 1 ELSE 0 END) AS failed_count
       FROM import_items
       WHERE import_session_id = ?`,
    )
    .get(sessionId) as {
    active_count: number | null;
    saved_count: number | null;
    skipped_count: number | null;
    failed_count: number | null;
  };

  db.prepare(
    `UPDATE import_sessions
     SET approved_changes = ?,
         applied_changes  = ?,
         skipped_games    = ?,
         failed_games     = ?
     WHERE id = ?`,
  ).run(
    counts.active_count ?? 0,
    counts.saved_count ?? 0,
    counts.skipped_count ?? 0,
    counts.failed_count ?? 0,
    sessionId,
  );
}

// ---------------------------------------------------------------------------
// Retry helpers
// ---------------------------------------------------------------------------

/**
 * Count items by status for a session.
 */
export interface ItemCounts {
  approved: number;
  importing: number;
  saved: number;
  skipped: number;
  failed: number;
  total: number;
}

/**
 * Get counts of import items by status for a session.
 */
export function getItemCounts(db: Database.Database, sessionId: string): ItemCounts {
  const rows = db
    .prepare(
      `SELECT status, COUNT(*) AS cnt
       FROM import_items
       WHERE import_session_id = ?
       GROUP BY status`,
    )
    .all(sessionId) as { status: string; cnt: number }[];

  const counts: ItemCounts = {
    approved: 0,
    importing: 0,
    saved: 0,
    skipped: 0,
    failed: 0,
    total: 0,
  };

  for (const row of rows) {
    const key = row.status as keyof ItemCounts;
    if (key in counts) {
      counts[key] = row.cnt;
    }
    counts.total += row.cnt;
  }

  return counts;
}

/**
 * Transition all failed items back to approved for retry.
 *
 * @returns The number of items reset.
 */
export function resetFailedForRetry(db: Database.Database, sessionId: string): number {
  const result = db
    .prepare(
      `UPDATE import_items
       SET status = 'approved',
           outcome_reason = NULL,
           last_error = NULL,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE import_session_id = ?
         AND status = 'failed'`,
    )
    .run(sessionId);

  return result.changes;
}

/**
 * Count ownership compare failures that match a narrow outcome reason prefix.
 *
 * This intentionally only inspects local import_items state. It does not touch
 * proposals, confirmations, browser code, or terminal saved/skipped rows.
 */
export function countOwnershipCompareFailuresForRetryByReasonPrefix(
  db: Database.Database,
  sessionId: string,
  reasonPrefix: string,
): number {
  const prefix = reasonPrefix.trim();
  if (!sessionId.trim() || !prefix) return 0;

  const row = db
    .prepare(
      `SELECT COUNT(*) AS cnt
       FROM import_items
       WHERE import_session_id = ?
         AND proposal_kind = 'ownership'
         AND status IN ('failed', 'importing')
         AND outcome_reason IS NOT NULL
         AND substr(outcome_reason, 1, ?) = ?`,
    )
    .get(sessionId.trim(), prefix.length, prefix) as { cnt: number } | undefined;

  return row?.cnt ?? 0;
}

/**
 * Reset ownership compare failures that match a narrow outcome reason prefix.
 *
 * The reset is local-only and idempotent: matched failed/importing ownership
 * rows return to approved and have compare failure diagnostics cleared.
 * Terminal saved/skipped rows and unrelated failed rows are not selected.
 */
export function resetOwnershipCompareFailuresForRetryByReasonPrefix(
  db: Database.Database,
  sessionId: string,
  reasonPrefix: string,
): number {
  const prefix = reasonPrefix.trim();
  if (!sessionId.trim() || !prefix) return 0;

  const result = db
    .prepare(
      `UPDATE import_items
       SET status = 'approved',
           outcome_reason = NULL,
           last_error = NULL,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE import_session_id = ?
         AND proposal_kind = 'ownership'
         AND status IN ('failed', 'importing')
         AND outcome_reason IS NOT NULL
         AND substr(outcome_reason, 1, ?) = ?`,
    )
    .run(sessionId.trim(), prefix.length, prefix);

  if (result.changes > 0) {
    recalculateSessionCounters(db, sessionId.trim());
  }

  return result.changes;
}

/**
 * Transition a specific failed item back to approved for retry.
 *
 * @returns The updated item, or null if not found or not failed.
 */
export function resetFailedItemForRetry(
  db: Database.Database,
  proposalId: string,
): ImportItem | null {
  const item = getItem(db, proposalId);
  if (!item || item.status !== 'failed') return null;

  db.prepare(
    `UPDATE import_items
     SET status = 'approved',
         outcome_reason = NULL,
         last_error = NULL,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE proposal_id = ? AND status = 'failed'`,
  ).run(proposalId);

  return getItem(db, proposalId);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate that a manifest is compatible with the current version.
 */
export function validateManifestVersion(manifest: ImportManifest): boolean {
  return manifest.manifestVersion === MANIFEST_VERSION;
}

/**
 * Validate that all proposals in a manifest exist and are approved in the database.
 *
 * @returns An array of drift results for proposals that fail validation.
 */
export function validateManifestAgainstDb(
  db: Database.Database,
  manifest: ImportManifest,
): { proposalId: string; reason: string }[] {
  const failures: { proposalId: string; reason: string }[] = [];

  for (const item of manifest.items) {
    for (const proposal of item.approvedProposals) {
      const drift = verifyManifestProposal(proposal.proposalId, proposal.payload, db);
      if (!drift.matches) {
        failures.push({
          proposalId: proposal.proposalId,
          reason: drift.reason ?? 'unknown',
        });
      }
    }
  }

  return failures;
}
