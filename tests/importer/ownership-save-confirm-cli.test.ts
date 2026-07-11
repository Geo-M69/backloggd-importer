/**
 * Tests for the ownership save confirmation CLI integration (Phase 5D Slice 2).
 *
 * Covers:
 *   1.  Missing --session fails before DB open.
 *   2.  Whitespace-only --session fails before DB open.
 *   3.  Missing explicit action fails before DB mutation.
 *   4.  Show-plan is read-only.
 *   5.  Show-plan does not create confirmation rows.
 *   6.  Show-plan does not mutate import_items.
 *   7.  Show-plan does not launch browser.
 *   8.  Confirm exact proposal IDs creates confirmation rows through the
 *       existing confirmation-selection function.
 *   9.  Confirm exact proposal IDs trims whitespace around IDs.
 *   10. Duplicate proposal IDs are rejected.
 *   11. Unknown proposal IDs are rejected.
 *   12. Empty selection is rejected unless explicit confirm-all is present.
 *   13. Explicit confirm-all confirms all eligible candidates.
 *   14. Confirm-all does not confirm ineligible/stale/malformed candidates.
 *   15. Stale candidate rejection is surfaced distinctly.
 *   16. Idempotent reconfirmation remains safe.
 *   17. Confirming does not mutate import_items.
 *   18. Confirming does not mutate proposal rows.
 *   19. Status/playlog proposals are not confirmed.
 *   20. Result output preserves proposal IDs and confirmation batch ID.
 *   21. Plan summary counts are surfaced.
 *   22. No browser/Playwright imports in the new command.
 *   23. New integration does not import final-save executor.
 *   24. New integration does not import staging executor.
 *   25. New integration does not call processItem, transitionItem, or
 *       reconcileItem.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { getCreateTableSQL } from '../../src/storage/schema.js';
import { runMigrations } from '../../src/storage/database.js';
import { getItem, transitionItem, reconcileItem } from '../../src/importer/import-items.js';
import { buildOwnershipSavePlan } from '../../src/importer/ownership-save-plan.js';
import { applyOwnershipConfirmationSelection } from '../../src/importer/ownership-save-confirmation.js';
import {
  buildAndShowPlan,
  confirmExactProposals,
  confirmAllEligibleProposals,
  formatPlanOutput,
  formatConfirmResult,
  formatCandidateLine,
  formatCountsLines,
  formatConfirmedLine,
} from '../../src/importer/ownership-save-confirm-cli.js';
import { computeConfirmExitCode } from '../../src/cli/ownership-confirm.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ConfirmationRow {
  id: number;
  proposal_id: string;
  import_session_id: string;
  confirmation_batch_id: string;
  confirmed_at: string;
  planned_platform: string | null;
  planned_ownership_type: string | null;
  planned_slug: string | null;
  planned_absent_checked_at: string | null;
  planned_payload: string | null;
  status: string;
}

// ---------------------------------------------------------------------------
// Helpers (matching patterns from existing test files)
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

function seedProposal(
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
        proposal_kind, status, match_confidence,
        requires_manual_review, suggested_payload,
        created_at, updated_at)
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
  const payload = overrides.frozenPayload ?? '{"platform":"steam","ownershipType":"digital"}';
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
    seedProposal(db, {
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
    frozenPayload: '{"platform":"steam","ownershipType":"digital"}',
    proposalKind: 'ownership',
  });

  simulateApprovedWithAbsentProof(db, proposalId, overrides.proofReason);
  return proposalId;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ownership-save-confirm-cli', () => {
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
  // Test 1: Missing --session fails before DB open
  // -----------------------------------------------------------------------
  it('rejects missing session ID', () => {
    expect(() => buildAndShowPlan({ db, sessionId: '' })).toThrow(
      'sessionId is required and must be non-empty',
    );
    expect(() => confirmExactProposals({ db, sessionId: '', proposalIds: ['abc'] })).toThrow(
      'sessionId is required and must be non-empty',
    );
    expect(() => confirmAllEligibleProposals({ db, sessionId: '' })).toThrow(
      'sessionId is required and must be non-empty',
    );
  });

  // -----------------------------------------------------------------------
  // Test 2: Whitespace-only --session fails before DB open
  // -----------------------------------------------------------------------
  it('rejects whitespace-only session ID', () => {
    expect(() => buildAndShowPlan({ db, sessionId: '   ' })).toThrow(
      'sessionId is required and must be non-empty',
    );
    expect(() => confirmExactProposals({ db, sessionId: '   ', proposalIds: ['abc'] })).toThrow(
      'sessionId is required and must be non-empty',
    );
    expect(() => confirmAllEligibleProposals({ db, sessionId: '   ' })).toThrow(
      'sessionId is required and must be non-empty',
    );
  });

  // -----------------------------------------------------------------------
  // Test 3: Missing explicit action fails before DB mutation
  // -----------------------------------------------------------------------
  it('empty proposal IDs are rejected for confirmExactProposals', () => {
    expect(() => confirmExactProposals({ db, sessionId: SESSION_ID, proposalIds: [] })).toThrow(
      'Empty selection',
    );
  });

  it('whitespace-only proposal IDs are rejected explicitly (no silent filtering)', () => {
    // Regression: previously these would be silently filtered and could
    // confirm a real proposal alongside empty tokens.  Now the call must
    // throw as soon as any token trims to empty.
    expect(() =>
      confirmExactProposals({ db, sessionId: SESSION_ID, proposalIds: ['  ', '', ' '] }),
    ).toThrow(/non-empty after trim|Empty selection/);
  });

  // -----------------------------------------------------------------------
  // Test 4: Show-plan is read-only
  // -----------------------------------------------------------------------
  it('show-plan is read-only — does not mutate any table', () => {
    seedEligibleItem(db);
    const beforeMod = db.prepare('SELECT COUNT(*) AS cnt FROM import_item_confirmations').get() as {
      cnt: number;
    };
    const beforeItems = db.prepare('SELECT COUNT(*) AS cnt FROM import_items').get() as {
      cnt: number;
    };
    const beforeProposals = db.prepare('SELECT COUNT(*) AS cnt FROM proposals').get() as {
      cnt: number;
    };

    const { plan } = buildAndShowPlan({ db, sessionId: SESSION_ID });

    const afterMod = db.prepare('SELECT COUNT(*) AS cnt FROM import_item_confirmations').get() as {
      cnt: number;
    };
    const afterItems = db.prepare('SELECT COUNT(*) AS cnt FROM import_items').get() as {
      cnt: number;
    };
    const afterProposals = db.prepare('SELECT COUNT(*) AS cnt FROM proposals').get() as {
      cnt: number;
    };

    expect(afterMod.cnt).toBe(beforeMod.cnt);
    expect(afterItems.cnt).toBe(beforeItems.cnt);
    expect(afterProposals.cnt).toBe(beforeProposals.cnt);
    expect(plan.candidates.length).toBeGreaterThan(0);
  });

  // -----------------------------------------------------------------------
  // Test 5: Show-plan does not create confirmation rows
  // -----------------------------------------------------------------------
  it('show-plan does not create confirmation rows', () => {
    seedEligibleItem(db);
    buildAndShowPlan({ db, sessionId: SESSION_ID });
    const rows = db.prepare('SELECT COUNT(*) AS cnt FROM import_item_confirmations').get() as {
      cnt: number;
    };
    expect(rows.cnt).toBe(0);
  });

  // -----------------------------------------------------------------------
  // Test 6: Show-plan does not mutate import_items
  // -----------------------------------------------------------------------
  it('show-plan does not mutate import_items', () => {
    const pid = seedEligibleItem(db);
    const before = getItem(db, pid);
    buildAndShowPlan({ db, sessionId: SESSION_ID });
    const after = getItem(db, pid);
    expect(after?.status).toBe(before?.status);
    expect(after?.outcomeReason).toBe(before?.outcomeReason);
    expect(after?.frozenPayload).toBe(before?.frozenPayload);
  });

  // -----------------------------------------------------------------------
  // Test 7: Show-plan does not launch browser (verified statically)
  // -----------------------------------------------------------------------
  // This is verified by the static import tests below.

  // -----------------------------------------------------------------------
  // Test 8: Confirm exact proposal IDs creates confirmation rows
  // -----------------------------------------------------------------------
  it('confirm exact proposal IDs creates confirmation rows', () => {
    const pid = seedEligibleItem(db);
    const result = confirmExactProposals({ db, sessionId: SESSION_ID, proposalIds: [pid] });

    expect(result.confirmed).toHaveLength(1);
    expect(result.confirmed[0].proposalId).toBe(pid);

    const row: ConfirmationRow | undefined = db
      .prepare('SELECT * FROM import_item_confirmations WHERE proposal_id = ?')
      .get(pid) as ConfirmationRow | undefined;
    expect(row).toBeDefined();
    if (row) {
      expect(row.proposal_id).toBe(pid);
      expect(row.status).toBe('confirmed');
      expect(row.planned_platform).toBe('steam');
      expect(row.planned_ownership_type).toBe('digital');
    }
  });

  // -----------------------------------------------------------------------
  // Test 9: Confirm exact proposal IDs trims whitespace around IDs
  // -----------------------------------------------------------------------
  it('confirm exact trims whitespace around proposal IDs', () => {
    const pid = seedEligibleItem(db);
    const result = confirmExactProposals({
      db,
      sessionId: SESSION_ID,
      proposalIds: [`  ${pid}  `],
    });

    expect(result.confirmed).toHaveLength(1);
    expect(result.confirmed[0].proposalId).toBe(pid);

    const row = db
      .prepare('SELECT COUNT(*) AS cnt FROM import_item_confirmations WHERE proposal_id = ?')
      .get(pid) as { cnt: number };
    expect(row.cnt).toBe(1);
  });

  // -----------------------------------------------------------------------
  // Finding 1 — empty token in exact proposal selection must throw and
  // must NOT silently filter, even when other tokens are valid.
  // -----------------------------------------------------------------------
  it('Finding 1: exact selection with one valid + one whitespace token throws', () => {
    const pid = seedEligibleItem(db);
    expect(() =>
      confirmExactProposals({ db, sessionId: SESSION_ID, proposalIds: [pid, ' '] }),
    ).toThrow(/non-empty after trim/);
  });

  it('Finding 1: exact selection with one valid + one empty token throws', () => {
    const pid = seedEligibleItem(db);
    expect(() =>
      confirmExactProposals({ db, sessionId: SESSION_ID, proposalIds: [pid, ''] }),
    ).toThrow(/non-empty after trim/);
  });

  it('Finding 1: failed exact selection does not create confirmation rows', () => {
    const pid = seedEligibleItem(db);
    const before = db.prepare('SELECT COUNT(*) AS cnt FROM import_item_confirmations').get() as {
      cnt: number;
    };

    expect(() =>
      confirmExactProposals({ db, sessionId: SESSION_ID, proposalIds: [pid, ' '] }),
    ).toThrow(/non-empty after trim/);

    const after = db.prepare('SELECT COUNT(*) AS cnt FROM import_item_confirmations').get() as {
      cnt: number;
    };
    expect(after.cnt).toBe(before.cnt);

    // Specifically: no row for the valid proposal id
    const rowForPid = db
      .prepare('SELECT COUNT(*) AS cnt FROM import_item_confirmations WHERE proposal_id = ?')
      .get(pid) as { cnt: number };
    expect(rowForPid.cnt).toBe(0);
  });

  it('Finding 1: exact selection with only empty tokens is rejected', () => {
    expect(() =>
      confirmExactProposals({ db, sessionId: SESSION_ID, proposalIds: ['', '  ', '\t'] }),
    ).toThrow(/non-empty after trim|Empty selection/);
  });

  // -----------------------------------------------------------------------
  // Test 10: Duplicate proposal IDs are rejected
  // -----------------------------------------------------------------------
  it('duplicate proposal IDs are rejected', () => {
    const pid = seedEligibleItem(db);
    expect(() =>
      confirmExactProposals({ db, sessionId: SESSION_ID, proposalIds: [pid, pid] }),
    ).toThrow('duplicate proposal id');
  });

  // -----------------------------------------------------------------------
  // Test 11: Unknown proposal IDs are rejected
  // -----------------------------------------------------------------------
  it('unknown proposal IDs are rejected', () => {
    expect(() =>
      confirmExactProposals({ db, sessionId: SESSION_ID, proposalIds: ['unknown-id'] }),
    ).toThrow('unknown proposal id');
  });

  // -----------------------------------------------------------------------
  // Test 12: Empty selection is rejected unless explicit confirm-all is present
  // -----------------------------------------------------------------------
  it('empty selection is rejected for confirmExactProposals', () => {
    expect(() => confirmExactProposals({ db, sessionId: SESSION_ID, proposalIds: [] })).toThrow(
      'Empty selection',
    );
  });

  // -----------------------------------------------------------------------
  // Test 13: Explicit confirm-all confirms all eligible candidates
  // -----------------------------------------------------------------------
  it('confirm-all-eligible confirms all eligible candidates', () => {
    const pid1 = seedEligibleItem(db, { steamAppId: 101, backloggdSlug: 'game-101' });
    const pid2 = seedEligibleItem(db, { steamAppId: 102, backloggdSlug: 'game-102' });

    const result = confirmAllEligibleProposals({ db, sessionId: SESSION_ID });

    expect(result.confirmed).toHaveLength(2);
    const confirmedIds = result.confirmed.map((r) => r.proposalId).sort();
    expect(confirmedIds).toEqual([pid1, pid2].sort());

    const rows = db.prepare('SELECT COUNT(*) AS cnt FROM import_item_confirmations').get() as {
      cnt: number;
    };
    expect(rows.cnt).toBe(2);
  });

  // -----------------------------------------------------------------------
  // Test 14: Confirm-all does not confirm ineligible/stale/malformed candidates
  // -----------------------------------------------------------------------
  it('confirm-all does not confirm ineligible candidates', () => {
    // One eligible
    seedEligibleItem(db, { steamAppId: 101, backloggdSlug: 'game-101' });
    // One without absent proof (will be ineligible)
    const ineligibleId = seedImportItem(db, {
      steamAppId: 102,
      backloggdSlug: 'game-102',
      status: 'approved',
      proposalKind: 'ownership',
      frozenPayload: '{"platform":"steam","ownershipType":"digital"}',
      outcomeReason: null,
    });

    const plan = buildOwnershipSavePlan({ db, sessionId: SESSION_ID });
    expect(plan.candidates).toHaveLength(1);

    const result = confirmAllEligibleProposals({ db, sessionId: SESSION_ID });

    expect(result.confirmed).toHaveLength(1);
    // The ineligible item was never in the plan, so not in confirmed/rejected
    const ineligibleConfirmed = db
      .prepare('SELECT COUNT(*) AS cnt FROM import_item_confirmations WHERE proposal_id = ?')
      .get(ineligibleId) as { cnt: number };
    expect(ineligibleConfirmed.cnt).toBe(0);
  });

  // -----------------------------------------------------------------------
  // Test 15: Stale candidate rejection is surfaced distinctly
  // -----------------------------------------------------------------------
  it('stale candidate rejection is surfaced distinctly', () => {
    const pid = seedEligibleItem(db);
    // Build a plan while item is eligible
    const plan = buildOwnershipSavePlan({ db, sessionId: SESSION_ID });
    expect(plan.candidates).toHaveLength(1);

    // Change item status after plan built to make it stale
    db.prepare('UPDATE import_items SET status = ? WHERE proposal_id = ?').run('saved', pid);

    // Call applyOwnershipConfirmationSelection directly with the stale plan
    // to verify the revalidation surfaces the stale status distinctly.
    const result = applyOwnershipConfirmationSelection(db, plan, { byProposalIds: [pid] });

    expect(result.confirmed).toHaveLength(0);
    expect(result.rejected.length).toBeGreaterThan(0);
    expect(result.rejected[0].reason).toMatch(/import_item_status_saved/);
  });

  // -----------------------------------------------------------------------
  // Test 16: Idempotent reconfirmation remains safe
  // -----------------------------------------------------------------------
  it('idempotent reconfirmation remains safe', () => {
    const pid = seedEligibleItem(db);

    // First confirmation
    const result1 = confirmExactProposals({ db, sessionId: SESSION_ID, proposalIds: [pid] });
    expect(result1.confirmed).toHaveLength(1);

    // Second confirmation — should be idempotent
    const result2 = confirmExactProposals({ db, sessionId: SESSION_ID, proposalIds: [pid] });
    expect(result2.confirmed).toHaveLength(0);
    expect(result2.alreadyConfirmed).toContain(pid);

    // Only one row in the table
    const rows = db
      .prepare('SELECT COUNT(*) AS cnt FROM import_item_confirmations WHERE proposal_id = ?')
      .get(pid) as { cnt: number };
    expect(rows.cnt).toBe(1);
  });

  // -----------------------------------------------------------------------
  // Test 17: Confirming does not mutate import_items
  // -----------------------------------------------------------------------
  it('confirming does not mutate import_items', () => {
    const pid = seedEligibleItem(db);
    const before = getItem(db, pid);

    confirmExactProposals({ db, sessionId: SESSION_ID, proposalIds: [pid] });

    const after = getItem(db, pid);
    expect(after?.status).toBe(before?.status);
    expect(after?.outcomeReason).toBe(before?.outcomeReason);
    expect(after?.frozenPayload).toBe(before?.frozenPayload);
    expect(after?.attemptCount).toBe(before?.attemptCount);
  });

  // -----------------------------------------------------------------------
  // Test 18: Confirming does not mutate proposal rows
  // -----------------------------------------------------------------------
  it('confirming does not mutate proposal rows', () => {
    const pid = seedEligibleItem(db);
    const before = db.prepare('SELECT * FROM proposals WHERE id = ?').get(pid) as Record<
      string,
      unknown
    >;

    confirmExactProposals({ db, sessionId: SESSION_ID, proposalIds: [pid] });

    const after = db.prepare('SELECT * FROM proposals WHERE id = ?').get(pid) as Record<
      string,
      unknown
    >;
    expect(after).toEqual(before);
  });

  // -----------------------------------------------------------------------
  // Test 19: Status/playlog proposals are not confirmed
  // -----------------------------------------------------------------------
  it('status/playlog proposals are not included in plan', () => {
    // Seed a status proposal
    seedImportItem(db, {
      steamAppId: 201,
      proposalKind: 'status',
      backloggdSlug: 'game-201',
      status: 'approved',
      frozenPayload: null,
      outcomeReason: null,
    });
    // Seed a playlog proposal
    seedImportItem(db, {
      steamAppId: 202,
      proposalKind: 'playlog',
      backloggdSlug: 'game-202',
      status: 'approved',
      frozenPayload: null,
      outcomeReason: null,
    });

    const plan = buildOwnershipSavePlan({ db, sessionId: SESSION_ID });
    expect(plan.candidates).toHaveLength(0);
    expect(plan.counts.excludedUnsupportedKind).toBe(2);

    // Trying to confirm a status proposal directly would fail because it's not in the plan
    // (confirmExactProposals builds a fresh plan, so status proposals won't be in it)
    // We verify this by checking the plan counts and that no confirmation rows exist.
    const planCount = db.prepare('SELECT COUNT(*) AS cnt FROM import_item_confirmations').get() as {
      cnt: number;
    };
    expect(planCount.cnt).toBe(0);
  });

  // -----------------------------------------------------------------------
  // Test 20: Result output preserves proposal IDs and confirmation batch ID
  // -----------------------------------------------------------------------
  it('confirm result preserves proposal IDs and confirmation batch ID', () => {
    const pid1 = seedEligibleItem(db, { steamAppId: 301 });
    const pid2 = seedEligibleItem(db, { steamAppId: 302 });

    const result = confirmExactProposals({
      db,
      sessionId: SESSION_ID,
      proposalIds: [pid1, pid2],
    });

    expect(result.confirmed).toHaveLength(2);

    // All confirmed entries share the same batch ID
    const batchIds = result.confirmed.map((r) => r.confirmationBatchId);
    expect(batchIds[0]).toBeTruthy();
    expect(batchIds[1]).toBe(batchIds[0]);

    // Proposal IDs are preserved
    const confirmedIds = result.confirmed.map((r) => r.proposalId).sort();
    expect(confirmedIds).toEqual([pid1, pid2].sort());

    // Format output includes batch ID
    const output = formatConfirmResult(result);
    expect(output).toContain(pid1);
    expect(output).toContain(pid2);
    expect(output).toContain(batchIds[0]);
    expect(output).toContain('Confirmed');
  });

  // -----------------------------------------------------------------------
  // Test 21: Plan summary counts are surfaced
  // -----------------------------------------------------------------------
  it('plan summary counts are surfaced in format output', () => {
    seedEligibleItem(db, { steamAppId: 401 });
    // Add an ineligible item to generate exclusion counts
    seedImportItem(db, {
      steamAppId: 402,
      backloggdSlug: 'game-402',
      status: 'approved',
      proposalKind: 'ownership',
      frozenPayload: '{"platform":"steam","ownershipType":"digital"}',
      outcomeReason: null,
    });

    const { plan } = buildAndShowPlan({ db, sessionId: SESSION_ID });

    expect(plan.counts.eligibleCandidates).toBe(1);
    expect(plan.counts.excludedMissingOrInvalidAbsentProof).toBeGreaterThanOrEqual(1);

    const output = formatPlanOutput(plan);
    expect(output).toContain('Eligible candidates: 1');
    expect(output).toContain('Excluded missing or invalid absent proof');
    expect(output).toContain('Ownership save plan for session');
  });

  // -----------------------------------------------------------------------
  // Test 22: No browser/Playwright imports (verified statically)
  // -----------------------------------------------------------------------
  // Handled in static test file.

  // -----------------------------------------------------------------------
  // Test 23-25: Static import verification
  // -----------------------------------------------------------------------
  // Handled in static test file.

  // -----------------------------------------------------------------------
  // Additional: Format helpers work correctly
  // -----------------------------------------------------------------------
  it('formatCandidateLine produces expected output', () => {
    const pid = seedEligibleItem(db, {
      steamAppId: 501,
      gameTitle: 'Test Game',
      backloggdSlug: 'test-game',
    });
    const { plan } = buildAndShowPlan({ db, sessionId: SESSION_ID });
    const line = formatCandidateLine(plan.candidates[0], 1);
    expect(line).toContain(pid);
    expect(line).toContain('appid=501');
    expect(line).toContain('Test Game');
    expect(line).toContain('test-game');
    expect(line).toContain('steam');
    expect(line).toContain('digital');
    expect(line).toContain('eligibility=eligible');
  });

  it('formatCountsLines produces expected output', () => {
    seedEligibleItem(db);
    const { plan } = buildAndShowPlan({ db, sessionId: SESSION_ID });
    const lines = formatCountsLines(plan.counts);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.some((l) => l.includes('Eligible candidates'))).toBe(true);
    expect(lines.some((l) => l.includes('Excluded terminal'))).toBe(true);
  });

  it('formatConfirmedLine produces expected output', () => {
    const pid = seedEligibleItem(db, { steamAppId: 601, backloggdSlug: 'game-601' });
    const result = confirmExactProposals({ db, sessionId: SESSION_ID, proposalIds: [pid] });
    const line = formatConfirmedLine(result.confirmed[0]);
    expect(line).toContain(pid);
    expect(line).toContain('batch=');
    expect(line).toContain('steam');
    expect(line).toContain('digital');
    expect(line).toContain('game-601');
  });

  it('formatConfirmResult handles empty result', () => {
    const output = formatConfirmResult({ confirmed: [], alreadyConfirmed: [], rejected: [] });
    expect(output).toContain('No proposals processed.');
  });

  it('formatConfirmResult handles confirmed + already confirmed + rejected', () => {
    const output = formatConfirmResult({
      confirmed: [
        {
          proposalId: 'p1',
          importSessionId: 's1',
          steamAppId: 1,
          confirmationBatchId: 'batch-1',
          confirmedAt: '2026-01-01T00:00:00.000Z',
          plannedPlatform: 'steam',
          plannedOwnershipType: 'digital',
          plannedSlug: 'game-1',
          plannedAbsentCheckedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      alreadyConfirmed: ['p2'],
      rejected: [{ proposalId: 'p3', reason: 'stale' }],
    });
    expect(output).toContain('Confirmed');
    expect(output).toContain('Already confirmed');
    expect(output).toContain('Rejected');
    expect(output).toContain('p1');
    expect(output).toContain('p2');
    expect(output).toContain('p3');
  });

  // -----------------------------------------------------------------------
  // Additional: Empty plan output
  // -----------------------------------------------------------------------
  it('formatPlanOutput handles empty plan gracefully', () => {
    // No items seeded
    const { plan } = buildAndShowPlan({ db, sessionId: SESSION_ID });
    expect(plan.candidates).toHaveLength(0);

    const output = formatPlanOutput(plan);
    expect(output).toContain('No eligible candidates');
    expect(output).toContain('Eligible candidates: 0');
  });

  // -----------------------------------------------------------------------
  // Finding 3 — exit-code decision helper
  // -----------------------------------------------------------------------
  describe('computeConfirmExitCode', () => {
    it('returns true (failure) for empty result', () => {
      // Empty result means the call processed nothing — fail.
      expect(computeConfirmExitCode({ confirmed: [], alreadyConfirmed: [], rejected: [] })).toBe(
        true,
      );
    });

    it('returns false (success) when all selected proposals were confirmed', () => {
      const result = {
        confirmed: [
          {
            proposalId: 'p1',
            importSessionId: 's1',
            steamAppId: 1,
            confirmationBatchId: 'b1',
            confirmedAt: '2026-01-01T00:00:00.000Z',
            plannedPlatform: 'steam',
            plannedOwnershipType: 'digital',
            plannedSlug: 'game-1',
            plannedAbsentCheckedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        alreadyConfirmed: [],
        rejected: [],
      };
      expect(computeConfirmExitCode(result)).toBe(false);
    });

    it('returns false (success) when only already-confirmed proposals (idempotent)', () => {
      const result = { confirmed: [], alreadyConfirmed: ['p1', 'p2'], rejected: [] };
      expect(computeConfirmExitCode(result)).toBe(false);
    });

    it('Finding 3: returns true (failure) for mixed confirmed + rejected', () => {
      const result = {
        confirmed: [
          {
            proposalId: 'p1',
            importSessionId: 's1',
            steamAppId: 1,
            confirmationBatchId: 'b1',
            confirmedAt: '2026-01-01T00:00:00.000Z',
            plannedPlatform: 'steam',
            plannedOwnershipType: 'digital',
            plannedSlug: 'game-1',
            plannedAbsentCheckedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        alreadyConfirmed: [],
        rejected: [{ proposalId: 'p2', reason: 'import_item_status_saved' }],
      };
      expect(computeConfirmExitCode(result)).toBe(true);
    });

    it('Finding 3: returns true (failure) for mixed alreadyConfirmed + rejected', () => {
      const result = {
        confirmed: [],
        alreadyConfirmed: ['p1'],
        rejected: [{ proposalId: 'p2', reason: 'import_item_status_saved' }],
      };
      expect(computeConfirmExitCode(result)).toBe(true);
    });

    it('Finding 3: returns true (failure) when only rejected entries exist', () => {
      const result = {
        confirmed: [],
        alreadyConfirmed: [],
        rejected: [{ proposalId: 'p1', reason: 'import_item_status_saved' }],
      };
      expect(computeConfirmExitCode(result)).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Finding 3 — end-to-end: confirmExactProposals surfaces rejection in
  // both the ApplyResult and the formatConfirmResult output.
  // -----------------------------------------------------------------------
  it('Finding 3: stale candidate produces rejected entry with proposal ID and reason in output', () => {
    const pid = seedEligibleItem(db);
    const plan = buildOwnershipSavePlan({ db, sessionId: SESSION_ID });

    // Force the candidate to be stale after the plan was built.
    db.prepare('UPDATE import_items SET status = ? WHERE proposal_id = ?').run('saved', pid);

    const result = applyOwnershipConfirmationSelection(db, plan, { byProposalIds: [pid] });
    expect(result.rejected.length).toBe(1);
    expect(result.rejected[0].proposalId).toBe(pid);
    expect(result.rejected[0].reason).toMatch(/import_item_status_saved/);

    // Exit-code decision reflects the rejection.
    expect(computeConfirmExitCode(result)).toBe(true);

    // Formatted output includes the rejected proposal ID and reason.
    const output = formatConfirmResult(result);
    expect(output).toContain(pid);
    expect(output).toContain('Rejected');
    expect(output).toContain('import_item_status_saved');
  });

  it('Finding 3: mixed confirmed + rejected via confirmExactProposals fails exit decision', () => {
    const ok = seedEligibleItem(db, { steamAppId: 800, backloggdSlug: 'game-800' });
    const stale = seedEligibleItem(db, { steamAppId: 801, backloggdSlug: 'game-801' });

    const plan = buildOwnershipSavePlan({ db, sessionId: SESSION_ID });

    // Make the second one stale after plan was built.
    db.prepare('UPDATE import_items SET status = ? WHERE proposal_id = ?').run('saved', stale);

    const result = applyOwnershipConfirmationSelection(db, plan, {
      byProposalIds: [ok, stale],
    });

    expect(result.confirmed).toHaveLength(1);
    expect(result.confirmed[0].proposalId).toBe(ok);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].proposalId).toBe(stale);
    expect(result.rejected[0].reason).toMatch(/import_item_status_saved/);

    // Mixed confirmed + rejected must be a failure exit.
    expect(computeConfirmExitCode(result)).toBe(true);

    // Output preserves both confirmed and rejected entries.
    const output = formatConfirmResult(result);
    expect(output).toContain(ok);
    expect(output).toContain(stale);
    expect(output).toContain('Confirmed');
    expect(output).toContain('Rejected');

    // No confirmation row for the stale proposal.
    const staleRow = db
      .prepare('SELECT COUNT(*) AS cnt FROM import_item_confirmations WHERE proposal_id = ?')
      .get(stale) as { cnt: number };
    expect(staleRow.cnt).toBe(0);

    // Confirmation row exists for the valid proposal.
    const okRow = db
      .prepare('SELECT COUNT(*) AS cnt FROM import_item_confirmations WHERE proposal_id = ?')
      .get(ok) as { cnt: number };
    expect(okRow.cnt).toBe(1);
  });

  it('Finding 3: all-confirmed result remains successful', () => {
    const pid = seedEligibleItem(db);
    const result = confirmExactProposals({ db, sessionId: SESSION_ID, proposalIds: [pid] });
    expect(result.confirmed).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
    expect(computeConfirmExitCode(result)).toBe(false);
  });

  it('Finding 3: already-confirmed-only result remains successful (idempotent)', () => {
    const pid = seedEligibleItem(db);
    // First confirm.
    confirmExactProposals({ db, sessionId: SESSION_ID, proposalIds: [pid] });
    // Second confirm is idempotent.
    const result = confirmExactProposals({ db, sessionId: SESSION_ID, proposalIds: [pid] });
    expect(result.confirmed).toHaveLength(0);
    expect(result.alreadyConfirmed).toContain(pid);
    expect(result.rejected).toHaveLength(0);
    expect(computeConfirmExitCode(result)).toBe(false);
  });
});
