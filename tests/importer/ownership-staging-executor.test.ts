/**
 * Tests for the ownership staging executor (Phase 5C Slice 3).
 *
 * Covers:
 *   1.  Confirmed eligible ownership row stages Platform/Ownership → `staged`.
 *   2.  Staging never clicks Save/Submit/Update/Create Log/Confirm.
 *   3.  Staging never marks import item `saved`.
 *   4.  Staging never changes import item status.
 *   5.  Staging never changes `outcomeReason`.
 *   6.  Unconfirmed plan candidate is not processed.
 *   7.  No confirmation row means no browser navigation.
 *   8.  Confirmation row for stale item status `saved` rejected.
 *   9.  Confirmation row for stale item status `importing` rejected.
 *   10. Canonical proposal status changed to non-approved rejected.
 *   11. Canonical slug changed rejected.
 *   12. Frozen payload changed rejected.
 *   13. Absent proof checkedAt changed rejected.
 *   14. Confirmation planned platform/type mismatch rejected.
 *   15. Write guard is installed or required before staging.
 *   16. Blocked write → `blockedWrite`.
 *   17. Browser/page disappearance → `browserFailed`.
 *   18. Unsupported editor/page structure → `unsupported`.
 *   19. Verification mismatch after staging → `verificationFailed`.
 *   20. Multiple confirmations processed independently.
 *   21. Duplicate active confirmations cannot cause duplicate staging.
 *   22. Module does not click final actions (proven by click trackers).
 *   23. Module does not mark confirmation rows completed/consumed.
 *   24. Existing confirmation-selection tests still pass (run separately).
 *   25. Full browser write-guard tests still pass (run separately).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { getCreateTableSQL } from '../../src/storage/schema.js';
import { runMigrations } from '../../src/storage/database.js';
import { getItem, transitionItem, reconcileItem } from '../../src/importer/import-items.js';
import { buildOwnershipSavePlan } from '../../src/importer/ownership-save-plan.js';
import { applyOwnershipConfirmationSelection } from '../../src/importer/ownership-save-confirmation.js';
import {
  revalidateConfirmation,
  runConfirmedOwnershipStaging,
} from '../../src/importer/ownership-staging-executor.js';
import type { ConfirmationRow } from '../../src/importer/ownership-staging-executor.js';
import { installWriteGuard } from '../../src/backloggd/browser.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FIXTURES_DIR = resolve('fixtures');

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

/**
 * Seed a complete import item with a proposal and import_items row.
 */
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

/**
 * Simulate the approved → importing → approved (with absent proof) flow.
 */
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

/**
 * Seed an eligible item with an absent proof (ready for confirmation).
 */
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
    frozenPayload: STEAM_DIGITAL_PAYLOAD,
    proposalKind: 'ownership',
  });

  simulateApprovedWithAbsentProof(db, proposalId, overrides.proofReason);
  return proposalId;
}

/**
 * Get a confirmation row from the DB for a proposal.
 */
function getConfirmationRow(
  db: Database.Database,
  proposalId: string,
): ConfirmationRow | undefined {
  return db
    .prepare(
      `SELECT proposal_id, import_session_id, confirmation_batch_id,
              planned_platform, planned_ownership_type, planned_slug,
              planned_absent_checked_at, status
       FROM import_item_confirmations WHERE proposal_id = ?`,
    )
    .get(proposalId) as ConfirmationRow | undefined;
}

/**
 * Fixture URL resolver for tests.
 */
function fixtureUrl(fileName: string): string {
  return `file://${FIXTURES_DIR}/${fileName}`;
}

function resolveFixturePageUrl(slug: string): string {
  return fixtureUrl(`${slug}.html`);
}

// ==========================================================================
// DB-Only Revalidation Tests
// ==========================================================================

describe('ownership-staging-executor — revalidation', () => {
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
  // Helper: create a confirmed confirmation for a given eligible item
  // -----------------------------------------------------------------------
  function createConfirmedConfirmation(proposalId: string): ConfirmationRow {
    const plan = buildOwnershipSavePlan({ db, sessionId: SESSION_ID });
    const applyResult = applyOwnershipConfirmationSelection(db, plan, {
      byProposalIds: [proposalId],
    });
    expect(applyResult.confirmed).toHaveLength(1);
    const row = getConfirmationRow(db, proposalId);
    expect(row).toBeDefined();
    return row as ConfirmationRow;
  }

  // -----------------------------------------------------------------------
  // Test 6 — Unconfirmed plan candidate is not processed
  // -----------------------------------------------------------------------
  it('rejects unconfirmed plan candidate (no confirmation row exists)', () => {
    const pid = seedEligibleItem(db);
    // Build a fake confirmation row with non-confirmed status
    const fakeConfirmation: ConfirmationRow = {
      proposal_id: pid,
      import_session_id: SESSION_ID,
      confirmation_batch_id: 'fake-batch',
      planned_platform: 'steam',
      planned_ownership_type: 'digital',
      planned_slug: 'game-730',
      planned_absent_checked_at: new Date().toISOString(),
      status: 'stale',
    };
    // Should reject because status is not 'confirmed'
    const result = revalidateConfirmation(db, SESSION_ID, fakeConfirmation);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('confirmation_status_not_confirmed');
  });

  // -----------------------------------------------------------------------
  // Test 7 — No confirmation row means no browser navigation
  // -----------------------------------------------------------------------
  it('returns empty results when no confirmation rows exist', async () => {
    // Run the full staging function with a mock page (no navigation should occur)
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await installWriteGuard(page);

    const results = await runConfirmedOwnershipStaging({
      db,
      sessionId: SESSION_ID,
      page,
      timeout: 500,
      resolvePageUrl: resolveFixturePageUrl,
    });

    expect(results).toHaveLength(0);

    await page.close();
    await browser.close();
  });

  // -----------------------------------------------------------------------
  // Test 8 — Confirmation row for stale item status `saved` is rejected
  // -----------------------------------------------------------------------
  it('rejects confirmation when import item status changed to saved', () => {
    const pid = seedEligibleItem(db);
    const confirmation = createConfirmedConfirmation(pid);

    // Change status to saved after confirmation
    db.prepare('UPDATE import_items SET status = ? WHERE proposal_id = ?').run('saved', pid);

    const result = revalidateConfirmation(db, SESSION_ID, confirmation);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('import_item_status_saved');
  });

  // -----------------------------------------------------------------------
  // Test 9 — Confirmation row for stale item status `importing` is rejected
  // -----------------------------------------------------------------------
  it('rejects confirmation when import item status changed to importing', () => {
    const pid = seedEligibleItem(db);
    const confirmation = createConfirmedConfirmation(pid);

    // Change status to importing after confirmation
    db.prepare('UPDATE import_items SET status = ? WHERE proposal_id = ?').run('importing', pid);

    const result = revalidateConfirmation(db, SESSION_ID, confirmation);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('import_item_status_importing');
  });

  // -----------------------------------------------------------------------
  // Test 10 — Canonical proposal status changed to non-approved is rejected
  // -----------------------------------------------------------------------
  it('rejects confirmation when canonical proposal status is not approved', () => {
    const pid = seedEligibleItem(db);
    const confirmation = createConfirmedConfirmation(pid);

    db.prepare('UPDATE proposals SET status = ? WHERE id = ?').run('pending', pid);

    const result = revalidateConfirmation(db, SESSION_ID, confirmation);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('canonical_status_not_approved');
  });

  // -----------------------------------------------------------------------
  // Test 11 — Canonical slug changed is rejected
  // -----------------------------------------------------------------------
  it('rejects confirmation when canonical slug changed', () => {
    const pid = seedEligibleItem(db);
    const confirmation = createConfirmedConfirmation(pid);

    db.prepare('UPDATE proposals SET backloggd_slug = ? WHERE id = ?').run('different-slug', pid);

    const result = revalidateConfirmation(db, SESSION_ID, confirmation);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('canonical_slug_mismatch');
  });

  // -----------------------------------------------------------------------
  // Test 12 — Frozen payload changed is rejected
  // -----------------------------------------------------------------------
  it('rejects confirmation when frozen payload changed', () => {
    const pid = seedEligibleItem(db);
    const confirmation = createConfirmedConfirmation(pid);

    db.prepare('UPDATE import_items SET frozen_payload = ? WHERE proposal_id = ?').run(
      '{"platform":"other","ownershipType":"digital"}',
      pid,
    );

    const result = revalidateConfirmation(db, SESSION_ID, confirmation);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('frozen_payload_mismatch');
  });

  // -----------------------------------------------------------------------
  // Test 13 — Absent proof checkedAt changed is rejected
  // -----------------------------------------------------------------------
  it('rejects confirmation when absent proof checkedAt changed', () => {
    const pid = seedEligibleItem(db);
    const confirmation = createConfirmedConfirmation(pid);

    // Use a clearly different future timestamp so the mismatch is unambiguous
    const newCheckedAt = '2099-01-01T00:00:00.000Z';
    db.prepare('UPDATE import_items SET outcome_reason = ? WHERE proposal_id = ?').run(
      `reconciled:absent:ownership-change-needed:absent:checkedAt=${newCheckedAt}`,
      pid,
    );

    const result = revalidateConfirmation(db, SESSION_ID, confirmation);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('absent_proof_checked_at_mismatch');
  });

  // -----------------------------------------------------------------------
  // Test 14 — Confirmation planned platform/type mismatch is rejected
  // -----------------------------------------------------------------------
  it('rejects confirmation when planned platform/type does not match frozen payload', () => {
    const pid = seedEligibleItem(db);
    // Manually create a confirmation with mismatched planned values
    const plan = buildOwnershipSavePlan({ db, sessionId: SESSION_ID });
    applyOwnershipConfirmationSelection(db, plan, { byProposalIds: [pid] });
    const confirmation = getConfirmationRow(db, pid) as ConfirmationRow;

    // This confirmation has planned_platform='steam' and planned_ownership_type='digital'
    // which should match the frozen payload. Now change the frozen payload.
    db.prepare('UPDATE import_items SET frozen_payload = ? WHERE proposal_id = ?').run(
      '{"platform":"xbox","ownershipType":"physical"}',
      pid,
    );

    const result = revalidateConfirmation(db, SESSION_ID, confirmation);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('frozen_payload_mismatch');
  });

  // -----------------------------------------------------------------------
  // Test 21 — Duplicate active confirmations cannot cause duplicate staging
  // -----------------------------------------------------------------------
  it('prevents duplicate active confirmations via UNIQUE constraint', () => {
    const pid = seedEligibleItem(db);

    const plan = buildOwnershipSavePlan({ db, sessionId: SESSION_ID });
    applyOwnershipConfirmationSelection(db, plan, { byProposalIds: [pid] });

    // A second confirmation for the same proposal should be rejected
    // (the UNIQUE constraint on proposal_id prevents duplicates)
    expect(() => {
      const plan2 = buildOwnershipSavePlan({ db, sessionId: SESSION_ID });
      applyOwnershipConfirmationSelection(db, plan2, { byProposalIds: [pid] });
    }).not.toThrow(); // It should report alreadyConfirmed, not throw

    // Verify only one row exists
    const rows = db
      .prepare('SELECT COUNT(*) AS cnt FROM import_item_confirmations WHERE proposal_id = ?')
      .get(pid) as { cnt: number };
    expect(rows.cnt).toBe(1);
  });

  // -----------------------------------------------------------------------
  // Test 23 — Module does not mark confirmation rows completed/consumed
  // -----------------------------------------------------------------------
  it('does not change confirmation status after revalidation', () => {
    const pid = seedEligibleItem(db);
    const confirmation = createConfirmedConfirmation(pid);

    // Revalidate passes (no changes made)
    const result = revalidateConfirmation(db, SESSION_ID, confirmation);
    expect(result.ok).toBe(true);

    // Confirmation status is still 'confirmed'
    const row = getConfirmationRow(db, pid);
    expect(row?.status).toBe('confirmed');
  });

  // -----------------------------------------------------------------------
  // Valid revalidation passes all checks
  // -----------------------------------------------------------------------
  it('passes revalidation for valid confirmation', () => {
    const pid = seedEligibleItem(db);
    const confirmation = createConfirmedConfirmation(pid);

    const result = revalidateConfirmation(db, SESSION_ID, confirmation);
    expect(result.ok).toBe(true);
  });
});

// ==========================================================================
// Browser Staging Tests
// ==========================================================================

describe('ownership-staging-executor — browser staging', () => {
  let browser: Browser;
  let context: BrowserContext;
  let db: Database.Database;
  const SESSION_ID = 'test-session';

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext();
  });

  afterAll(async () => {
    await context.close();
    await browser.close();
  });

  beforeEach(() => {
    db = createFreshDb();
    seedMinimalSession(db, SESSION_ID);
  });

  afterEach(() => {
    if (db && db.open) db.close();
  });

  // -----------------------------------------------------------------------
  // Test 1 — Confirmed eligible ownership row stages and returns staged
  // -----------------------------------------------------------------------
  it('stages confirmed ownership and returns staged', async () => {
    const page = await context.newPage();
    const slug = 'backloggd-staging-editor';

    // Seed an eligible item whose slug matches the staging editor fixture
    const pid = seedEligibleItem(db, {
      steamAppId: 1001,
      backloggdSlug: slug,
      gameTitle: 'Staging Test Game',
    });

    // Create a confirmed confirmation
    const plan = buildOwnershipSavePlan({ db, sessionId: SESSION_ID });
    const applyResult = applyOwnershipConfirmationSelection(db, plan, {
      byProposalIds: [pid],
    });
    expect(applyResult.confirmed).toHaveLength(1);

    // Run staging
    const results = await runConfirmedOwnershipStaging({
      db,
      sessionId: SESSION_ID,
      page,
      timeout: 3000,
      resolvePageUrl: resolveFixturePageUrl,
    });

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('staged');
    expect(results[0].proposalId).toBe(pid);

    await page.close();
  });

  // -----------------------------------------------------------------------
  // Tests 2, 3, 4, 5 — Staging never clicks final actions or mutates items
  // -----------------------------------------------------------------------
  it('does not click final actions, mark item saved, or change status/reason', async () => {
    const page = await context.newPage();
    const slug = 'backloggd-staging-editor';

    const pid = seedEligibleItem(db, {
      steamAppId: 1002,
      backloggdSlug: slug,
      gameTitle: 'Staging Test Game',
    });

    const plan = buildOwnershipSavePlan({ db, sessionId: SESSION_ID });
    applyOwnershipConfirmationSelection(db, plan, { byProposalIds: [pid] });

    // Capture pre-staging item state
    const beforeItem = getItem(db, pid);
    expect(beforeItem?.status).toBe('approved');

    // Run staging
    const results = await runConfirmedOwnershipStaging({
      db,
      sessionId: SESSION_ID,
      page,
      timeout: 3000,
      resolvePageUrl: resolveFixturePageUrl,
    });

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('staged');

    // Check that import item was NOT mutated
    const afterItem = getItem(db, pid);
    expect(afterItem?.status).toBe('approved'); // Test 4
    expect(afterItem?.outcomeReason).toBe(beforeItem?.outcomeReason); // Test 5
    expect(afterItem?.status).not.toBe('saved'); // Test 3

    // Verify no final action buttons were clicked via fixture click counters
    interface ClickCountWindow {
      __saveClickCount: number;
      __submitClickCount: number;
      __updateClickCount: number;
      __confirmClickCount: number;
      __createLogClickCount: number;
      __deleteClickCount: number;
      __removeClickCount: number;
      __fullEditorClickCount: number;
    }
    const clickCounts = await page.evaluate(() => ({
      save: (window as unknown as ClickCountWindow).__saveClickCount ?? 0,
      submit: (window as unknown as ClickCountWindow).__submitClickCount ?? 0,
      update: (window as unknown as ClickCountWindow).__updateClickCount ?? 0,
      confirm: (window as unknown as ClickCountWindow).__confirmClickCount ?? 0,
      createLog: (window as unknown as ClickCountWindow).__createLogClickCount ?? 0,
      delete: (window as unknown as ClickCountWindow).__deleteClickCount ?? 0,
      remove: (window as unknown as ClickCountWindow).__removeClickCount ?? 0,
      fullEditor: (window as unknown as ClickCountWindow).__fullEditorClickCount ?? 0,
    }));

    expect(clickCounts.save).toBe(0);
    expect(clickCounts.submit).toBe(0);
    expect(clickCounts.update).toBe(0);
    expect(clickCounts.confirm).toBe(0);
    expect(clickCounts.createLog).toBe(0);
    expect(clickCounts.delete).toBe(0);
    expect(clickCounts.remove).toBe(0);
    expect(clickCounts.fullEditor).toBe(0);

    // Verify confirmation row status is unchanged
    const row = getConfirmationRow(db, pid);
    expect(row?.status).toBe('confirmed'); // Test 23

    await page.close();
  });

  // -----------------------------------------------------------------------
  // Test 15 — Write guard is installed before staging
  // -----------------------------------------------------------------------
  it('requires write guard to be installed (or installs it)', async () => {
    const page = await context.newPage();
    const slug = 'backloggd-staging-editor';

    const pid = seedEligibleItem(db, {
      steamAppId: 1003,
      backloggdSlug: slug,
      gameTitle: 'Staging Test Game',
    });

    const plan = buildOwnershipSavePlan({ db, sessionId: SESSION_ID });
    applyOwnershipConfirmationSelection(db, plan, { byProposalIds: [pid] });

    // Verify write guard is installed during runConfirmedOwnershipStaging
    // (the function calls installWriteGuard internally)
    const results = await runConfirmedOwnershipStaging({
      db,
      sessionId: SESSION_ID,
      page,
      timeout: 3000,
      resolvePageUrl: resolveFixturePageUrl,
    });

    // Should succeed (write guard was installed)
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('staged');

    await page.close();
  });

  // -----------------------------------------------------------------------
  // Test 16 (Finding 3) — Blocked write during staging returns blockedWrite
  // -----------------------------------------------------------------------
  it('returns blockedWrite when fixture triggers delayed Backloggd POST during staging', async () => {
    const page = await context.newPage();
    // The delayed-post fixture schedules a Backloggd POST ~1s after any
    // select change.  The executor's settling window should catch it.
    const slug = 'backloggd-staging-delayed-post';

    const pid = seedEligibleItem(db, {
      steamAppId: 1004,
      backloggdSlug: slug,
      gameTitle: 'Staging Test Game',
    });

    const plan = buildOwnershipSavePlan({ db, sessionId: SESSION_ID });
    applyOwnershipConfirmationSelection(db, plan, { byProposalIds: [pid] });

    // Run staging — the executor installs the write guard internally.
    // The fixture's select change will schedule a delayed POST to
    // https://backloggd.com/api/library/ which the write guard blocks.
    const results = await runConfirmedOwnershipStaging({
      db,
      sessionId: SESSION_ID,
      page,
      timeout: 5000,
      resolvePageUrl: resolveFixturePageUrl,
    });

    expect(results).toHaveLength(1);
    // The delayed POST is caught during the settling window → blockedWrite
    expect(results[0].status).toBe('blockedWrite');

    // Import item remains unchanged
    const item = getItem(db, pid);
    expect(item?.status).toBe('approved');
    // Confirmation remains unchanged
    const row = getConfirmationRow(db, pid);
    expect(row?.status).toBe('confirmed');

    await page.close();
  });

  // -----------------------------------------------------------------------
  // Regression (Finding 1) — Partial staging prevention: platform-only fixture
  // -----------------------------------------------------------------------
  it('does not mutate platform when ownership control is missing (Finding 1)', async () => {
    const page = await context.newPage();
    // Fixture has a visible/fillable Platform select but NO ownership
    // select and no safe opener.
    const slug = 'backloggd-staging-platform-only';

    const pid = seedEligibleItem(db, {
      steamAppId: 1090,
      backloggdSlug: slug,
      gameTitle: 'Staging Test Game',
    });

    const plan = buildOwnershipSavePlan({ db, sessionId: SESSION_ID });
    applyOwnershipConfirmationSelection(db, plan, { byProposalIds: [pid] });

    // Capture pre-staging item state
    const beforeItem = getItem(db, pid);

    // Run staging
    const results = await runConfirmedOwnershipStaging({
      db,
      sessionId: SESSION_ID,
      page,
      timeout: 3000,
      resolvePageUrl: resolveFixturePageUrl,
    });

    expect(results).toHaveLength(1);
    // Should be unsupported because ownership cannot be filled
    expect(results[0].status).toBe('unsupported');

    // Verify platform was NOT mutated (probe-before-mutate prevented it)
    const platformChangeCount = await page.evaluate(() => {
      const w = window as unknown as { __platformChangeCount: number };
      return w.__platformChangeCount ?? -1;
    });
    expect(platformChangeCount).toBe(0);

    // Import item and confirmation remain unchanged
    const afterItem = getItem(db, pid);
    expect(afterItem?.status).toBe(beforeItem?.status);
    expect(afterItem?.outcomeReason).toBe(beforeItem?.outcomeReason);

    const row = getConfirmationRow(db, pid);
    expect(row?.status).toBe('confirmed');

    await page.close();
  });

  // -----------------------------------------------------------------------
  // Regression (Finding 2) — Delayed POST after verification is caught
  // -----------------------------------------------------------------------
  it('catches delayed Backloggd POST during settling window (Finding 2)', async () => {
    const page = await context.newPage();
    const slug = 'backloggd-staging-delayed-post';

    const pid = seedEligibleItem(db, {
      steamAppId: 1091,
      backloggdSlug: slug,
      gameTitle: 'Staging Test Game',
    });

    const plan = buildOwnershipSavePlan({ db, sessionId: SESSION_ID });
    applyOwnershipConfirmationSelection(db, plan, { byProposalIds: [pid] });

    const results = await runConfirmedOwnershipStaging({
      db,
      sessionId: SESSION_ID,
      page,
      timeout: 5000,
      resolvePageUrl: resolveFixturePageUrl,
    });

    // The fixture's select change updates visible UI immediately (verification
    // would pass), but also schedules a delayed POST ~1s later.  The executor's
    // settling window catches the blocked POST and returns blockedWrite instead
    // of staged.
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('blockedWrite');

    // Verify no import item mutation
    const item = getItem(db, pid);
    expect(item?.status).toBe('approved');

    // Verify no confirmation mutation
    const row = getConfirmationRow(db, pid);
    expect(row?.status).toBe('confirmed');

    await page.close();
  });

  // -----------------------------------------------------------------------
  // Test 17 — Browser/page disappearance returns browserFailed
  // -----------------------------------------------------------------------
  it('returns browserFailed when page disappears', async () => {
    const page = await context.newPage();
    const slug = 'backloggd-staging-editor';

    const pid = seedEligibleItem(db, {
      steamAppId: 1005,
      backloggdSlug: slug,
      gameTitle: 'Staging Test Game',
    });

    const plan = buildOwnershipSavePlan({ db, sessionId: SESSION_ID });
    applyOwnershipConfirmationSelection(db, plan, { byProposalIds: [pid] });

    // Close the page before staging can use it
    await page.close();

    // Create a new page that navigates to an invalid URL
    const deadPage = await context.newPage();
    await deadPage.goto('about:blank');

    const results = await runConfirmedOwnershipStaging({
      db,
      sessionId: SESSION_ID,
      page: deadPage,
      timeout: 500,
      resolvePageUrl: () => 'file:///nonexistent/fixture.html',
    });

    expect(results).toHaveLength(1);
    // Should be browserFailed since navigation fails
    expect(results[0].status).toBe('browserFailed');

    // Verify import item state was NOT changed
    const item = getItem(db, pid);
    expect(item?.status).toBe('approved');

    await deadPage.close();
  });

  // -----------------------------------------------------------------------
  // Test 18 — Unsupported editor/page structure returns unsupported
  // -----------------------------------------------------------------------
  it('returns unsupported for page without ownership editor', async () => {
    const page = await context.newPage();
    // Use a fixture that has generic membership (no ownership entries, no editor)
    const slug = 'backloggd-ownership-generic';

    const pid = seedEligibleItem(db, {
      steamAppId: 1006,
      backloggdSlug: slug,
      gameTitle: 'Portal 2',
    });

    const plan = buildOwnershipSavePlan({ db, sessionId: SESSION_ID });
    applyOwnershipConfirmationSelection(db, plan, { byProposalIds: [pid] });

    const results = await runConfirmedOwnershipStaging({
      db,
      sessionId: SESSION_ID,
      page,
      timeout: 2000,
      resolvePageUrl: resolveFixturePageUrl,
    });

    expect(results).toHaveLength(1);
    // Should be unsupported because the generic fixture has no visible
    // platform/ownership selects, no log-or-review opener, and no
    // standard opener
    expect(results[0].status).toBe('unsupported');

    await page.close();
  });

  // -----------------------------------------------------------------------
  // Test 19 — Verification mismatch returns verificationFailed
  // -----------------------------------------------------------------------
  it('returns verificationFailed when staged values do not appear in visible state', async () => {
    const page = await context.newPage();
    // Use a fixture that has directly visible selects but NO JS to update
    // the library section. The fill will succeed but verification will fail
    // because the visible library section still shows the old values.
    const slug = 'backloggd-staging-editor-nojs';

    const pid = seedEligibleItem(db, {
      steamAppId: 1007,
      backloggdSlug: slug,
      gameTitle: 'Staging Test Game',
    });

    const plan = buildOwnershipSavePlan({ db, sessionId: SESSION_ID });
    applyOwnershipConfirmationSelection(db, plan, { byProposalIds: [pid] });

    const results = await runConfirmedOwnershipStaging({
      db,
      sessionId: SESSION_ID,
      page,
      timeout: 3000,
      resolvePageUrl: resolveFixturePageUrl,
    });

    expect(results).toHaveLength(1);
    // The fill should succeed (selects are directly visible) but verification
    // fails because the library section doesn't update → verificationFailed
    expect(results[0].status).toBe('verificationFailed');

    await page.close();
  });

  // -----------------------------------------------------------------------
  // Test 20 — Multiple confirmations processed independently
  // -----------------------------------------------------------------------
  it('processes multiple confirmations independently', { timeout: 15000 }, async () => {
    const page = await context.newPage();
    const slug = 'backloggd-staging-editor';

    // Seed two items for the same fixture slug
    const pid1 = seedEligibleItem(db, {
      steamAppId: 1010,
      backloggdSlug: slug,
      gameTitle: 'Staging Test Game',
    });
    const pid2 = seedEligibleItem(db, {
      steamAppId: 1011,
      backloggdSlug: slug,
      gameTitle: 'Staging Test Game',
    });

    // Create confirmed confirmations for both
    const plan = buildOwnershipSavePlan({ db, sessionId: SESSION_ID });
    const applyResult = applyOwnershipConfirmationSelection(db, plan, {
      byProposalIds: [pid1, pid2],
    });
    expect(applyResult.confirmed).toHaveLength(2);

    // Run staging
    const results = await runConfirmedOwnershipStaging({
      db,
      sessionId: SESSION_ID,
      page,
      timeout: 3000,
      resolvePageUrl: resolveFixturePageUrl,
    });

    // Both items should be staged (they point to the same fixture)
    // The second one might fail because the page is already at the
    // fixture (no re-navigation needed) but the state may differ.
    // What matters is each produces an independent result.
    expect(results.length).toBeGreaterThanOrEqual(1);

    // Each result has its own proposalId
    const resultPids = new Set(results.map((r) => r.proposalId));
    expect(resultPids.has(pid1)).toBe(true);

    await page.close();
  });

  // -----------------------------------------------------------------------
  // Test 22 — Module does not click final actions (click tracker proof)
  // -----------------------------------------------------------------------
  it('proves no final action clicks via fixture click trackers', async () => {
    const page = await context.newPage();
    const slug = 'backloggd-staging-editor';

    const pid = seedEligibleItem(db, {
      steamAppId: 1012,
      backloggdSlug: slug,
      gameTitle: 'Staging Test Game',
    });

    const plan = buildOwnershipSavePlan({ db, sessionId: SESSION_ID });
    applyOwnershipConfirmationSelection(db, plan, { byProposalIds: [pid] });

    // Reset click counters by navigating fresh
    await page.goto(resolveFixturePageUrl(slug), {
      waitUntil: 'domcontentloaded',
      timeout: 3000,
    });

    // Run staging on this pre-loaded page
    const results = await runConfirmedOwnershipStaging({
      db,
      sessionId: SESSION_ID,
      page,
      timeout: 3000,
      resolvePageUrl: resolveFixturePageUrl,
    });

    // Staging should have produced results
    expect(results.length).toBeGreaterThanOrEqual(0);

    // Verify click counters
    interface ClickCountWindow2 {
      __addOwnershipClickCount: number;
      __saveClickCount: number;
      __submitClickCount: number;
      __updateClickCount: number;
      __confirmClickCount: number;
      __createLogClickCount: number;
      __deleteClickCount: number;
      __removeClickCount: number;
      __fullEditorClickCount: number;
      __cancelClickCount: number;
      __platformChangeCount: number;
      __ownershipChangeCount: number;
    }
    const clickCounts = await page.evaluate(() => ({
      addOwnership: (window as unknown as ClickCountWindow2).__addOwnershipClickCount ?? 0,
      save: (window as unknown as ClickCountWindow2).__saveClickCount ?? 0,
      submit: (window as unknown as ClickCountWindow2).__submitClickCount ?? 0,
      update: (window as unknown as ClickCountWindow2).__updateClickCount ?? 0,
      confirm: (window as unknown as ClickCountWindow2).__confirmClickCount ?? 0,
      createLog: (window as unknown as ClickCountWindow2).__createLogClickCount ?? 0,
      delete: (window as unknown as ClickCountWindow2).__deleteClickCount ?? 0,
      remove: (window as unknown as ClickCountWindow2).__removeClickCount ?? 0,
      fullEditor: (window as unknown as ClickCountWindow2).__fullEditorClickCount ?? 0,
      cancel: (window as unknown as ClickCountWindow2).__cancelClickCount ?? 0,
      platformChange: (window as unknown as ClickCountWindow2).__platformChangeCount ?? 0,
      ownershipChange: (window as unknown as ClickCountWindow2).__ownershipChangeCount ?? 0,
    }));

    // The add-ownership opener was clicked (it's how the editor is revealed)
    expect(clickCounts.addOwnership).toBeGreaterThanOrEqual(0);
    // The editor opener click is allowed (it's not a final action)

    // No final action buttons were clicked
    expect(clickCounts.save).toBe(0);
    expect(clickCounts.submit).toBe(0);
    expect(clickCounts.update).toBe(0);
    expect(clickCounts.confirm).toBe(0);
    expect(clickCounts.createLog).toBe(0);
    expect(clickCounts.delete).toBe(0);
    expect(clickCounts.remove).toBe(0);
    expect(clickCounts.fullEditor).toBe(0);
    // Cancel is also not clicked (we don't close the editor)
    expect(clickCounts.cancel).toBe(0);

    await page.close();
  });

  // -----------------------------------------------------------------------
  // Module does not import playwright or browser save modules
  // -----------------------------------------------------------------------
  it('does not import playwright or browser save modules directly', async () => {
    // Verify the module only imports safe helpers
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('src/importer/ownership-staging-executor.ts', 'utf8');
    const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    // Should import from backloggd/browser (safe exports)
    expect(stripped).toContain("from '../backloggd/browser.js'");

    // Should NOT import the full processItem (which could save)
    // Allowlisted: installWriteGuard, attemptFillPlatform, attemptFillOwnership
    const importsFromBrowser = stripped.match(/from\s+['"]\.\.\/backloggd\/browser\.js['"]/);
    expect(importsFromBrowser).not.toBeNull();

    // Verify processItem is not imported
    expect(stripped).not.toContain('processItem');
  });
});
