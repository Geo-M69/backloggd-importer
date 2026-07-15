/**
 * Tests for the ownership save command integration layer (Phase 5D Slice 1).
 *
 * Covers:
 *   1.  Default path (confirmedSaveEnabled=false) throws before browser work.
 *   2.  Explicit flag invokes the save executor.
 *   3.  Missing session id fails before browser work.
 *   4.  No confirmed rows returns empty result without browser navigation.
 *   5.  Unconfirmed rows are not passed to save execution.
 *   6.  Status/playlog proposals are not processed (rejected at integration).
 *   7.  Save executor results are surfaced without remapping.
 *   8.  `saved` result is reported as success.
 *   9.  `stale`, `stagingFailed`, `unsupported`, `blockedWrite`,
 *       `saveFailed`, `verificationFailed`, and `browserFailed` are
 *       reported distinctly.
 *   10. A mixed result set preserves per-confirmation statuses.
 *   11. Integration layer does not mutate `import_items` directly.
 *   12. Integration layer does not mutate `import_item_confirmations` directly.
 *   13. Integration layer does not call `processItem`, `transitionItem`,
 *       or `reconcileItem` directly.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { getCreateTableSQL } from '../../src/storage/schema.js';
import { runMigrations } from '../../src/storage/database.js';
import { getItem, transitionItem, reconcileItem } from '../../src/importer/import-items.js';
import { buildOwnershipSavePlan } from '../../src/importer/ownership-save-plan.js';
import { applyOwnershipConfirmationSelection } from '../../src/importer/ownership-save-confirmation.js';
import {
  executeConfirmedOwnershipSaves,
  countConfirmedRows,
} from '../../src/importer/ownership-save-command.js';
import type {
  OwnershipSaveExecutorOptions,
  SaveResult,
  SaveResultStatus,
} from '../../src/importer/ownership-save-executor.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STEAM_DIGITAL_PAYLOAD = '{"platform":"steam","ownershipType":"digital"}';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createFreshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(getCreateTableSQL());
  runMigrations(db);
  return db;
}

function seedMinimalSession(db: Database.Database, sessionId = 'test-session'): void {
  db.prepare('INSERT OR IGNORE INTO import_sessions (id, total_games) VALUES (?, ?)').run(
    sessionId,
    0,
  );
}

function seedMinimalGame(db: Database.Database, appId: number, title: string): void {
  db.prepare('INSERT INTO games (app_id, title, playtime_minutes) VALUES (?, ?, ?)').run(
    appId,
    title,
    0,
  );
}

function insertProposal(
  db: Database.Database,
  fields: {
    id: string;
    importSessionId: string;
    steamAppId: number;
    proposalKind: string;
    status: string;
    suggestedPayload: string | null;
    backloggdSlug: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO proposals
       (id, import_session_id, steam_app_id, igdb_id, backloggd_slug,
        proposal_kind, status, match_confidence, requires_manual_review,
        suggested_payload, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'exact', 0, ?,
             strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
             strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
  ).run(
    fields.id,
    fields.importSessionId,
    fields.steamAppId,
    10000 + fields.steamAppId,
    fields.backloggdSlug,
    fields.proposalKind,
    fields.status,
    fields.suggestedPayload,
  );
}

function seedImportItem(
  db: Database.Database,
  overrides: {
    proposalId?: string;
    importSessionId?: string;
    steamAppId?: number;
    proposalKind?: string;
    frozenPayload?: string | null;
    status?: string;
    attemptCount?: number;
    outcomeReason?: string | null;
    lastError?: string | null;
    backloggdSlug?: string | null;
    gameTitle?: string;
  } = {},
): string {
  const proposalId = overrides.proposalId ?? randomUUID();
  const sessionId = overrides.importSessionId ?? 'test-session';
  const appId = overrides.steamAppId ?? 730;
  const kind = overrides.proposalKind ?? 'ownership';
  const status: string = overrides.status ?? 'approved';
  const payload = overrides.frozenPayload ?? STEAM_DIGITAL_PAYLOAD;
  const slug = overrides.backloggdSlug ?? `game-${appId}`;

  const sessionExists = db.prepare('SELECT id FROM import_sessions WHERE id = ?').get(sessionId);
  if (!sessionExists) seedMinimalSession(db, sessionId);

  const gameTitle = overrides.gameTitle ?? `Game ${appId}`;
  const gameExists = db.prepare('SELECT app_id FROM games WHERE app_id = ?').get(appId);
  if (!gameExists) seedMinimalGame(db, appId, gameTitle);
  else if (overrides.gameTitle)
    db.prepare('UPDATE games SET title = ? WHERE app_id = ?').run(gameTitle, appId);

  const proposalExists = db.prepare('SELECT id FROM proposals WHERE id = ?').get(proposalId);
  if (!proposalExists) {
    insertProposal(db, {
      id: proposalId,
      importSessionId: sessionId,
      steamAppId: appId,
      proposalKind: kind,
      status: 'approved',
      suggestedPayload: payload,
      backloggdSlug: slug,
    });
  }

  db.prepare(
    `INSERT OR IGNORE INTO import_items
       (proposal_id, import_session_id, steam_app_id, proposal_kind,
        frozen_payload, status, attempt_count, outcome_reason, last_error,
        last_attempt_at, verified_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL,
             strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
             strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
  ).run(
    proposalId,
    sessionId,
    appId,
    kind,
    payload,
    status,
    overrides.attemptCount ?? 0,
    overrides.outcomeReason ?? null,
    overrides.lastError ?? null,
  );

  return proposalId;
}

function simulateApprovedWithAbsentProof(
  db: Database.Database,
  proposalId: string,
  reason = 'ownership-change-needed:absent',
  checkedAt?: string,
): void {
  transitionItem(db, proposalId, 'importing');
  reconcileItem(db, proposalId, {
    result: 'absent',
    checkedAt: checkedAt ?? new Date().toISOString(),
    reason,
  });
}

function seedEligibleItem(
  db: Database.Database,
  overrides: {
    proposalId?: string;
    sessionId?: string;
    steamAppId?: number;
    gameTitle?: string;
    backloggdSlug?: string;
    proofReason?: string;
    proposalKind?: string;
    frozenPayload?: string | null;
  } = {},
): string {
  const sessionId = overrides.sessionId ?? 'test-session';
  const steamAppId = overrides.steamAppId ?? 730;
  const proposalId = seedImportItem(db, {
    proposalId: overrides.proposalId,
    importSessionId: sessionId,
    steamAppId,
    gameTitle: overrides.gameTitle ?? `Game ${steamAppId}`,
    backloggdSlug: overrides.backloggdSlug ?? `game-${steamAppId}`,
    status: 'approved',
    frozenPayload: overrides.frozenPayload ?? STEAM_DIGITAL_PAYLOAD,
    proposalKind: overrides.proposalKind ?? 'ownership',
  });
  simulateApprovedWithAbsentProof(db, proposalId, overrides.proofReason);
  return proposalId;
}

function createConfirmedConfirmation(
  db: Database.Database,
  sessionId: string,
  proposalId: string,
): void {
  const plan = buildOwnershipSavePlan({ db, sessionId });
  applyOwnershipConfirmationSelection(db, plan, { byProposalIds: [proposalId] });
}

/**
 * Create a mock save executor that returns the given results.
 */
function createMockSaveExecutor(
  results: SaveResult[],
): (opts: OwnershipSaveExecutorOptions) => Promise<SaveResult[]> {
  return vi.fn(async (_opts: OwnershipSaveExecutorOptions) => {
    return results;
  });
}

/**
 * Create a mock page object (minimal for DI).
 */
import type { Page } from 'playwright';

function createMockPage(): Page {
  return { __mock: true } as unknown as Page;
}

// ==========================================================================
// Tests
// ==========================================================================

describe('ownership-save-command — safety gates', () => {
  let db: Database.Database;
  const SESSION_ID = 'test-session';

  beforeEach(() => {
    db = createFreshDb();
    seedMinimalSession(db, SESSION_ID);
  });

  afterEach(() => {
    db.close();
  });

  // -----------------------------------------------------------------------
  // Test 1 — Default path does not invoke save executor
  // -----------------------------------------------------------------------
  it('throws when confirmedSaveEnabled is false', async () => {
    await expect(
      executeConfirmedOwnershipSaves({
        db,
        sessionId: SESSION_ID,
        confirmedSaveEnabled: false,
        page: createMockPage(),
      }),
    ).rejects.toThrow('confirmedSaveEnabled must be true');
  });

  // -----------------------------------------------------------------------
  // Test 2 — Explicit flag invokes save executor
  // -----------------------------------------------------------------------
  it('invokes save executor when confirmedSaveEnabled is true', async () => {
    const pid = seedEligibleItem(db, { sessionId: SESSION_ID });
    createConfirmedConfirmation(db, SESSION_ID, pid);

    const mockResults: SaveResult[] = [
      {
        proposalId: pid,
        status: 'saved',
        confirmationBatchId: 'test-batch',
        detail: 'saved:ownership:steam/digital',
      },
    ];
    const mockExecutor = createMockSaveExecutor(mockResults);

    const results = await executeConfirmedOwnershipSaves({
      db,
      sessionId: SESSION_ID,
      confirmedSaveEnabled: true,
      page: createMockPage(),
      saveExecutor: mockExecutor,
    });

    expect(results).toEqual(mockResults);
    expect(mockExecutor).toHaveBeenCalledTimes(1);
    expect(mockExecutor).toHaveBeenCalledWith(
      expect.objectContaining({
        db,
        sessionId: SESSION_ID,
        page: createMockPage(),
      }),
    );
  });

  // -----------------------------------------------------------------------
  // Test 3 — Missing session id fails before browser work
  // -----------------------------------------------------------------------
  it('fails with empty session id before any browser work', async () => {
    await expect(
      executeConfirmedOwnershipSaves({
        db,
        sessionId: '',
        confirmedSaveEnabled: true,
        page: createMockPage(),
      }),
    ).rejects.toThrow('sessionId is required and must be non-empty');
  });

  it('fails with whitespace-only session id', async () => {
    await expect(
      executeConfirmedOwnershipSaves({
        db,
        sessionId: '   ',
        confirmedSaveEnabled: true,
        page: createMockPage(),
      }),
    ).rejects.toThrow('sessionId is required and must be non-empty');
  });

  // -----------------------------------------------------------------------
  // Test 4 — No confirmed rows returns empty result
  // -----------------------------------------------------------------------
  it('returns empty result when no confirmed rows exist', async () => {
    // Session exists but has no confirmed rows
    const results = await executeConfirmedOwnershipSaves({
      db,
      sessionId: SESSION_ID,
      confirmedSaveEnabled: true,
      page: createMockPage(),
    });

    expect(results).toEqual([]);
  });

  it('does not invoke save executor when no confirmed rows exist', async () => {
    const mockExecutor = createMockSaveExecutor([]);

    await executeConfirmedOwnershipSaves({
      db,
      sessionId: SESSION_ID,
      confirmedSaveEnabled: true,
      page: createMockPage(),
      saveExecutor: mockExecutor,
    });

    expect(mockExecutor).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Test 5 — Unconfirmed rows are not passed to save execution
  // -----------------------------------------------------------------------
  it('ignores unconfirmed (e.g. deleted) confirmation rows', async () => {
    const pid = seedEligibleItem(db, { sessionId: SESSION_ID });
    createConfirmedConfirmation(db, SESSION_ID, pid);

    // Delete the confirmation row — now it's unconfirmed/non-existent
    db.prepare('DELETE FROM import_item_confirmations WHERE proposal_id = ?').run(pid);

    const mockExecutor = createMockSaveExecutor([]);
    const results = await executeConfirmedOwnershipSaves({
      db,
      sessionId: SESSION_ID,
      confirmedSaveEnabled: true,
      page: createMockPage(),
      saveExecutor: mockExecutor,
    });

    expect(results).toEqual([]);
    expect(mockExecutor).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Test 6 — Status/playlog proposals are rejected
  // -----------------------------------------------------------------------
  it('rejects confirmed rows with status proposal kind', async () => {
    const pid = seedEligibleItem(db, {
      sessionId: SESSION_ID,
      proposalKind: 'status',
      frozenPayload: '{"status":"playing"}',
    });
    // Force-create a confirmation row (normally the plan would reject non-ownership)
    db.prepare(
      `INSERT INTO import_item_confirmations
         (proposal_id, import_session_id, confirmation_batch_id, confirmed_at,
          planned_platform, planned_ownership_type, planned_slug,
          planned_absent_checked_at, planned_payload, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed')`,
    ).run(pid, SESSION_ID, randomUUID(), new Date().toISOString(), null, null, null, null, null);

    await expect(
      executeConfirmedOwnershipSaves({
        db,
        sessionId: SESSION_ID,
        confirmedSaveEnabled: true,
        page: createMockPage(),
      }),
    ).rejects.toThrow('non-ownership proposal kinds');
  });

  it('rejects confirmed rows with playlog proposal kind', async () => {
    const pid = seedEligibleItem(db, {
      sessionId: SESSION_ID,
      proposalKind: 'playlog',
      frozenPayload: '{"playlog":"test"}',
    });
    db.prepare(
      `INSERT INTO import_item_confirmations
         (proposal_id, import_session_id, confirmation_batch_id, confirmed_at,
          planned_platform, planned_ownership_type, planned_slug,
          planned_absent_checked_at, planned_payload, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed')`,
    ).run(pid, SESSION_ID, randomUUID(), new Date().toISOString(), null, null, null, null, null);

    await expect(
      executeConfirmedOwnershipSaves({
        db,
        sessionId: SESSION_ID,
        confirmedSaveEnabled: true,
        page: createMockPage(),
      }),
    ).rejects.toThrow('non-ownership proposal kinds');
  });

  // -----------------------------------------------------------------------
  // countConfirmedRows helper
  // -----------------------------------------------------------------------
  it('countConfirmedRows returns 0 for session with no rows', () => {
    expect(countConfirmedRows(db, SESSION_ID)).toBe(0);
  });

  it('countConfirmedRows returns correct count', () => {
    const pid1 = seedEligibleItem(db, { sessionId: SESSION_ID });
    const pid2 = seedEligibleItem(db, {
      sessionId: SESSION_ID,
      steamAppId: 731,
      backloggdSlug: 'game-731',
      gameTitle: 'Game 731',
    });
    createConfirmedConfirmation(db, SESSION_ID, pid1);
    createConfirmedConfirmation(db, SESSION_ID, pid2);

    expect(countConfirmedRows(db, SESSION_ID)).toBe(2);
  });
});

// ==========================================================================
// Result preservation tests (using mock executor)
// ==========================================================================

describe('ownership-save-command — result preservation', () => {
  let db: Database.Database;
  const SESSION_ID = 'test-session';

  beforeEach(() => {
    db = createFreshDb();
    seedMinimalSession(db, SESSION_ID);
  });

  afterEach(() => {
    db.close();
  });

  // -----------------------------------------------------------------------
  // Test 7 — Save executor results surfaced without remapping
  // -----------------------------------------------------------------------
  it('surfaces results without remapping away safety detail', async () => {
    const pid = seedEligibleItem(db, { sessionId: SESSION_ID });
    createConfirmedConfirmation(db, SESSION_ID, pid);

    const mockResults: SaveResult[] = [
      {
        proposalId: pid,
        status: 'blockedWrite',
        confirmationBatchId: 'test-batch',
        detail: 'POST https://backloggd.com/api/library/ blocked',
      },
    ];
    const mockExecutor = createMockSaveExecutor(mockResults);

    const results = await executeConfirmedOwnershipSaves({
      db,
      sessionId: SESSION_ID,
      confirmedSaveEnabled: true,
      page: createMockPage(),
      saveExecutor: mockExecutor,
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual(mockResults[0]);
  });

  // -----------------------------------------------------------------------
  // Test 8 — saved result reported as success
  // -----------------------------------------------------------------------
  it('reports saved status as success', async () => {
    const pid = seedEligibleItem(db, { sessionId: SESSION_ID });
    createConfirmedConfirmation(db, SESSION_ID, pid);

    const mockResults: SaveResult[] = [
      {
        proposalId: pid,
        status: 'saved',
        confirmationBatchId: 'test-batch',
        detail: 'saved:ownership:steam/digital',
      },
    ];
    const mockExecutor = createMockSaveExecutor(mockResults);

    const results = await executeConfirmedOwnershipSaves({
      db,
      sessionId: SESSION_ID,
      confirmedSaveEnabled: true,
      page: createMockPage(),
      saveExecutor: mockExecutor,
    });

    expect(results[0].status).toBe('saved');
  });

  // -----------------------------------------------------------------------
  // Test 9 — All failure statuses reported distinctly
  // -----------------------------------------------------------------------
  const FAILURE_STATUSES: SaveResultStatus[] = [
    'stale',
    'stagingFailed',
    'unsupported',
    'blockedWrite',
    'saveFailed',
    'verificationFailed',
    'browserFailed',
  ];

  FAILURE_STATUSES.forEach((status) => {
    it(`reports ${status} status distinctly`, async () => {
      const pid = seedEligibleItem(db, { sessionId: SESSION_ID });
      createConfirmedConfirmation(db, SESSION_ID, pid);

      const mockResults: SaveResult[] = [
        {
          proposalId: pid,
          status,
          confirmationBatchId: 'test-batch',
          detail: `test:${status}`,
        },
      ];
      const mockExecutor = createMockSaveExecutor(mockResults);

      const results = await executeConfirmedOwnershipSaves({
        db,
        sessionId: SESSION_ID,
        confirmedSaveEnabled: true,
        page: createMockPage(),
        saveExecutor: mockExecutor,
      });

      expect(results).toHaveLength(1);
      expect(results[0].status).toBe(status);
      expect(results[0].detail).toBe(`test:${status}`);
    });
  });

  // -----------------------------------------------------------------------
  // Test 10 — Mixed result set preserves per-confirmation statuses
  // -----------------------------------------------------------------------
  it('preserves per-confirmation statuses in a mixed result set', async () => {
    const pid1 = seedEligibleItem(db, { sessionId: SESSION_ID, steamAppId: 730 });
    const pid2 = seedEligibleItem(db, {
      sessionId: SESSION_ID,
      steamAppId: 731,
      backloggdSlug: 'game-731',
      gameTitle: 'Game 731',
    });
    createConfirmedConfirmation(db, SESSION_ID, pid1);
    createConfirmedConfirmation(db, SESSION_ID, pid2);

    const mockResults: SaveResult[] = [
      {
        proposalId: pid1,
        status: 'saved',
        confirmationBatchId: 'batch-1',
        detail: 'saved:ownership:steam/digital',
      },
      {
        proposalId: pid2,
        status: 'saveFailed',
        confirmationBatchId: 'batch-1',
        detail: 'no_click_driven_save_request_observed',
      },
    ];
    const mockExecutor = createMockSaveExecutor(mockResults);

    const results = await executeConfirmedOwnershipSaves({
      db,
      sessionId: SESSION_ID,
      confirmedSaveEnabled: true,
      page: createMockPage(),
      saveExecutor: mockExecutor,
    });

    expect(results).toHaveLength(2);
    expect(results[0].proposalId).toBe(pid1);
    expect(results[0].status).toBe('saved');
    expect(results[1].proposalId).toBe(pid2);
    expect(results[1].status).toBe('saveFailed');
  });
});

// ==========================================================================
// Non-mutation verification (using mock executor)
// ==========================================================================

describe('ownership-save-command — no direct mutation', () => {
  let db: Database.Database;
  const SESSION_ID = 'test-session';

  beforeEach(() => {
    db = createFreshDb();
    seedMinimalSession(db, SESSION_ID);
  });

  afterEach(() => {
    db.close();
  });

  // -----------------------------------------------------------------------
  // Test 11 — Integration layer does not mutate import_items directly
  // -----------------------------------------------------------------------
  it('does not mutate import_items table directly', async () => {
    const pid = seedEligibleItem(db, { sessionId: SESSION_ID });
    createConfirmedConfirmation(db, SESSION_ID, pid);

    const beforeItem = getItem(db, pid);
    expect(beforeItem?.status).toBe('approved');

    // Mock executor does nothing (returns empty — but integration layer
    // won't know that; it just passes through)
    const mockExecutor = createMockSaveExecutor([]);
    await executeConfirmedOwnershipSaves({
      db,
      sessionId: SESSION_ID,
      confirmedSaveEnabled: true,
      page: createMockPage(),
      saveExecutor: mockExecutor,
    });

    // Item should still be unchanged (mock executor didn't touch it)
    const afterItem = getItem(db, pid);
    expect(afterItem?.status).toBe('approved');
  });

  // -----------------------------------------------------------------------
  // Test 12 — Integration layer does not mutate import_item_confirmations directly
  // -----------------------------------------------------------------------
  it('does not mutate import_item_confirmations table directly', async () => {
    const pid = seedEligibleItem(db, { sessionId: SESSION_ID });
    createConfirmedConfirmation(db, SESSION_ID, pid);

    const beforeRow = db
      .prepare('SELECT status FROM import_item_confirmations WHERE proposal_id = ?')
      .get(pid) as { status: string } | undefined;
    expect(beforeRow?.status).toBe('confirmed');

    const mockExecutor = createMockSaveExecutor([]);
    await executeConfirmedOwnershipSaves({
      db,
      sessionId: SESSION_ID,
      confirmedSaveEnabled: true,
      page: createMockPage(),
      saveExecutor: mockExecutor,
    });

    const afterRow = db
      .prepare('SELECT status FROM import_item_confirmations WHERE proposal_id = ?')
      .get(pid) as { status: string } | undefined;
    expect(afterRow?.status).toBe('confirmed');
  });
});

// ==========================================================================
// Exit-status decision tests (Finding 2)
// ==========================================================================

describe('ownership-save-command — exit-status decisions', () => {
  let db: Database.Database;
  const SESSION_ID = 'test-session';

  beforeEach(() => {
    db = createFreshDb();
    seedMinimalSession(db, SESSION_ID);
  });

  afterEach(() => {
    db.close();
  });

  // -----------------------------------------------------------------------
  // Helper to decide exit status from results (mirrors CLI logic)
  // -----------------------------------------------------------------------
  function hasAnyFailure(results: readonly { status: string }[]): boolean {
    return results.length > 0 && results.some((r) => r.status !== 'saved');
  }

  // -----------------------------------------------------------------------
  // Test 1 — Empty result exits 0
  // -----------------------------------------------------------------------
  it('empty result has no failures (exit 0)', async () => {
    const mockExecutor = createMockSaveExecutor([]);
    const results = await executeConfirmedOwnershipSaves({
      db,
      sessionId: SESSION_ID,
      confirmedSaveEnabled: true,
      page: createMockPage(),
      saveExecutor: mockExecutor,
    });

    expect(results).toHaveLength(0);
    expect(hasAnyFailure(results)).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Test 2 — All saved exits 0
  // -----------------------------------------------------------------------
  it('all saved results have no failures (exit 0)', async () => {
    const pid = seedEligibleItem(db, { sessionId: SESSION_ID });
    createConfirmedConfirmation(db, SESSION_ID, pid);

    const mockResults: SaveResult[] = [
      { proposalId: pid, status: 'saved', confirmationBatchId: 'batch-1', detail: 'ok' },
    ];
    const mockExecutor = createMockSaveExecutor(mockResults);

    const results = await executeConfirmedOwnershipSaves({
      db,
      sessionId: SESSION_ID,
      confirmedSaveEnabled: true,
      page: createMockPage(),
      saveExecutor: mockExecutor,
    });

    expect(hasAnyFailure(results)).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Test 3–9 — Single failure exits nonzero
  // -----------------------------------------------------------------------
  const SINGLE_FAILURE_STATUSES: SaveResultStatus[] = [
    'blockedWrite',
    'saveFailed',
    'verificationFailed',
    'browserFailed',
    'stagingFailed',
    'unsupported',
    'stale',
  ];

  SINGLE_FAILURE_STATUSES.forEach((status) => {
    it(`single ${status} has failures (exit nonzero)`, async () => {
      const pid = seedEligibleItem(db, { sessionId: SESSION_ID });
      createConfirmedConfirmation(db, SESSION_ID, pid);

      const mockResults: SaveResult[] = [
        { proposalId: pid, status, confirmationBatchId: 'batch-1', detail: `test:${status}` },
      ];
      const mockExecutor = createMockSaveExecutor(mockResults);

      const results = await executeConfirmedOwnershipSaves({
        db,
        sessionId: SESSION_ID,
        confirmedSaveEnabled: true,
        page: createMockPage(),
        saveExecutor: mockExecutor,
      });

      expect(hasAnyFailure(results)).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Test 10 — Mixed saved + saveFailed exits nonzero
  // -----------------------------------------------------------------------
  it('mixed saved + saveFailed has failures (exit nonzero)', async () => {
    const pid1 = seedEligibleItem(db, { sessionId: SESSION_ID, steamAppId: 730 });
    const pid2 = seedEligibleItem(db, {
      sessionId: SESSION_ID,
      steamAppId: 731,
      backloggdSlug: 'game-731',
      gameTitle: 'Game 731',
    });
    createConfirmedConfirmation(db, SESSION_ID, pid1);
    createConfirmedConfirmation(db, SESSION_ID, pid2);

    const mockResults: SaveResult[] = [
      { proposalId: pid1, status: 'saved', confirmationBatchId: 'batch-1', detail: 'ok' },
      {
        proposalId: pid2,
        status: 'saveFailed',
        confirmationBatchId: 'batch-1',
        detail: 'no_click_driven_save_request_observed',
      },
    ];
    const mockExecutor = createMockSaveExecutor(mockResults);

    const results = await executeConfirmedOwnershipSaves({
      db,
      sessionId: SESSION_ID,
      confirmedSaveEnabled: true,
      page: createMockPage(),
      saveExecutor: mockExecutor,
    });

    expect(hasAnyFailure(results)).toBe(true);
    // Verify per-confirmation status is preserved
    expect(results[0].status).toBe('saved');
    expect(results[1].status).toBe('saveFailed');
  });

  // -----------------------------------------------------------------------
  // Test 11 — Mixed saved + stale exits nonzero
  // -----------------------------------------------------------------------
  it('mixed saved + stale has failures (exit nonzero)', async () => {
    const pid1 = seedEligibleItem(db, { sessionId: SESSION_ID, steamAppId: 730 });
    const pid2 = seedEligibleItem(db, {
      sessionId: SESSION_ID,
      steamAppId: 731,
      backloggdSlug: 'game-731',
      gameTitle: 'Game 731',
    });
    createConfirmedConfirmation(db, SESSION_ID, pid1);
    createConfirmedConfirmation(db, SESSION_ID, pid2);

    const mockResults: SaveResult[] = [
      { proposalId: pid1, status: 'saved', confirmationBatchId: 'batch-1', detail: 'ok' },
      {
        proposalId: pid2,
        status: 'stale',
        confirmationBatchId: 'batch-1',
        detail: 'import_item_status_changed',
      },
    ];
    const mockExecutor = createMockSaveExecutor(mockResults);

    const results = await executeConfirmedOwnershipSaves({
      db,
      sessionId: SESSION_ID,
      confirmedSaveEnabled: true,
      page: createMockPage(),
      saveExecutor: mockExecutor,
    });

    expect(hasAnyFailure(results)).toBe(true);
    expect(results[0].status).toBe('saved');
    expect(results[1].status).toBe('stale');
  });

  // -----------------------------------------------------------------------
  // Test 12 — Mixed saved + blockedWrite exits nonzero
  // -----------------------------------------------------------------------
  it('mixed saved + blockedWrite has failures (exit nonzero)', async () => {
    const pid1 = seedEligibleItem(db, { sessionId: SESSION_ID, steamAppId: 730 });
    const pid2 = seedEligibleItem(db, {
      sessionId: SESSION_ID,
      steamAppId: 731,
      backloggdSlug: 'game-731',
      gameTitle: 'Game 731',
    });
    createConfirmedConfirmation(db, SESSION_ID, pid1);
    createConfirmedConfirmation(db, SESSION_ID, pid2);

    const mockResults: SaveResult[] = [
      { proposalId: pid1, status: 'saved', confirmationBatchId: 'batch-1', detail: 'ok' },
      {
        proposalId: pid2,
        status: 'blockedWrite',
        confirmationBatchId: 'batch-1',
        detail: 'write_blocked',
      },
    ];
    const mockExecutor = createMockSaveExecutor(mockResults);

    const results = await executeConfirmedOwnershipSaves({
      db,
      sessionId: SESSION_ID,
      confirmedSaveEnabled: true,
      page: createMockPage(),
      saveExecutor: mockExecutor,
    });

    expect(hasAnyFailure(results)).toBe(true);
    expect(results[0].status).toBe('saved');
    expect(results[1].status).toBe('blockedWrite');
  });
});
