/**
 * Phase 5E Slice 1 — offline ownership workflow contract tests.
 *
 * These tests prove that the audited ownership workflow pieces compose in the
 * intended order (compare → show-plan → confirm → save) without creating any
 * new runtime path or touching live Backloggd.
 *
 * ## Safety guarantees
 *
 * - No Playwright import in this file.
 * - No write-guard / final-save selector / allowance helper imported.
 * - No live Backloggd calls.
 * - No real browser creation.
 * - No new runtime orchestrator.
 * - Confirmation rows created only through `applyOwnershipConfirmationSelection`.
 * - Save executed only through mocked executor or `executeConfirmedOwnershipSaves`.
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- mock page objects must avoid Playwright import */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCreateTableSQL } from '../../src/storage/schema.js';
import { runMigrations } from '../../src/storage/database.js';
import { transitionItem, reconcileItem } from '../../src/importer/import-items.js';
import { buildOwnershipSavePlan } from '../../src/importer/ownership-save-plan.js';
import { applyOwnershipConfirmationSelection } from '../../src/importer/ownership-save-confirmation.js';
import {
  buildAndShowPlan,
  confirmExactProposals,
  confirmAllEligibleProposals,
} from '../../src/importer/ownership-save-confirm-cli.js';
import {
  executeConfirmedOwnershipSaves,
  countConfirmedRows,
} from '../../src/importer/ownership-save-command.js';
import type {
  OwnershipSaveExecutorOptions,
  SaveResult,
} from '../../src/importer/ownership-save-executor.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STEAM_DIGITAL_PAYLOAD = '{"platform":"steam","ownershipType":"digital"}';
const PACKAGE_JSON_PATH = resolve('package.json');
const PACKAGE_JSON = readFileSync(PACKAGE_JSON_PATH, 'utf-8');
const PACKAGE = JSON.parse(PACKAGE_JSON) as { scripts?: Record<string, string> };

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

function createMockSaveExecutor(
  results: SaveResult[],
): (opts: OwnershipSaveExecutorOptions) => Promise<SaveResult[]> {
  return vi.fn(async (_opts: OwnershipSaveExecutorOptions) => {
    return results;
  });
}

function createMockPage(): unknown {
  return { __mock: true };
}

function hasFailureInResults(results: { status: string }[]): boolean {
  return results.some((r) => r.status !== 'saved');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// ==========================================================================
// Test 1: Compare is needed for eligible save-plan rows
// ==========================================================================

describe('ownership workflow — save plan eligibility requires comparison proof', () => {
  let db: Database.Database;
  const SESSION = 'test-session';

  beforeEach(() => {
    db = createFreshDb();
    seedMinimalSession(db, SESSION);
  });

  afterEach(() => {
    db.close();
  });

  it('produces 0 eligible candidates when no absent proof exists (compare not run)', () => {
    seedImportItem(db, {
      importSessionId: SESSION,
      status: 'approved',
      frozenPayload: STEAM_DIGITAL_PAYLOAD,
    });
    const plan = buildOwnershipSavePlan({ db, sessionId: SESSION });
    expect(plan.counts.eligibleCandidates).toBe(0);
    expect(plan.counts.excludedMissingOrInvalidAbsentProof).toBe(1);
  });

  it('produces eligible candidate when absent proof exists (compare was run)', () => {
    seedEligibleItem(db, { sessionId: SESSION });
    const plan = buildOwnershipSavePlan({ db, sessionId: SESSION });
    expect(plan.counts.eligibleCandidates).toBe(1);
    expect(plan.candidates[0].eligibility).toBe('eligible');
  });
});

// ==========================================================================
// Test 2: Show-plan does not create confirmation rows
// ==========================================================================

describe('ownership workflow — show-plan is read-only', () => {
  let db: Database.Database;
  const SESSION = 'test-session';

  beforeEach(() => {
    db = createFreshDb();
    seedMinimalSession(db, SESSION);
    seedEligibleItem(db, { sessionId: SESSION });
  });

  afterEach(() => {
    db.close();
  });

  it('does not create confirmation rows', () => {
    const result = buildAndShowPlan({ db, sessionId: SESSION });
    expect(result.plan.counts.eligibleCandidates).toBe(1);

    const rows = db.prepare('SELECT COUNT(*) AS cnt FROM import_item_confirmations').get() as {
      cnt: number;
    };
    expect(rows.cnt).toBe(0);
  });

  it('does not mutate import_items status', () => {
    buildAndShowPlan({ db, sessionId: SESSION });
    const items = db.prepare('SELECT status FROM import_items').all() as { status: string }[];
    for (const item of items) {
      expect(item.status).not.toBe('saved');
    }
  });
});

// ==========================================================================
// Test 3: Confirm exact proposal IDs creates durable confirmation rows
// ==========================================================================

describe('ownership workflow — confirm creates durable confirmation rows', () => {
  let db: Database.Database;
  const SESSION = 'test-session';

  beforeEach(() => {
    db = createFreshDb();
    seedMinimalSession(db, SESSION);
  });

  afterEach(() => {
    db.close();
  });

  it('creates durable confirmation rows with status = confirmed', () => {
    const pid = seedEligibleItem(db, { sessionId: SESSION });
    const result = confirmExactProposals({ db, sessionId: SESSION, proposalIds: [pid] });

    expect(result.confirmed).toHaveLength(1);
    expect(result.confirmed[0].proposalId).toBe(pid);

    const row = db
      .prepare(`SELECT proposal_id, status FROM import_item_confirmations WHERE proposal_id = ?`)
      .get(pid) as { proposal_id: string; status: string } | undefined;
    expect(row).toBeDefined();
    expect(row?.status).toBe('confirmed');
  });

  it('assigns the same batch ID to all confirmed rows in one call', () => {
    const pid1 = seedEligibleItem(db, { sessionId: SESSION, steamAppId: 730 });
    const pid2 = seedEligibleItem(db, {
      sessionId: SESSION,
      steamAppId: 731,
      backloggdSlug: 'game-731',
      gameTitle: 'Game 731',
    });
    const result = confirmExactProposals({ db, sessionId: SESSION, proposalIds: [pid1, pid2] });

    expect(result.confirmed).toHaveLength(2);
    expect(result.confirmed[0].confirmationBatchId).toBe(result.confirmed[1].confirmationBatchId);
  });
});

// ==========================================================================
// Tests 4-6: Confirmation rejection conditions
// ==========================================================================

describe('ownership workflow — confirmation rejects invalid selections', () => {
  let db: Database.Database;
  const SESSION = 'test-session';

  beforeEach(() => {
    db = createFreshDb();
    seedMinimalSession(db, SESSION);
  });

  afterEach(() => {
    db.close();
  });

  it('rejects empty selection (no proposal IDs)', () => {
    expect(() => confirmExactProposals({ db, sessionId: SESSION, proposalIds: [] })).toThrow(
      'Empty selection',
    );
  });

  it('rejects unknown proposal ID', () => {
    expect(() =>
      confirmExactProposals({ db, sessionId: SESSION, proposalIds: ['nonexistent-id'] }),
    ).toThrow('unknown proposal id');
  });

  it('rejects stale candidate when item status changed after plan build', () => {
    const pid = seedEligibleItem(db, { sessionId: SESSION });
    const plan = buildOwnershipSavePlan({ db, sessionId: SESSION });
    expect(plan.counts.eligibleCandidates).toBe(1);

    transitionItem(db, pid, 'importing');
    transitionItem(db, pid, 'saved');

    const result = applyOwnershipConfirmationSelection(db, plan, { byProposalIds: [pid] });
    expect(result.confirmed).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].proposalId).toBe(pid);
    expect(result.rejected[0].reason).toMatch(/import_item_status/);
  });
});

// ==========================================================================
// Tests 7-9: Save command safety gates
// ==========================================================================

describe('ownership workflow — save command safety gates', () => {
  let db: Database.Database;
  const SESSION = 'test-session';

  beforeEach(() => {
    db = createFreshDb();
    seedMinimalSession(db, SESSION);
  });

  afterEach(() => {
    db.close();
  });

  it('returns empty result when no durable confirmation rows exist', async () => {
    const page = createMockPage();
    const results = await executeConfirmedOwnershipSaves({
      db,
      sessionId: SESSION,
      confirmedSaveEnabled: true,
      page: page as any,
    });
    expect(results).toEqual([]);
  });

  it('throws when confirmedSaveEnabled is false', async () => {
    const page = createMockPage();
    await expect(
      executeConfirmedOwnershipSaves({
        db,
        sessionId: SESSION,
        confirmedSaveEnabled: false,
        page: page as any,
      }),
    ).rejects.toThrow('confirmedSaveEnabled must be true');
  });

  it('throws with whitespace-only session', async () => {
    const page = createMockPage();
    await expect(
      executeConfirmedOwnershipSaves({
        db,
        sessionId: '   ',
        confirmedSaveEnabled: true,
        page: page as any,
      }),
    ).rejects.toThrow('sessionId is required and must be non-empty');
  });
});

// ==========================================================================
// Test 10: Save command receives only the requested session's confirmed rows
// ==========================================================================

describe('ownership workflow — save command session isolation', () => {
  let db: Database.Database;
  const SESSION_A = 'session-a';
  const SESSION_B = 'session-b';

  beforeEach(() => {
    db = createFreshDb();
    seedMinimalSession(db, SESSION_A);
    seedMinimalSession(db, SESSION_B);
  });

  afterEach(() => {
    db.close();
  });

  it('countConfirmedRows returns only the requested session rows', () => {
    const pidA = seedEligibleItem(db, { sessionId: SESSION_A });
    const pidB = seedEligibleItem(db, {
      sessionId: SESSION_B,
      steamAppId: 731,
      backloggdSlug: 'game-731',
      gameTitle: 'Session B Game',
    });

    createConfirmedConfirmation(db, SESSION_A, pidA);
    createConfirmedConfirmation(db, SESSION_B, pidB);

    expect(countConfirmedRows(db, SESSION_A)).toBe(1);
    expect(countConfirmedRows(db, SESSION_B)).toBe(1);
    expect(countConfirmedRows(db, 'nonexistent')).toBe(0);
  });

  it('passes the correct sessionId to the save executor', async () => {
    const pid = seedEligibleItem(db, { sessionId: SESSION_A });
    createConfirmedConfirmation(db, SESSION_A, pid);

    const mockExecutor = createMockSaveExecutor([]);
    const page = createMockPage();

    await executeConfirmedOwnershipSaves({
      db,
      sessionId: SESSION_A,
      confirmedSaveEnabled: true,
      page: page as any,
      saveExecutor: mockExecutor,
    });

    expect(mockExecutor).toHaveBeenCalledTimes(1);
    expect(mockExecutor).toHaveBeenCalledWith(expect.objectContaining({ sessionId: SESSION_A }));
  });
});

// ==========================================================================
// Tests 11-15: Save result surfacing
// ==========================================================================

describe('ownership workflow — save result surfacing', () => {
  let db: Database.Database;
  const SESSION = 'test-session';

  beforeEach(() => {
    db = createFreshDb();
    seedMinimalSession(db, SESSION);
  });

  afterEach(() => {
    db.close();
  });

  it('surfaces saved as success', async () => {
    const pid = seedEligibleItem(db, { sessionId: SESSION });
    createConfirmedConfirmation(db, SESSION, pid);

    const mockResults: SaveResult[] = [
      { proposalId: pid, status: 'saved', confirmationBatchId: 'batch-1', detail: 'ok' },
    ];
    const mockExec = createMockSaveExecutor(mockResults);
    const page = createMockPage();

    const results = await executeConfirmedOwnershipSaves({
      db,
      sessionId: SESSION,
      confirmedSaveEnabled: true,
      page: page as any,
      saveExecutor: mockExec,
    });

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('saved');
    expect(hasFailureInResults(results)).toBe(false);
  });

  it('surfaces blockedWrite as nonzero/failure', async () => {
    const pid = seedEligibleItem(db, { sessionId: SESSION });
    createConfirmedConfirmation(db, SESSION, pid);

    const mockResults: SaveResult[] = [
      {
        proposalId: pid,
        status: 'blockedWrite',
        confirmationBatchId: 'batch-1',
        detail: 'blocked',
      },
    ];
    const mockExec = createMockSaveExecutor(mockResults);
    const page = createMockPage();

    const results = await executeConfirmedOwnershipSaves({
      db,
      sessionId: SESSION,
      confirmedSaveEnabled: true,
      page: page as any,
      saveExecutor: mockExec,
    });

    expect(results[0].status).toBe('blockedWrite');
    expect(hasFailureInResults(results)).toBe(true);
  });

  it('surfaces saveFailed as nonzero/failure', async () => {
    const pid = seedEligibleItem(db, { sessionId: SESSION });
    createConfirmedConfirmation(db, SESSION, pid);

    const mockResults: SaveResult[] = [
      { proposalId: pid, status: 'saveFailed', confirmationBatchId: 'batch-1', detail: 'failed' },
    ];
    const mockExec = createMockSaveExecutor(mockResults);
    const page = createMockPage();

    const results = await executeConfirmedOwnershipSaves({
      db,
      sessionId: SESSION,
      confirmedSaveEnabled: true,
      page: page as any,
      saveExecutor: mockExec,
    });

    expect(results[0].status).toBe('saveFailed');
    expect(hasFailureInResults(results)).toBe(true);
  });

  it('surfaces verificationFailed as nonzero/failure', async () => {
    const pid = seedEligibleItem(db, { sessionId: SESSION });
    createConfirmedConfirmation(db, SESSION, pid);

    const mockResults: SaveResult[] = [
      {
        proposalId: pid,
        status: 'verificationFailed',
        confirmationBatchId: 'batch-1',
        detail: 'verify fail',
      },
    ];
    const mockExec = createMockSaveExecutor(mockResults);
    const page = createMockPage();

    const results = await executeConfirmedOwnershipSaves({
      db,
      sessionId: SESSION,
      confirmedSaveEnabled: true,
      page: page as any,
      saveExecutor: mockExec,
    });

    expect(results[0].status).toBe('verificationFailed');
    expect(hasFailureInResults(results)).toBe(true);
  });

  it('surfaces mixed saved+saveFailed as nonzero/failure', async () => {
    const pid1 = seedEligibleItem(db, { sessionId: SESSION, steamAppId: 730 });
    const pid2 = seedEligibleItem(db, {
      sessionId: SESSION,
      steamAppId: 731,
      backloggdSlug: 'game-731',
      gameTitle: 'Game 2',
    });
    createConfirmedConfirmation(db, SESSION, pid1);
    createConfirmedConfirmation(db, SESSION, pid2);

    const mockResults: SaveResult[] = [
      { proposalId: pid1, status: 'saved', confirmationBatchId: 'batch-1', detail: 'ok' },
      { proposalId: pid2, status: 'saveFailed', confirmationBatchId: 'batch-1', detail: 'failed' },
    ];
    const mockExec = createMockSaveExecutor(mockResults);
    const page = createMockPage();

    const results = await executeConfirmedOwnershipSaves({
      db,
      sessionId: SESSION,
      confirmedSaveEnabled: true,
      page: page as any,
      saveExecutor: mockExec,
    });

    expect(results).toHaveLength(2);
    expect(results[0].status).toBe('saved');
    expect(results[1].status).toBe('saveFailed');
    expect(hasFailureInResults(results)).toBe(true);
  });
});

// ==========================================================================
// Test 16: Confirmation rows remain durable between confirm and save
// ==========================================================================

describe('ownership workflow — confirmation durability across steps', () => {
  let db: Database.Database;
  const SESSION = 'test-session';

  beforeEach(() => {
    db = createFreshDb();
    seedMinimalSession(db, SESSION);
  });

  afterEach(() => {
    db.close();
  });

  it('confirmation rows persist after re-opening the DB plan', () => {
    const pid = seedEligibleItem(db, { sessionId: SESSION });

    const confirmResult = confirmExactProposals({ db, sessionId: SESSION, proposalIds: [pid] });
    expect(confirmResult.confirmed).toHaveLength(1);

    const rows = db
      .prepare(
        `SELECT proposal_id, status FROM import_item_confirmations WHERE import_session_id = ?`,
      )
      .all(SESSION) as { proposal_id: string; status: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('confirmed');

    expect(countConfirmedRows(db, SESSION)).toBe(1);
  });
});

// ==========================================================================
// Test 17: Confirmation rows are not auto-created by compare or show-plan
// ==========================================================================

describe('ownership workflow — no auto-created confirmation rows', () => {
  let db: Database.Database;
  const SESSION = 'test-session';

  beforeEach(() => {
    db = createFreshDb();
    seedMinimalSession(db, SESSION);
  });

  afterEach(() => {
    db.close();
  });

  it('show-plan creates no confirmation rows', () => {
    seedEligibleItem(db, { sessionId: SESSION });
    buildAndShowPlan({ db, sessionId: SESSION });

    const count = db.prepare('SELECT COUNT(*) AS cnt FROM import_item_confirmations').get() as {
      cnt: number;
    };
    expect(count.cnt).toBe(0);
  });

  it('buildOwnershipSavePlan alone creates no confirmation rows', () => {
    seedEligibleItem(db, { sessionId: SESSION });
    buildOwnershipSavePlan({ db, sessionId: SESSION });

    const count = db.prepare('SELECT COUNT(*) AS cnt FROM import_item_confirmations').get() as {
      cnt: number;
    };
    expect(count.cnt).toBe(0);
  });
});

// ==========================================================================
// Tests 18-19: Confirm-all semantics
// ==========================================================================

describe('ownership workflow — confirm-all eligibility', () => {
  let db: Database.Database;
  const SESSION = 'test-session';

  beforeEach(() => {
    db = createFreshDb();
    seedMinimalSession(db, SESSION);
  });

  afterEach(() => {
    db.close();
  });

  it('confirm-all operates only on eligible candidates', () => {
    const pid1 = seedEligibleItem(db, { sessionId: SESSION, steamAppId: 730 });
    const pid2 = seedEligibleItem(db, {
      sessionId: SESSION,
      steamAppId: 731,
      backloggdSlug: 'game-731',
      gameTitle: 'Game 731',
    });

    const result = confirmAllEligibleProposals({ db, sessionId: SESSION });
    expect(result.confirmed).toHaveLength(2);
    expect(result.confirmed[0].proposalId).toBe(pid1);
    expect(result.confirmed[1].proposalId).toBe(pid2);
  });

  it('confirm-all does not include ineligible items', () => {
    seedEligibleItem(db, { sessionId: SESSION, steamAppId: 730 });
    seedImportItem(db, {
      importSessionId: SESSION,
      steamAppId: 731,
      status: 'approved',
      frozenPayload: STEAM_DIGITAL_PAYLOAD,
      backloggdSlug: 'game-731',
    });

    const result = confirmAllEligibleProposals({ db, sessionId: SESSION });
    expect(result.confirmed).toHaveLength(1);
  });

  it('confirm-all rejects stale items that changed between plan and apply', () => {
    const pid = seedEligibleItem(db, { sessionId: SESSION });
    const plan = buildOwnershipSavePlan({ db, sessionId: SESSION });
    expect(plan.counts.eligibleCandidates).toBe(1);

    transitionItem(db, pid, 'importing');
    transitionItem(db, pid, 'saved');

    const result = applyOwnershipConfirmationSelection(db, plan, { selectAll: true });
    expect(result.confirmed).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
  });
});

// ==========================================================================
// Test 20: Status/playlog never in ownership workflow
// ==========================================================================

describe('ownership workflow — status/playlog exclusion', () => {
  let db: Database.Database;
  const SESSION = 'test-session';

  beforeEach(() => {
    db = createFreshDb();
    seedMinimalSession(db, SESSION);
  });

  afterEach(() => {
    db.close();
  });

  it('status proposals are excluded from save plan', () => {
    seedImportItem(db, {
      importSessionId: SESSION,
      steamAppId: 730,
      proposalKind: 'status',
      frozenPayload: '{"status":"playing"}',
      status: 'approved',
    });
    const plan = buildOwnershipSavePlan({ db, sessionId: SESSION });
    expect(plan.counts.eligibleCandidates).toBe(0);
    expect(plan.counts.excludedUnsupportedKind).toBe(1);
  });

  it('playlog proposals are excluded from save plan', () => {
    seedImportItem(db, {
      importSessionId: SESSION,
      steamAppId: 730,
      proposalKind: 'playlog',
      frozenPayload: '{"playlog":"test"}',
      status: 'approved',
    });
    const plan = buildOwnershipSavePlan({ db, sessionId: SESSION });
    expect(plan.counts.eligibleCandidates).toBe(0);
    expect(plan.counts.excludedUnsupportedKind).toBe(1);
  });

  it('confirm-all excludes status/playlog proposals', () => {
    seedImportItem(db, {
      importSessionId: SESSION,
      steamAppId: 730,
      proposalKind: 'status',
      frozenPayload: '{"status":"playing"}',
      status: 'approved',
    });
    seedImportItem(db, {
      importSessionId: SESSION,
      steamAppId: 731,
      proposalKind: 'playlog',
      frozenPayload: '{"playlog":"test"}',
      status: 'approved',
      backloggdSlug: 'game-731',
    });

    const plan = buildOwnershipSavePlan({ db, sessionId: SESSION });
    expect(plan.counts.eligibleCandidates).toBe(0);

    expect(() => confirmAllEligibleProposals({ db, sessionId: SESSION })).toThrow(
      'empty selection',
    );
  });
});

// ==========================================================================
// Tests 21-22: Import safety — no Playwright / write-guard imports
// ==========================================================================

describe('ownership workflow — test file import safety', () => {
  it('does not import Playwright in this contract test file', () => {
    const testFilePath = fileURLToPath(import.meta.url);
    const source = readFileSync(testFilePath, 'utf-8');
    const importLines = source.split('\n').filter((l) => l.includes('import'));
    for (const line of importLines) {
      expect(line).not.toMatch(/from ['"]playwright['"]/);
    }
  });

  it('does not import write-guard internals in this contract test file', () => {
    const testFilePath = fileURLToPath(import.meta.url);
    const source = readFileSync(testFilePath, 'utf-8');
    const importLines = source.split('\n').filter((l) => l.includes('from'));
    const guardNames = [
      'installWriteGuard',
      'enableSaveAllowance',
      'disableSaveAllowance',
      'wasSavePostSeen',
      'clickFinalSave',
      'stageOwnershipInBrowser',
    ];
    for (const name of guardNames) {
      for (const line of importLines) {
        if (line.includes(name)) {
          expect.unreachable(`File imports write-guard function: ${name}`);
        }
      }
    }
  });
});

// ==========================================================================
// Test 23: Package scripts do not chain compare/confirm/save
// ==========================================================================

describe('ownership workflow — package script composition safety', () => {
  it('no script chains ownership commands together', () => {
    const scripts = PACKAGE.scripts ?? {};
    for (const [name, value] of Object.entries(scripts)) {
      if (!value) continue;
      const ownershipCommands = value.match(/ownership:(compare|confirm|save)/g);
      if (!ownershipCommands) continue;
      const unique = new Set(ownershipCommands);
      if (unique.size > 1) {
        expect.unreachable(`Script "${name}" chains multiple ownership commands: ${value}`);
      }
    }
  });
});

// ==========================================================================
// Tests 24-28: Existing test file integrity
// ==========================================================================

describe('ownership workflow — existing test file integrity', () => {
  const existingTestFiles = [
    {
      name: 'ownership-comparison-runner.test.ts',
      path: 'tests/importer/ownership-comparison-runner.test.ts',
    },
    {
      name: 'ownership-compare-command.test.ts',
      path: 'tests/importer/ownership-compare-command.test.ts',
    },
    {
      name: 'ownership-save-confirm-cli.test.ts',
      path: 'tests/importer/ownership-save-confirm-cli.test.ts',
    },
    {
      name: 'ownership-save-command.test.ts',
      path: 'tests/importer/ownership-save-command.test.ts',
    },
    {
      name: 'ownership-save-executor.test.ts',
      path: 'tests/importer/ownership-save-executor.test.ts',
    },
    {
      name: 'ownership-workflow-runbook.test.ts',
      path: 'tests/importer/ownership-workflow-runbook.test.ts',
    },
  ];

  for (const { name, path } of existingTestFiles) {
    it(`${name} exists`, () => {
      const fullPath = resolve(path);
      expect(existsSync(fullPath)).toBe(true);
    });
  }

  it('existing test files contain their expected describe blocks', () => {
    const describeBlocks: Record<string, string[]> = {
      'tests/importer/ownership-comparison-runner.test.ts': ['ownership-comparison-runner'],
      'tests/importer/ownership-compare-command.test.ts': ['ownership-compare-command'],
      'tests/importer/ownership-save-confirm-cli.test.ts': ['ownership-save-confirm-cli'],
      'tests/importer/ownership-save-command.test.ts': ['ownership-save-command'],
      'tests/importer/ownership-save-executor.test.ts': ['ownership-save-executor'],
      'tests/importer/ownership-workflow-runbook.test.ts': ['ownership-workflow runbook'],
    };

    for (const [relPath, expectedBlocks] of Object.entries(describeBlocks)) {
      const fullPath = resolve(relPath);
      const content = readFileSync(fullPath, 'utf-8');
      for (const block of expectedBlocks) {
        expect(content).toContain(block);
      }
    }
  });

  it('contract test does not import from those test files', () => {
    const testFilePath = fileURLToPath(import.meta.url);
    const source = readFileSync(testFilePath, 'utf-8');
    const importLines = source.split('\n').filter((l) => l.trimStart().startsWith('import'));
    for (const testFile of [
      'ownership-comparison-runner.test',
      'ownership-compare-command.test',
      'ownership-save-confirm-cli.test',
      'ownership-save-command.test',
      'ownership-save-executor.test',
      'ownership-workflow-runbook.test',
    ]) {
      for (const line of importLines) {
        if (line.includes(testFile)) {
          expect.unreachable(`Import line references test file "${testFile}": ${line}`);
        }
      }
    }
  });
});

// ==========================================================================
// Static safety: no new orchestrator source file
// ==========================================================================

describe('ownership workflow — no new orchestrator source', () => {
  const sourceFiles = [
    resolve('src/importer/index.ts'),
    resolve('src/importer/ownership-compare-command.ts'),
    resolve('src/importer/ownership-comparison-runner.ts'),
    resolve('src/importer/ownership-save-command.ts'),
    resolve('src/importer/ownership-save-confirm-cli.ts'),
    resolve('src/importer/ownership-save-confirmation.ts'),
    resolve('src/importer/ownership-save-executor.ts'),
    resolve('src/importer/ownership-save-plan.ts'),
    resolve('src/importer/ownership-staging-executor.ts'),
    resolve('src/importer/import-items.ts'),
  ];

  for (const filePath of sourceFiles) {
    it(`${filePath.split('/').pop()} does not define a workflow orchestrator function`, () => {
      if (!existsSync(filePath)) return;
      const content = readFileSync(filePath, 'utf-8');
      const orchestratorPatterns = [
        /runFullWorkflow/,
        /runOwnershipWorkflow/,
        /executeWorkflow/,
        /runAllOwnership/,
        /chainOwnership/,
        /ownershipWorkflow/,
        /compareAndConfirm/,
        /compareAndSave/,
        /confirmAndSave/,
        /compareConfirmSave/,
      ];
      for (const pattern of orchestratorPatterns) {
        const match = content.match(pattern);
        if (match) {
          expect.unreachable(
            `File ${filePath} contains potential orchestrator pattern: ${pattern}`,
          );
        }
      }
    });
  }
});
