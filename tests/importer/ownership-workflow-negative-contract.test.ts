/**
 * Phase 5E Slice 2 — ownership workflow negative contract tests.
 *
 * Offline negative contract tests that prove unsafe ownership workflow
 * shortcuts remain impossible.  These tests verify that workflow contracts
 * fail safely when an operator or future code attempts to skip required
 * gates.
 *
 * ## Safety guarantees
 *
 * - No Playwright import in this file.
 * - No write-guard / final-save selector / allowance helper imported.
 * - No live Backloggd calls.
 * - No real browser creation.
 * - No new runtime orchestrator.
 * - Confirmation rows created only through `applyOwnershipConfirmationSelection`.
 * - No items marked `saved` except through a mocked save executor (used only
 *   for integration contract checks).
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
  confirmExactProposals,
  confirmAllEligibleProposals,
} from '../../src/importer/ownership-save-confirm-cli.js';
import {
  executeConfirmedOwnershipSaves,
  countConfirmedRows,
} from '../../src/importer/ownership-save-command.js';
import { revalidateConfirmation } from '../../src/importer/ownership-staging-executor.js';
import type { ConfirmationRow } from '../../src/importer/ownership-staging-executor.js';
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
// Helpers (self-contained — no cross-test-file dependencies)
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

function seedOtherwiseEligibleUnsupportedKind(
  db: Database.Database,
  sessionId: string,
  kind: 'status' | 'playlog',
): string {
  const pid = seedImportItem(db, {
    importSessionId: sessionId,
    steamAppId: 730,
    proposalKind: kind,
    frozenPayload: STEAM_DIGITAL_PAYLOAD,
    status: 'approved',
    backloggdSlug: 'game-730',
  });
  simulateApprovedWithAbsentProof(db, pid, 'ownership-change-needed:absent');
  return pid;
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

// ---------------------------------------------------------------------------
// Negative Contract Tests
// ---------------------------------------------------------------------------

// ==========================================================================
// Tests 2-3: Confirmation-row gate — the save command must reject
// confirmation rows that are cross-session or have a non-confirmed status.
// ==========================================================================

describe('ownership workflow negative — confirmation-row gate', () => {
  let db: Database.Database;
  const SESSION = 'test-session';

  beforeEach(() => {
    db = createFreshDb();
    seedMinimalSession(db, SESSION);
  });

  afterEach(() => {
    db.close();
  });

  it('rejects confirmation row from a different session (defense-in-depth)', () => {
    const pid = seedEligibleItem(db, { sessionId: SESSION });
    createConfirmedConfirmation(db, SESSION, pid);

    const row = db
      .prepare(
        `SELECT proposal_id, import_session_id, confirmation_batch_id,
                planned_platform, planned_ownership_type, planned_slug,
                planned_absent_checked_at, status
         FROM import_item_confirmations WHERE proposal_id = ?`,
      )
      .get(pid) as ConfirmationRow;
    expect(row.import_session_id).toBe(SESSION);

    const result = revalidateConfirmation(db, 'different-session', row);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/session_mismatch/);
  });

  it('schema prevents non-confirmed status in confirmation rows', () => {
    const pid = seedEligibleItem(db, { sessionId: SESSION });
    const checkedAt = new Date().toISOString();

    expect(() => {
      db.prepare(
        `INSERT INTO import_item_confirmations
           (proposal_id, import_session_id, confirmation_batch_id, confirmed_at,
            planned_platform, planned_ownership_type, planned_slug,
            planned_absent_checked_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'staged')`,
      ).run(
        pid,
        SESSION,
        randomUUID(),
        new Date().toISOString(),
        'steam',
        'digital',
        'game-730',
        checkedAt,
      );
    }).toThrow('CHECK constraint');
  });
});

// ==========================================================================
// Tests 4-7: Stale-data revalidation — the save executor must reject
// confirmation rows whose underlying data changed after confirmation.
// ==========================================================================

describe('ownership workflow negative — stale-data revalidation', () => {
  let db: Database.Database;
  const SESSION = 'test-session';

  beforeEach(() => {
    db = createFreshDb();
    seedMinimalSession(db, SESSION);
  });

  afterEach(() => {
    db.close();
  });

  it('rejects stale import item status after confirmation', () => {
    const pid = seedEligibleItem(db, { sessionId: SESSION });
    createConfirmedConfirmation(db, SESSION, pid);
    const row = db
      .prepare(
        `SELECT proposal_id, import_session_id, confirmation_batch_id,
                planned_platform, planned_ownership_type, planned_slug,
                planned_absent_checked_at, status
         FROM import_item_confirmations WHERE proposal_id = ?`,
      )
      .get(pid) as ConfirmationRow;

    transitionItem(db, pid, 'importing');
    transitionItem(db, pid, 'saved');

    const result = revalidateConfirmation(db, SESSION, row);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/import_item_status/);
  });

  it('rejects stale canonical proposal status after confirmation', () => {
    const pid = seedEligibleItem(db, { sessionId: SESSION });
    createConfirmedConfirmation(db, SESSION, pid);
    const row = db
      .prepare(
        `SELECT proposal_id, import_session_id, confirmation_batch_id,
                planned_platform, planned_ownership_type, planned_slug,
                planned_absent_checked_at, status
         FROM import_item_confirmations WHERE proposal_id = ?`,
      )
      .get(pid) as ConfirmationRow;

    db.prepare('UPDATE proposals SET status = ? WHERE id = ?').run('skipped', pid);

    const result = revalidateConfirmation(db, SESSION, row);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/canonical_status/);
  });

  it('rejects changed frozen payload after confirmation', () => {
    const pid = seedEligibleItem(db, { sessionId: SESSION });
    createConfirmedConfirmation(db, SESSION, pid);
    const row = db
      .prepare(
        `SELECT proposal_id, import_session_id, confirmation_batch_id,
                planned_platform, planned_ownership_type, planned_slug,
                planned_absent_checked_at, status
         FROM import_item_confirmations WHERE proposal_id = ?`,
      )
      .get(pid) as ConfirmationRow;

    db.prepare('UPDATE import_items SET frozen_payload = ? WHERE proposal_id = ?').run(
      '{"platform":"xbox","ownershipType":"digital"}',
      pid,
    );

    const result = revalidateConfirmation(db, SESSION, row);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/payload/);
  });

  it('rejects changed absent-proof checkedAt after confirmation', () => {
    const pid = seedEligibleItem(db, { sessionId: SESSION });
    createConfirmedConfirmation(db, SESSION, pid);
    const row = db
      .prepare(
        `SELECT proposal_id, import_session_id, confirmation_batch_id,
                planned_platform, planned_ownership_type, planned_slug,
                planned_absent_checked_at, status
         FROM import_item_confirmations WHERE proposal_id = ?`,
      )
      .get(pid) as ConfirmationRow;

    const laterTimestamp = new Date(Date.now() + 3600000).toISOString();
    const newReason = `reconciled:absent:ownership-change-needed:absent:checkedAt=${laterTimestamp}`;
    db.prepare('UPDATE import_items SET outcome_reason = ? WHERE proposal_id = ?').run(
      newReason,
      pid,
    );

    const result = revalidateConfirmation(db, SESSION, row);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/checked_at|absent/);
  });
});

// ==========================================================================
// Tests 8-10: Confirm-all exclusion — confirm-all-eligible must not create
// confirmation rows for items that are terminal, have malformed payloads,
// or lack valid absent proof.
// ==========================================================================

describe('ownership workflow negative — confirm-all exclusion', () => {
  let db: Database.Database;
  const SESSION = 'test-session';

  beforeEach(() => {
    db = createFreshDb();
    seedMinimalSession(db, SESSION);
  });

  afterEach(() => {
    db.close();
  });

  it('does not confirm terminal import items', () => {
    seedImportItem(db, {
      importSessionId: SESSION,
      steamAppId: 730,
      status: 'saved',
      backloggdSlug: 'game-730',
    });

    const plan = buildOwnershipSavePlan({ db, sessionId: SESSION });
    expect(plan.counts.eligibleCandidates).toBe(0);
    expect(plan.counts.excludedTerminal).toBe(1);

    expect(() => confirmAllEligibleProposals({ db, sessionId: SESSION })).toThrow(
      'empty selection',
    );
  });

  it('does not confirm malformed frozen payload rows', () => {
    seedImportItem(db, {
      importSessionId: SESSION,
      steamAppId: 730,
      status: 'approved',
      backloggdSlug: 'game-730',
      frozenPayload: 'not-json',
    });

    const plan = buildOwnershipSavePlan({ db, sessionId: SESSION });
    expect(plan.counts.eligibleCandidates).toBe(0);
    expect(plan.counts.excludedMalformedMetadata).toBeGreaterThanOrEqual(1);

    expect(() => confirmAllEligibleProposals({ db, sessionId: SESSION })).toThrow(
      'empty selection',
    );
  });

  it('does not confirm rows with invalid absent proof', () => {
    seedImportItem(db, {
      importSessionId: SESSION,
      steamAppId: 730,
      status: 'approved',
      backloggdSlug: 'game-730',
      frozenPayload: STEAM_DIGITAL_PAYLOAD,
    });

    const plan = buildOwnershipSavePlan({ db, sessionId: SESSION });
    expect(plan.counts.eligibleCandidates).toBe(0);
    expect(plan.counts.excludedMissingOrInvalidAbsentProof).toBe(1);

    expect(() => confirmAllEligibleProposals({ db, sessionId: SESSION })).toThrow(
      'empty selection',
    );
  });
});

// ==========================================================================
// Tests 11-12: Confirm-exact rejection — confirm-exact-proposals must not
// create confirmation rows for unsupported proposal kinds or wrong-session
// proposals.
// ==========================================================================

describe('ownership workflow negative — confirm-exact rejection', () => {
  let db: Database.Database;
  const SESSION = 'test-session';
  const SESSION_B = 'other-session';

  beforeEach(() => {
    db = createFreshDb();
    seedMinimalSession(db, SESSION);
    seedMinimalSession(db, SESSION_B);
  });

  afterEach(() => {
    db.close();
  });

  it('rejects status proposal that is otherwise eligible', () => {
    const pid = seedOtherwiseEligibleUnsupportedKind(db, SESSION, 'status');

    const plan = buildOwnershipSavePlan({ db, sessionId: SESSION });
    expect(plan.counts.eligibleCandidates).toBe(0);
    expect(plan.counts.excludedUnsupportedKind).toBe(1);
    expect(plan.counts.excludedMalformedMetadata).toBe(0);
    expect(plan.counts.excludedMissingOrInvalidAbsentProof).toBe(0);

    expect(() => confirmExactProposals({ db, sessionId: SESSION, proposalIds: [pid] })).toThrow(
      'unknown proposal id',
    );

    const count = db.prepare('SELECT COUNT(*) AS cnt FROM import_item_confirmations').get() as {
      cnt: number;
    };
    expect(count.cnt).toBe(0);
  });

  it('rejects playlog proposal that is otherwise eligible', () => {
    const pid = seedOtherwiseEligibleUnsupportedKind(db, SESSION, 'playlog');

    const plan = buildOwnershipSavePlan({ db, sessionId: SESSION });
    expect(plan.counts.eligibleCandidates).toBe(0);
    expect(plan.counts.excludedUnsupportedKind).toBe(1);
    expect(plan.counts.excludedMalformedMetadata).toBe(0);
    expect(plan.counts.excludedMissingOrInvalidAbsentProof).toBe(0);

    expect(() => confirmExactProposals({ db, sessionId: SESSION, proposalIds: [pid] })).toThrow(
      'unknown proposal id',
    );

    const count = db.prepare('SELECT COUNT(*) AS cnt FROM import_item_confirmations').get() as {
      cnt: number;
    };
    expect(count.cnt).toBe(0);
  });

  it('rejects wrong-session proposals', () => {
    seedEligibleItem(db, { sessionId: SESSION, steamAppId: 730 });
    const pidB = seedEligibleItem(db, {
      sessionId: SESSION_B,
      steamAppId: 731,
      backloggdSlug: 'game-731',
      gameTitle: 'Game 731',
    });

    expect(() => confirmExactProposals({ db, sessionId: SESSION, proposalIds: [pidB] })).toThrow(
      'unknown proposal id',
    );

    const aRows = db
      .prepare('SELECT COUNT(*) AS cnt FROM import_item_confirmations WHERE import_session_id = ?')
      .get(SESSION) as { cnt: number };
    expect(aRows.cnt).toBe(0);
  });
});

// ==========================================================================
// Tests 21-23: Save result status safety — unsafe statuses must never count
// as success, and mixed results must be treated as failure.
// ==========================================================================

describe('ownership workflow negative — save result status safety', () => {
  let db: Database.Database;
  const SESSION = 'test-session';

  beforeEach(() => {
    db = createFreshDb();
    seedMinimalSession(db, SESSION);
  });

  afterEach(() => {
    db.close();
  });

  for (const status of [
    'blockedWrite',
    'saveFailed',
    'verificationFailed',
    'browserFailed',
    'stagingFailed',
    'unsupported',
    'stale',
  ] as const) {
    it(`status "${status}" is surfaced without remapping by save command`, async () => {
      const pid = seedEligibleItem(db, { sessionId: SESSION });
      createConfirmedConfirmation(db, SESSION, pid);

      const mockResults: SaveResult[] = [
        {
          proposalId: pid,
          status,
          confirmationBatchId: 'batch-1',
          detail: 'negative contract test',
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

      expect(results).toHaveLength(1);
      expect(results[0].status).toBe(status);
      // Workflow-level contract: executeConfirmedOwnershipSaves preserves each status
      // without remapping.  Failure classification (nonzero exit) is tested in
      // ownership-save-command.test.ts exit-status decisions.
    });
  }

  it('all saved results are preserved without remapping', async () => {
    const pid1 = seedEligibleItem(db, { sessionId: SESSION, steamAppId: 730 });
    const pid2 = seedEligibleItem(db, {
      sessionId: SESSION,
      steamAppId: 731,
      backloggdSlug: 'game-731',
      gameTitle: 'Game 731',
    });
    createConfirmedConfirmation(db, SESSION, pid1);
    createConfirmedConfirmation(db, SESSION, pid2);

    const mockResults: SaveResult[] = [
      { proposalId: pid1, status: 'saved', confirmationBatchId: 'batch-1', detail: 'ok' },
      { proposalId: pid2, status: 'saved', confirmationBatchId: 'batch-1', detail: 'ok' },
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
    expect(results[1].status).toBe('saved');
  });

  it('mixed saved + stale preserves both statuses', async () => {
    const pid1 = seedEligibleItem(db, { sessionId: SESSION, steamAppId: 730 });
    const pid2 = seedEligibleItem(db, {
      sessionId: SESSION,
      steamAppId: 731,
      backloggdSlug: 'game-731',
      gameTitle: 'Game 731',
    });
    createConfirmedConfirmation(db, SESSION, pid1);
    createConfirmedConfirmation(db, SESSION, pid2);

    const mockResults: SaveResult[] = [
      { proposalId: pid1, status: 'saved', confirmationBatchId: 'batch-1', detail: 'ok' },
      {
        proposalId: pid2,
        status: 'stale',
        confirmationBatchId: 'batch-1',
        detail: 'import_item_status_changed',
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

    expect(results).toHaveLength(2);
    expect(results[0].status).toBe('saved');
    expect(results[1].status).toBe('stale');
  });

  it('mixed saved + blockedWrite preserves both statuses', async () => {
    const pid1 = seedEligibleItem(db, { sessionId: SESSION, steamAppId: 730 });
    const pid2 = seedEligibleItem(db, {
      sessionId: SESSION,
      steamAppId: 731,
      backloggdSlug: 'game-731',
      gameTitle: 'Game 731',
    });
    createConfirmedConfirmation(db, SESSION, pid1);
    createConfirmedConfirmation(db, SESSION, pid2);

    const mockResults: SaveResult[] = [
      { proposalId: pid1, status: 'saved', confirmationBatchId: 'batch-1', detail: 'ok' },
      {
        proposalId: pid2,
        status: 'blockedWrite',
        confirmationBatchId: 'batch-1',
        detail: 'write_blocked',
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

    expect(results).toHaveLength(2);
    expect(results[0].status).toBe('saved');
    expect(results[1].status).toBe('blockedWrite');
  });
});

// ==========================================================================
// Tests 24-25: Cross-session isolation — confirmed rows and eligible
// candidates are scoped per session.
// ==========================================================================

describe('ownership workflow negative — cross-session isolation', () => {
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

  it('cross-session confirmed rows are ignored by save command contract', async () => {
    const pidA = seedEligibleItem(db, { sessionId: SESSION_A });
    const pidB = seedEligibleItem(db, {
      sessionId: SESSION_B,
      steamAppId: 731,
      backloggdSlug: 'game-731',
      gameTitle: 'Game 731',
    });

    createConfirmedConfirmation(db, SESSION_A, pidA);
    createConfirmedConfirmation(db, SESSION_B, pidB);

    expect(countConfirmedRows(db, SESSION_A)).toBe(1);
    expect(countConfirmedRows(db, SESSION_B)).toBe(1);

    const executorSpy = vi.fn(async (_opts: OwnershipSaveExecutorOptions) => {
      return [
        {
          proposalId: pidA,
          status: 'saved' as const,
          confirmationBatchId: 'batch',
          detail: 'ok',
        },
      ];
    });

    await executeConfirmedOwnershipSaves({
      db,
      sessionId: SESSION_A,
      confirmedSaveEnabled: true,
      page: createMockPage() as any,
      saveExecutor: executorSpy,
    });

    expect(executorSpy).toHaveBeenCalledTimes(1);
    expect(executorSpy).toHaveBeenCalledWith(expect.objectContaining({ sessionId: SESSION_A }));

    const bRows = db
      .prepare('SELECT COUNT(*) AS cnt FROM import_item_confirmations WHERE import_session_id = ?')
      .get(SESSION_B) as { cnt: number };
    expect(bRows.cnt).toBe(1);
  });

  it('cross-session eligible candidates are not confirmed by current-session confirm-all', () => {
    const pidA = seedEligibleItem(db, { sessionId: SESSION_A });
    seedEligibleItem(db, {
      sessionId: SESSION_B,
      steamAppId: 731,
      backloggdSlug: 'game-731',
      gameTitle: 'Game 731',
    });

    const result = confirmAllEligibleProposals({ db, sessionId: SESSION_A });
    expect(result.confirmed).toHaveLength(1);
    expect(result.confirmed[0].proposalId).toBe(pidA);

    const bConfirms = db
      .prepare('SELECT COUNT(*) AS cnt FROM import_item_confirmations WHERE import_session_id = ?')
      .get(SESSION_B) as { cnt: number };
    expect(bConfirms.cnt).toBe(0);
  });
});

// ==========================================================================
// Test 18: Helpers do not define a workflow orchestrator function.
// ==========================================================================

describe('ownership workflow negative — contract test helper safety', () => {
  it('does not define a workflow orchestrator function that chains compare → confirm → save', () => {
    const testFilePath = fileURLToPath(import.meta.url);
    const source = readFileSync(testFilePath, 'utf-8');
    const orchestratorNames = [
      'runFullWorkflow',
      'runOwnershipWorkflow',
      'executeWorkflow',
      'runAllOwnership',
      'chainOwnership',
      'ownershipWorkflow',
      'compareAndConfirm',
      'compareAndSave',
      'confirmAndSave',
      'compareConfirmSave',
    ];
    const sourceLines = source.split('\n');
    for (const name of orchestratorNames) {
      for (const line of sourceLines) {
        const trimmed = line.trim();
        if (
          (trimmed.startsWith('function ') ||
            trimmed.startsWith('const ') ||
            trimmed.startsWith('let ') ||
            trimmed.startsWith('export function ')) &&
          trimmed.includes(name)
        ) {
          expect.unreachable(
            `File contains orchestrator function definition "${name}" in: ${trimmed}`,
          );
        }
      }
    }
  });
});

// ==========================================================================
// Static safety: no Playwright, no write-guard/final-save imports.
// ==========================================================================

describe('ownership workflow negative — static import safety', () => {
  it('does not import Playwright', () => {
    const testFilePath = fileURLToPath(import.meta.url);
    const source = readFileSync(testFilePath, 'utf-8');
    const importLines = source.split('\n').filter((l) => l.includes('import'));
    for (const line of importLines) {
      expect(line).not.toMatch(/from ['"]playwright['"]/);
    }
  });

  it('does not import write-guard or final-save internals', () => {
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

  it('no package script chains ownership:compare, ownership:confirm, and ownership:save', () => {
    const scripts = PACKAGE.scripts ?? {};
    for (const [name, value] of Object.entries(scripts)) {
      if (!value) continue;
      const ownershipCommands = value.match(
        /(?:dist\/cli\/|src\/cli\/)?ownership[-:](compare|confirm|save)(?:\.(?:js|ts))?/g,
      );
      if (!ownershipCommands) continue;
      const unique = new Set(ownershipCommands);
      if (unique.size > 1) {
        expect.unreachable(`Script "${name}" chains multiple ownership commands: ${value}`);
      }
    }
  });

  it('no non-save script calls ownership-save CLI directly', () => {
    const scripts = PACKAGE.scripts ?? {};
    const savePattern = /(?:dist\/cli\/|src\/cli\/)?ownership[-:]save(?:\.(?:js|ts))?/;
    for (const [name, value] of Object.entries(scripts)) {
      if (!value) continue;
      if (name === 'ownership:save') continue;
      if (savePattern.test(value)) {
        expect.unreachable(`Script "${name}" references ownership save CLI: ${value}`);
      }
    }
  });

  it('no new source file defining a workflow orchestrator was added', () => {
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
      if (!existsSync(filePath)) continue;
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
    }
  });
});
