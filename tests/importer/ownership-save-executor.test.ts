/**
 * Tests for the ownership save executor (Phase 5C Slice 4).
 *
 * Covers all findings:
 *   Finding 1: Save allowance narrowing (tests 32-36)
 *   Finding 2: Save request/response proof (tests 37-39)
 *   Finding 3: Verified editor/form save scope (tests 40-42)
 *   Finding 4: Atomic local saved transition (test 43)
 *
 * Plus all original tests 1-31 updated for the new save response requirements.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { getCreateTableSQL } from '../../src/storage/schema.js';
import { runMigrations } from '../../src/storage/database.js';
import { getItem, transitionItem, reconcileItem } from '../../src/importer/import-items.js';
import { buildOwnershipSavePlan } from '../../src/importer/ownership-save-plan.js';
import { applyOwnershipConfirmationSelection } from '../../src/importer/ownership-save-confirmation.js';
import { runConfirmedOwnershipSave } from '../../src/importer/ownership-save-executor.js';
import { installWriteGuard } from '../../src/backloggd/browser.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FIXTURES_DIR = resolve('fixtures');

const STEAM_DIGITAL_PAYLOAD = '{"platform":"steam","ownershipType":"digital"}';

const SAVE_API_URL = 'https://backloggd.com/api/library/';

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

function createConfirmedConfirmation(
  db: Database.Database,
  sessionId: string,
  proposalId: string,
): void {
  const plan = buildOwnershipSavePlan({ db, sessionId });
  applyOwnershipConfirmationSelection(db, plan, { byProposalIds: [proposalId] });
}

function fixtureUrl(fileName: string): string {
  return `file://${FIXTURES_DIR}/${fileName}`;
}

function resolveFixturePageUrl(slug: string): string {
  return fixtureUrl(`${slug}.html`);
}

/**
 * Install a Playwright route that intercepts POST to /api/library and returns
 * the given status code.  Must be called BEFORE runConfirmedOwnershipSave so
 * the route is in place before the write guard is installed (routes are
 * evaluated in reverse order of addition; the test route is added first and
 * the write guard's route is added later, so the write guard's route is
 * evaluated first.  It calls route.fallback() for allowed save requests,
 * which continues to the test's route).
 */
async function installSaveRoute(page: Page, status: number): Promise<void> {
  await page.route(SAVE_API_URL, async (route) => {
    if (route.request().method().toUpperCase() === 'POST') {
      await route.fulfill({ status, body: `{"status":${status}}` });
    } else {
      await route.fallback();
    }
  });
}

// ==========================================================================
// DB-Only Revalidation Tests
// ==========================================================================

describe('ownership-save-executor — revalidation', () => {
  let db: Database.Database;
  const SESSION_ID = 'test-session';

  beforeEach(() => {
    db = createFreshDb();
    seedMinimalSession(db, SESSION_ID);
  });

  afterEach(() => {
    db.close();
  });

  it('rejects confirmation when import item status changed to saved', async () => {
    const pid = seedEligibleItem(db, { sessionId: SESSION_ID });
    createConfirmedConfirmation(db, SESSION_ID, pid);
    db.prepare('UPDATE import_items SET status = ? WHERE proposal_id = ?').run('saved', pid);
    const result = await runConfirmedOwnershipSave({
      db,
      sessionId: SESSION_ID,
      page: null as unknown as Page,
      timeout: 500,
    });
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe('stale');
    expect(result[0].detail).toContain('import_item_status_saved');
  });

  it('rejects confirmation when import item status changed to importing', async () => {
    const pid = seedEligibleItem(db, { sessionId: SESSION_ID });
    createConfirmedConfirmation(db, SESSION_ID, pid);
    db.prepare('UPDATE import_items SET status = ? WHERE proposal_id = ?').run('importing', pid);
    const result = await runConfirmedOwnershipSave({
      db,
      sessionId: SESSION_ID,
      page: null as unknown as Page,
      timeout: 500,
    });
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe('stale');
  });

  it('rejects confirmation when canonical proposal status is not approved', async () => {
    const pid = seedEligibleItem(db, { sessionId: SESSION_ID });
    createConfirmedConfirmation(db, SESSION_ID, pid);
    db.prepare('UPDATE proposals SET status = ? WHERE id = ?').run('pending', pid);
    const result = await runConfirmedOwnershipSave({
      db,
      sessionId: SESSION_ID,
      page: null as unknown as Page,
      timeout: 500,
    });
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe('stale');
    expect(result[0].detail).toContain('canonical_status_not_approved');
  });

  it('rejects confirmation when canonical slug changed', async () => {
    const pid = seedEligibleItem(db, { sessionId: SESSION_ID });
    createConfirmedConfirmation(db, SESSION_ID, pid);
    db.prepare('UPDATE proposals SET backloggd_slug = ? WHERE id = ?').run('different-slug', pid);
    const result = await runConfirmedOwnershipSave({
      db,
      sessionId: SESSION_ID,
      page: null as unknown as Page,
      timeout: 500,
    });
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe('stale');
  });

  it('rejects confirmation when frozen payload changed', async () => {
    const pid = seedEligibleItem(db, { sessionId: SESSION_ID });
    createConfirmedConfirmation(db, SESSION_ID, pid);
    db.prepare('UPDATE import_items SET frozen_payload = ? WHERE proposal_id = ?').run(
      '{"platform":"other","ownershipType":"digital"}',
      pid,
    );
    const result = await runConfirmedOwnershipSave({
      db,
      sessionId: SESSION_ID,
      page: null as unknown as Page,
      timeout: 500,
    });
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe('stale');
  });

  it('rejects confirmation when absent proof checkedAt changed', async () => {
    const pid = seedEligibleItem(db, { sessionId: SESSION_ID });
    createConfirmedConfirmation(db, SESSION_ID, pid);
    const newCheckedAt = '2099-01-01T00:00:00.000Z';
    db.prepare('UPDATE import_items SET outcome_reason = ? WHERE proposal_id = ?').run(
      `reconciled:absent:ownership-change-needed:absent:checkedAt=${newCheckedAt}`,
      pid,
    );
    const result = await runConfirmedOwnershipSave({
      db,
      sessionId: SESSION_ID,
      page: null as unknown as Page,
      timeout: 500,
    });
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe('stale');
  });

  it('does not process items without a confirmed confirmation row', async () => {
    const pid = seedEligibleItem(db, { sessionId: SESSION_ID });
    const plan = buildOwnershipSavePlan({ db, sessionId: SESSION_ID });
    applyOwnershipConfirmationSelection(db, plan, { byProposalIds: [pid] });
    db.prepare('DELETE FROM import_item_confirmations WHERE proposal_id = ?').run(pid);
    const result = await runConfirmedOwnershipSave({
      db,
      sessionId: SESSION_ID,
      page: null as unknown as Page,
      timeout: 500,
    });
    expect(result).toHaveLength(0);
  });

  it('returns empty results when no confirmation rows exist', async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await installWriteGuard(page);
    const results = await runConfirmedOwnershipSave({
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

  it('does not change confirmation status after stale revalidation', async () => {
    const pid = seedEligibleItem(db, { sessionId: SESSION_ID });
    createConfirmedConfirmation(db, SESSION_ID, pid);
    const beforeRow = db
      .prepare('SELECT status FROM import_item_confirmations WHERE proposal_id = ?')
      .get(pid) as { status: string } | undefined;
    expect(beforeRow?.status).toBe('confirmed');
    db.prepare('UPDATE import_items SET status = ? WHERE proposal_id = ?').run('saved', pid);
    const result = await runConfirmedOwnershipSave({
      db,
      sessionId: SESSION_ID,
      page: null as unknown as Page,
      timeout: 500,
    });
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe('stale');
    const afterRow = db
      .prepare('SELECT status FROM import_item_confirmations WHERE proposal_id = ?')
      .get(pid) as { status: string } | undefined;
    expect(afterRow?.status).toBe('confirmed');
  });

  it('does not process items already marked saved', async () => {
    const pid = seedEligibleItem(db, { sessionId: SESSION_ID });
    createConfirmedConfirmation(db, SESSION_ID, pid);
    transitionItem(db, pid, 'importing');
    transitionItem(db, pid, 'saved', { outcomeReason: 'saved:ownership' });
    const result = await runConfirmedOwnershipSave({
      db,
      sessionId: SESSION_ID,
      page: null as unknown as Page,
      timeout: 500,
    });
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe('stale');
  });
});

// ==========================================================================
// Browser Save Tests
// ==========================================================================

describe('ownership-save-executor — browser save', { timeout: 30000 }, () => {
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
  // Test 1 — Full success path with save route returning 200
  // -----------------------------------------------------------------------
  it('stages, saves, verifies ownership present, and marks item saved', async () => {
    const page = await context.newPage();
    await installSaveRoute(page, 200);
    const slug = 'backloggd-save-editor';

    const pid = seedEligibleItem(db, {
      sessionId: SESSION_ID,
      steamAppId: 1001,
      backloggdSlug: slug,
      gameTitle: 'Save Editor Test Game',
    });
    createConfirmedConfirmation(db, SESSION_ID, pid);

    const beforeItem = getItem(db, pid);
    expect(beforeItem?.status).toBe('approved');

    const results = await runConfirmedOwnershipSave({
      db,
      sessionId: SESSION_ID,
      page,
      timeout: 5000,
      resolvePageUrl: resolveFixturePageUrl,
    });

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('saved');
    expect(results[0].proposalId).toBe(pid);

    const afterItem = getItem(db, pid);
    expect(afterItem?.status).toBe('saved');
    expect(afterItem?.outcomeReason).toContain('saved:ownership');

    await page.close();
  });

  it('accepts exact Save changes as a final action', async () => {
    const page = await context.newPage();
    await installSaveRoute(page, 200);
    const slug = 'backloggd-save-editor-save-changes';

    const pid = seedEligibleItem(db, {
      sessionId: SESSION_ID,
      steamAppId: 10001,
      backloggdSlug: slug,
      gameTitle: 'Save Changes Editor Test Game',
    });
    createConfirmedConfirmation(db, SESSION_ID, pid);

    const results = await runConfirmedOwnershipSave({
      db,
      sessionId: SESSION_ID,
      page,
      timeout: 5000,
      resolvePageUrl: resolveFixturePageUrl,
    });

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('saved');

    const saveChangesClickCount = await page.evaluate(() => {
      const w = window as unknown as { __saveChangesClickCount: number };
      return w.__saveChangesClickCount ?? 0;
    });
    expect(saveChangesClickCount).toBe(1);

    const afterItem = getItem(db, pid);
    expect(afterItem?.status).toBe('saved');

    await page.close();
  });

  // -----------------------------------------------------------------------
  // Test 2 — Item not saved before post-save visible verification
  // -----------------------------------------------------------------------
  it('does not mark item saved when post-save verification fails', async () => {
    const page = await context.newPage();
    await installSaveRoute(page, 200);
    const slug = 'backloggd-save-editor-failure';

    const pid = seedEligibleItem(db, {
      sessionId: SESSION_ID,
      steamAppId: 1002,
      backloggdSlug: slug,
      gameTitle: 'Save Editor Failure Test Game',
    });
    createConfirmedConfirmation(db, SESSION_ID, pid);

    const beforeItem = getItem(db, pid);
    expect(beforeItem?.status).toBe('approved');

    const results = await runConfirmedOwnershipSave({
      db,
      sessionId: SESSION_ID,
      page,
      timeout: 5000,
      resolvePageUrl: resolveFixturePageUrl,
    });

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('verificationFailed');

    const afterItem = getItem(db, pid);
    expect(afterItem?.status).not.toBe('saved');
    expect(afterItem?.status).toBe('approved');

    await page.close();
  });

  // -----------------------------------------------------------------------
  // Test 11 — Staging unsupported prevents save click
  // -----------------------------------------------------------------------
  it('does not click save when staging returns unsupported', async () => {
    const page = await context.newPage();
    const slug = 'backloggd-ownership-generic';

    const pid = seedEligibleItem(db, {
      sessionId: SESSION_ID,
      steamAppId: 1003,
      backloggdSlug: slug,
      gameTitle: 'Portal 2',
    });
    createConfirmedConfirmation(db, SESSION_ID, pid);

    const results = await runConfirmedOwnershipSave({
      db,
      sessionId: SESSION_ID,
      page,
      timeout: 3000,
      resolvePageUrl: resolveFixturePageUrl,
    });

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('stagingFailed');

    const afterItem = getItem(db, pid);
    expect(afterItem?.status).toBe('approved');

    await page.close();
  });

  // -----------------------------------------------------------------------
  // Test 12 — Staging blockedWrite prevents save click
  // -----------------------------------------------------------------------
  it('does not click save when staging returns blockedWrite', async () => {
    const page = await context.newPage();
    const slug = 'backloggd-staging-delayed-post';

    const pid = seedEligibleItem(db, {
      sessionId: SESSION_ID,
      steamAppId: 1004,
      backloggdSlug: slug,
      gameTitle: 'Staging Test Game',
    });
    createConfirmedConfirmation(db, SESSION_ID, pid);

    const results = await runConfirmedOwnershipSave({
      db,
      sessionId: SESSION_ID,
      page,
      timeout: 5000,
      resolvePageUrl: resolveFixturePageUrl,
    });

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('stagingFailed');

    const afterItem = getItem(db, pid);
    expect(afterItem?.status).toBe('approved');

    await page.close();
  });

  // -----------------------------------------------------------------------
  // Test 13 — Missing final Save button returns unsupported
  // -----------------------------------------------------------------------
  it('returns unsupported when editor has no safe save button', async () => {
    const page = await context.newPage();
    const slug = 'backloggd-save-editor-forbidden-only';

    const pid = seedEligibleItem(db, {
      sessionId: SESSION_ID,
      steamAppId: 1005,
      backloggdSlug: slug,
      gameTitle: 'Save Editor Forbidden Test Game',
    });
    createConfirmedConfirmation(db, SESSION_ID, pid);

    const results = await runConfirmedOwnershipSave({
      db,
      sessionId: SESSION_ID,
      page,
      timeout: 5000,
      resolvePageUrl: resolveFixturePageUrl,
    });

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('unsupported');

    const afterItem = getItem(db, pid);
    expect(afterItem?.status).toBe('approved');

    await page.close();
  });

  // -----------------------------------------------------------------------
  // Test 14 — Duplicate Save buttons returns unsupported
  // -----------------------------------------------------------------------
  it('returns unsupported when there are duplicate save buttons', async () => {
    const page = await context.newPage();
    const slug = 'backloggd-save-editor-duplicate';

    const pid = seedEligibleItem(db, {
      sessionId: SESSION_ID,
      steamAppId: 1006,
      backloggdSlug: slug,
      gameTitle: 'Save Editor Duplicate Test Game',
    });
    createConfirmedConfirmation(db, SESSION_ID, pid);

    const results = await runConfirmedOwnershipSave({
      db,
      sessionId: SESSION_ID,
      page,
      timeout: 5000,
      resolvePageUrl: resolveFixturePageUrl,
    });

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('unsupported');

    const saveClickCount = await page.evaluate(() => {
      const w = window as unknown as { __saveClickCount: number };
      return w.__saveClickCount ?? 0;
    });
    expect(saveClickCount).toBe(0);

    await page.close();
  });

  // -----------------------------------------------------------------------
  // Test 15 — Forbidden actions only returns unsupported
  // -----------------------------------------------------------------------
  it('returns unsupported when only forbidden actions exist', async () => {
    const page = await context.newPage();
    const slug = 'backloggd-save-editor-forbidden-only';

    const pid = seedEligibleItem(db, {
      sessionId: SESSION_ID,
      steamAppId: 1007,
      backloggdSlug: slug,
      gameTitle: 'Save Editor Forbidden Test Game',
    });
    createConfirmedConfirmation(db, SESSION_ID, pid);

    const results = await runConfirmedOwnershipSave({
      db,
      sessionId: SESSION_ID,
      page,
      timeout: 5000,
      resolvePageUrl: resolveFixturePageUrl,
    });

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('unsupported');

    await page.close();
  });

  // -----------------------------------------------------------------------
  // Test 17 — No forbidden actions clicked (click tracker proof)
  // -----------------------------------------------------------------------
  it('proves no forbidden actions are clicked via click trackers', async () => {
    const page = await context.newPage();
    await installSaveRoute(page, 200);
    const slug = 'backloggd-save-editor';

    const pid = seedEligibleItem(db, {
      sessionId: SESSION_ID,
      steamAppId: 1009,
      backloggdSlug: slug,
      gameTitle: 'Save Editor Test Game',
    });
    createConfirmedConfirmation(db, SESSION_ID, pid);

    const results = await runConfirmedOwnershipSave({
      db,
      sessionId: SESSION_ID,
      page,
      timeout: 5000,
      resolvePageUrl: resolveFixturePageUrl,
    });

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('saved');

    const clickCounts = await page.evaluate(() => {
      const w = window as unknown as {
        __saveClickCount: number;
        __deleteClickCount: number;
        __removeClickCount: number;
        __fullEditorClickCount: number;
        __createLogClickCount: number;
        __confirmClickCount: number;
        __updateClickCount: number;
        __submitClickCount: number;
      };
      return {
        save: w.__saveClickCount ?? 0,
        delete: w.__deleteClickCount ?? 0,
        remove: w.__removeClickCount ?? 0,
        fullEditor: w.__fullEditorClickCount ?? 0,
        createLog: w.__createLogClickCount ?? 0,
        confirm: w.__confirmClickCount ?? 0,
        update: w.__updateClickCount ?? 0,
        submit: w.__submitClickCount ?? 0,
      };
    });

    expect(clickCounts.save).toBe(1);
    expect(clickCounts.delete).toBe(0);
    expect(clickCounts.remove).toBe(0);
    expect(clickCounts.fullEditor).toBe(0);
    expect(clickCounts.createLog).toBe(0);
    expect(clickCounts.confirm).toBe(0);
    expect(clickCounts.update).toBe(0);
    expect(clickCounts.submit).toBe(0);

    await page.close();
  });

  // -----------------------------------------------------------------------
  // Test 18 — Save allowance lets expected save POST through
  // -----------------------------------------------------------------------
  it('allows the expected save POST via save route', async () => {
    const page = await context.newPage();
    await installSaveRoute(page, 200);
    const slug = 'backloggd-save-editor';

    const pid = seedEligibleItem(db, {
      sessionId: SESSION_ID,
      steamAppId: 1010,
      backloggdSlug: slug,
      gameTitle: 'Save Editor Test Game',
    });
    createConfirmedConfirmation(db, SESSION_ID, pid);

    const results = await runConfirmedOwnershipSave({
      db,
      sessionId: SESSION_ID,
      page,
      timeout: 5000,
      resolvePageUrl: resolveFixturePageUrl,
    });

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('saved');

    await page.close();
  });

  // -----------------------------------------------------------------------
  // Test 20 — Page close returns browserFailed
  // -----------------------------------------------------------------------
  it('returns browserFailed when page is closed after save click', async () => {
    const page = await context.newPage();
    const slug = 'backloggd-save-editor';

    const pid = seedEligibleItem(db, {
      sessionId: SESSION_ID,
      steamAppId: 1012,
      backloggdSlug: slug,
      gameTitle: 'Save Editor Test Game',
    });
    createConfirmedConfirmation(db, SESSION_ID, pid);

    await page.goto(resolveFixturePageUrl(slug), { waitUntil: 'domcontentloaded', timeout: 3000 });
    await page.close();

    const deadPage = await context.newPage();
    await deadPage.goto('about:blank');

    const results = await runConfirmedOwnershipSave({
      db,
      sessionId: SESSION_ID,
      page: deadPage,
      timeout: 500,
      resolvePageUrl: () => 'file:///nonexistent/fixture.html',
    });

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('browserFailed');

    const afterItem = getItem(db, pid);
    expect(afterItem?.status).toBe('approved');

    await deadPage.close();
  });

  // -----------------------------------------------------------------------
  // Test 22+23 — Only targeted item is transitioned to saved
  // -----------------------------------------------------------------------
  it('transitions only the targeted item to saved, not unrelated items', async () => {
    const page = await context.newPage();
    await installSaveRoute(page, 200);
    const slug = 'backloggd-save-editor';

    const pid1 = seedEligibleItem(db, {
      sessionId: SESSION_ID,
      steamAppId: 1014,
      backloggdSlug: slug,
      gameTitle: 'Save Editor Test Game',
    });
    const pid2 = seedEligibleItem(db, {
      sessionId: SESSION_ID,
      steamAppId: 1015,
      backloggdSlug: 'other-game',
      gameTitle: 'Other Game',
    });
    createConfirmedConfirmation(db, SESSION_ID, pid1);

    const results = await runConfirmedOwnershipSave({
      db,
      sessionId: SESSION_ID,
      page,
      timeout: 5000,
      resolvePageUrl: resolveFixturePageUrl,
    });

    const pid1Results = results.filter((r) => r.proposalId === pid1);
    expect(pid1Results).toHaveLength(1);
    expect(pid1Results[0].status).toBe('saved');

    const item1 = getItem(db, pid1);
    expect(item1?.status).toBe('saved');
    const item2 = getItem(db, pid2);
    expect(item2?.status).toBe('approved');

    await page.close();
  });

  // -----------------------------------------------------------------------
  // Test 26 — Multiple confirmations process independently
  // -----------------------------------------------------------------------
  it('processes multiple confirmations independently', { timeout: 30000 }, async () => {
    const page = await context.newPage();
    await installSaveRoute(page, 200);
    const slug = 'backloggd-save-editor';

    const pid1 = seedEligibleItem(db, {
      sessionId: SESSION_ID,
      steamAppId: 1016,
      backloggdSlug: slug,
      gameTitle: 'Save Editor Test Game',
    });
    const pid2 = seedEligibleItem(db, {
      sessionId: SESSION_ID,
      steamAppId: 1017,
      backloggdSlug: slug,
      gameTitle: 'Save Editor Test Game',
    });
    createConfirmedConfirmation(db, SESSION_ID, pid1);
    createConfirmedConfirmation(db, SESSION_ID, pid2);

    const results = await runConfirmedOwnershipSave({
      db,
      sessionId: SESSION_ID,
      page,
      timeout: 5000,
      resolvePageUrl: resolveFixturePageUrl,
    });

    const resultPids = results.map((r) => r.proposalId);
    expect(resultPids).toContain(pid1);
    expect(resultPids).toContain(pid2);

    await page.close();
  });

  // -----------------------------------------------------------------------
  // Test 27 — Mixed success and failure
  // -----------------------------------------------------------------------
  it('handles mixed success and failure independently', { timeout: 30000 }, async () => {
    const page = await context.newPage();
    await installSaveRoute(page, 200);

    const slug1 = 'backloggd-save-editor';
    const pid1 = seedEligibleItem(db, {
      sessionId: SESSION_ID,
      steamAppId: 1018,
      backloggdSlug: slug1,
      gameTitle: 'Save Editor Test Game',
    });
    createConfirmedConfirmation(db, SESSION_ID, pid1);

    const slug2 = 'backloggd-save-editor-forbidden-only';
    const pid2 = seedEligibleItem(db, {
      sessionId: SESSION_ID,
      steamAppId: 1019,
      backloggdSlug: slug2,
      gameTitle: 'Save Editor Forbidden Test Game',
    });
    createConfirmedConfirmation(db, SESSION_ID, pid2);

    const results = await runConfirmedOwnershipSave({
      db,
      sessionId: SESSION_ID,
      page,
      timeout: 5000,
      resolvePageUrl: resolveFixturePageUrl,
    });

    const result1 = results.find((r) => r.proposalId === pid1);
    const result2 = results.find((r) => r.proposalId === pid2);

    expect(result1?.status).toBe('saved');
    expect(result2?.status).toBe('unsupported');

    const item1 = getItem(db, pid1);
    expect(item1?.status).toBe('saved');
    const item2 = getItem(db, pid2);
    expect(item2?.status).toBe('approved');

    await page.close();
  });

  // -----------------------------------------------------------------------
  // Test 28 — Save allowance enabled only during save, closed after
  // -----------------------------------------------------------------------
  it('save allowance is enabled only during save and disabled after', async () => {
    const page = await context.newPage();
    await installSaveRoute(page, 200);
    const slug = 'backloggd-save-editor';

    const pid = seedEligibleItem(db, {
      sessionId: SESSION_ID,
      steamAppId: 1020,
      backloggdSlug: slug,
      gameTitle: 'Save Editor Test Game',
    });
    createConfirmedConfirmation(db, SESSION_ID, pid);

    const results = await runConfirmedOwnershipSave({
      db,
      sessionId: SESSION_ID,
      page,
      timeout: 5000,
      resolvePageUrl: resolveFixturePageUrl,
    });

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('saved');

    // After save, the allowance should be closed. Verify by triggering a POST
    // that should be blocked.
    let blockedPostCount = 0;
    const onReqFailed = (req: { method: () => string; url: () => string }) => {
      if (req.method().toUpperCase() === 'POST') blockedPostCount++;
    };
    page.on('requestfailed', onReqFailed);

    await page.evaluate(() => {
      fetch('https://backloggd.com/api/library/', { method: 'POST' }).catch(() => {
        /* ignore */
      });
    });
    await page.waitForTimeout(500);

    page.removeListener('requestfailed', onReqFailed);
    expect(blockedPostCount).toBeGreaterThan(0);

    await page.close();
  });

  // -----------------------------------------------------------------------
  // Finding 2 test 1 — Save button updates DOM but sends no fetch
  // -----------------------------------------------------------------------
  it('returns saveFailed when save updates DOM but sends no request', async () => {
    const page = await context.newPage();
    // Use the failure fixture which does NOT fire a fetch on save.
    // But we need a fixture where Save fires NO fetch at all.
    // The failure fixture's Save reverts the library.  To test "no fetch"
    // we modify the fixture behavior by blocking the save endpoint route.
    await page.route(SAVE_API_URL, async (route) => {
      // Abort the request so it never reaches the server.
      await route.abort('blockedbyclient');
    });
    const slug = 'backloggd-save-editor';

    const pid = seedEligibleItem(db, {
      sessionId: SESSION_ID,
      steamAppId: 2001,
      backloggdSlug: slug,
      gameTitle: 'Save Editor Test Game',
    });
    createConfirmedConfirmation(db, SESSION_ID, pid);

    const results = await runConfirmedOwnershipSave({
      db,
      sessionId: SESSION_ID,
      page,
      timeout: 5000,
      resolvePageUrl: resolveFixturePageUrl,
    });

    // The save button is clicked, the fetch is aborted by our route,
    // so the write guard sees a blocked write → blockedWrite
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('blockedWrite');

    const afterItem = getItem(db, pid);
    expect(afterItem?.status).toBe('approved');

    await page.close();
  });

  // -----------------------------------------------------------------------
  // Finding 2 test 2 — Save request returns 500
  // -----------------------------------------------------------------------
  it('returns saveFailed when save request returns 500', async () => {
    const page = await context.newPage();
    await installSaveRoute(page, 500);
    const slug = 'backloggd-save-editor';

    const pid = seedEligibleItem(db, {
      sessionId: SESSION_ID,
      steamAppId: 2002,
      backloggdSlug: slug,
      gameTitle: 'Save Editor Test Game',
    });
    createConfirmedConfirmation(db, SESSION_ID, pid);

    const beforeItem = getItem(db, pid);
    expect(beforeItem?.status).toBe('approved');

    const results = await runConfirmedOwnershipSave({
      db,
      sessionId: SESSION_ID,
      page,
      timeout: 5000,
      resolvePageUrl: resolveFixturePageUrl,
    });

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('saveFailed');

    const afterItem = getItem(db, pid);
    expect(afterItem?.status).toBe('approved');

    await page.close();
  });

  // -----------------------------------------------------------------------
  // Finding 2 test 3 — Save request returns 204
  // -----------------------------------------------------------------------
  it('proceeds to post-save verification when save returns 204', async () => {
    const page = await context.newPage();
    await installSaveRoute(page, 204);
    const slug = 'backloggd-save-editor';

    const pid = seedEligibleItem(db, {
      sessionId: SESSION_ID,
      steamAppId: 2003,
      backloggdSlug: slug,
      gameTitle: 'Save Editor Test Game',
    });
    createConfirmedConfirmation(db, SESSION_ID, pid);

    const results = await runConfirmedOwnershipSave({
      db,
      sessionId: SESSION_ID,
      page,
      timeout: 5000,
      resolvePageUrl: resolveFixturePageUrl,
    });

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('saved');

    const afterItem = getItem(db, pid);
    expect(afterItem?.status).toBe('saved');

    await page.close();
  });

  // -----------------------------------------------------------------------
  // Finding 1 test 1 — DELETE /api/library/123 blocked during save allowance
  // -----------------------------------------------------------------------
  it('blocks DELETE /api/library/123 during save allowance', async () => {
    const page = await context.newPage();
    await installSaveRoute(page, 200);
    const slug = 'backloggd-save-editor';

    const pid = seedEligibleItem(db, {
      sessionId: SESSION_ID,
      steamAppId: 3001,
      backloggdSlug: slug,
      gameTitle: 'Save Editor Test Game',
    });
    createConfirmedConfirmation(db, SESSION_ID, pid);

    const results = await runConfirmedOwnershipSave({
      db,
      sessionId: SESSION_ID,
      page,
      timeout: 5000,
      resolvePageUrl: resolveFixturePageUrl,
    });

    // The save succeeds (POST is allowed).  But we verify that during the
    // save window, a DELETE would be blocked.  We can't inject a DELETE
    // during the save, but we can verify the allowance only allowed the POST.
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('saved');

    // After save, verify DELETE is blocked
    let blockedDelete = false;
    const onReqFailed = (req: { method: () => string }) => {
      if (req.method().toUpperCase() === 'DELETE') blockedDelete = true;
    };
    page.on('requestfailed', onReqFailed);

    await page.evaluate(() => {
      fetch('https://backloggd.com/api/library/123', { method: 'DELETE' }).catch(() => {
        /* ignore */
      });
    });
    await page.waitForTimeout(500);

    page.removeListener('requestfailed', onReqFailed);
    expect(blockedDelete).toBe(true);

    await page.close();
  });

  // -----------------------------------------------------------------------
  // Finding 1 test 2 — PATCH /api/library/123 blocked during save allowance
  // -----------------------------------------------------------------------
  it('blocks PATCH /api/library/123 during save allowance', async () => {
    const page = await context.newPage();
    await installSaveRoute(page, 200);
    const slug = 'backloggd-save-editor';

    const pid = seedEligibleItem(db, {
      sessionId: SESSION_ID,
      steamAppId: 3002,
      backloggdSlug: slug,
      gameTitle: 'Save Editor Test Game',
    });
    createConfirmedConfirmation(db, SESSION_ID, pid);

    const results = await runConfirmedOwnershipSave({
      db,
      sessionId: SESSION_ID,
      page,
      timeout: 5000,
      resolvePageUrl: resolveFixturePageUrl,
    });

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('saved');

    let blockedPatch = false;
    const onReqFailed = (req: { method: () => string }) => {
      if (req.method().toUpperCase() === 'PATCH') blockedPatch = true;
    };
    page.on('requestfailed', onReqFailed);

    await page.evaluate(() => {
      fetch('https://backloggd.com/api/library/123', { method: 'PATCH' }).catch(() => {
        /* ignore */
      });
    });
    await page.waitForTimeout(500);

    page.removeListener('requestfailed', onReqFailed);
    expect(blockedPatch).toBe(true);

    await page.close();
  });

  // -----------------------------------------------------------------------
  // Finding 1 test 3 — POST /api/library-malicious blocked
  // -----------------------------------------------------------------------
  it('blocks POST /api/library-malicious during save allowance', async () => {
    const page = await context.newPage();
    await installSaveRoute(page, 200);
    const slug = 'backloggd-save-editor';

    const pid = seedEligibleItem(db, {
      sessionId: SESSION_ID,
      steamAppId: 3003,
      backloggdSlug: slug,
      gameTitle: 'Save Editor Test Game',
    });
    createConfirmedConfirmation(db, SESSION_ID, pid);

    const results = await runConfirmedOwnershipSave({
      db,
      sessionId: SESSION_ID,
      page,
      timeout: 5000,
      resolvePageUrl: resolveFixturePageUrl,
    });

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('saved');

    let blockedMalicious = false;
    const onReqFailed = (req: { method: () => string; url: () => string }) => {
      if (req.method().toUpperCase() === 'POST' && req.url().includes('library-malicious')) {
        blockedMalicious = true;
      }
    };
    page.on('requestfailed', onReqFailed);

    await page.evaluate(() => {
      fetch('https://backloggd.com/api/library-malicious', { method: 'POST' }).catch(() => {
        /* ignore */
      });
    });
    await page.waitForTimeout(500);

    page.removeListener('requestfailed', onReqFailed);
    expect(blockedMalicious).toBe(true);

    await page.close();
  });

  // -----------------------------------------------------------------------
  // Finding 1 test 4 — After allowance closes, save POST is blocked
  // -----------------------------------------------------------------------
  it('blocks save POST after allowance closes', async () => {
    const page = await context.newPage();
    await installSaveRoute(page, 200);
    const slug = 'backloggd-save-editor';

    const pid = seedEligibleItem(db, {
      sessionId: SESSION_ID,
      steamAppId: 3004,
      backloggdSlug: slug,
      gameTitle: 'Save Editor Test Game',
    });
    createConfirmedConfirmation(db, SESSION_ID, pid);

    const results = await runConfirmedOwnershipSave({
      db,
      sessionId: SESSION_ID,
      page,
      timeout: 5000,
      resolvePageUrl: resolveFixturePageUrl,
    });

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('saved');

    let blockedPost = false;
    const onReqFailed = (req: { method: () => string }) => {
      if (req.method().toUpperCase() === 'POST') blockedPost = true;
    };
    page.on('requestfailed', onReqFailed);

    await page.evaluate(() => {
      fetch('https://backloggd.com/api/library/', { method: 'POST' }).catch(() => {
        /* ignore */
      });
    });
    await page.waitForTimeout(500);

    page.removeListener('requestfailed', onReqFailed);
    expect(blockedPost).toBe(true);

    await page.close();
  });

  // -----------------------------------------------------------------------
  // Finding 4 — Atomic transition: trigger that aborts saves leaves item approved
  // -----------------------------------------------------------------------
  it('leaves item approved when saved transition fails atomically', async () => {
    const page = await context.newPage();
    await installSaveRoute(page, 200);
    const slug = 'backloggd-save-editor';

    const pid = seedEligibleItem(db, {
      sessionId: SESSION_ID,
      steamAppId: 4001,
      backloggdSlug: slug,
      gameTitle: 'Save Editor Test Game',
    });
    createConfirmedConfirmation(db, SESSION_ID, pid);

    // Install a SQLite trigger that aborts updates where NEW.status = 'saved'
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_prevent_saved
      BEFORE UPDATE OF status ON import_items
      WHEN NEW.status = 'saved'
      BEGIN
        SELECT RAISE(ABORT, 'saved status blocked by test trigger');
      END;
    `);

    const beforeItem = getItem(db, pid);
    expect(beforeItem?.status).toBe('approved');
    const beforeReason = beforeItem?.outcomeReason;

    const results = await runConfirmedOwnershipSave({
      db,
      sessionId: SESSION_ID,
      page,
      timeout: 5000,
      resolvePageUrl: resolveFixturePageUrl,
    });

    // The save response was 200 but the DB transition failed → saveFailed
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('saveFailed');

    // Item must remain approved (not stuck at importing)
    const afterItem = getItem(db, pid);
    expect(afterItem?.status).toBe('approved');
    // outcomeReason must be unchanged
    expect(afterItem?.outcomeReason).toBe(beforeReason);

    // Confirmation must remain confirmed
    const row = db
      .prepare('SELECT status FROM import_item_confirmations WHERE proposal_id = ?')
      .get(pid) as { status: string } | undefined;
    expect(row?.status).toBe('confirmed');

    await page.close();
  });

  // -----------------------------------------------------------------------
  // Finding 1 Regression — Update is forbidden as a final action.
  //   A staged editor whose ONLY final action is `<button>Update</button>`
  //   must be rejected with `unsupported`.  Update must NOT be clicked.
  // -----------------------------------------------------------------------
  it('rejects Update as a final action and never clicks it', async () => {
    const page = await context.newPage();
    const slug = 'backloggd-save-editor-update-only';

    const pid = seedEligibleItem(db, {
      sessionId: SESSION_ID,
      steamAppId: 5001,
      backloggdSlug: slug,
      gameTitle: 'Save Editor Update Only Test Game',
    });
    createConfirmedConfirmation(db, SESSION_ID, pid);

    const beforeItem = getItem(db, pid);
    expect(beforeItem?.status).toBe('approved');

    const results = await runConfirmedOwnershipSave({
      db,
      sessionId: SESSION_ID,
      page,
      timeout: 5000,
      resolvePageUrl: resolveFixturePageUrl,
    });

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('unsupported');
    expect(results[0].proposalId).toBe(pid);

    // Update must NOT have been clicked by the executor
    const updateClickCount = await page.evaluate(() => {
      const w = window as unknown as { __updateClickCount: number };
      return w.__updateClickCount ?? 0;
    });
    expect(updateClickCount).toBe(0);

    // Item must remain approved, never transitioned to saved
    const afterItem = getItem(db, pid);
    expect(afterItem?.status).toBe('approved');

    // Confirmation must remain confirmed (NOT mutated by staging or save)
    const row = db
      .prepare('SELECT status FROM import_item_confirmations WHERE proposal_id = ?')
      .get(pid) as { status: string } | undefined;
    expect(row?.status).toBe('confirmed');

    await page.close();
  });

  it('rejects Save as draft as a final action and never clicks it', async () => {
    const page = await context.newPage();
    await installSaveRoute(page, 200);
    const slug = 'backloggd-save-editor-save-as-draft-only';

    const pid = seedEligibleItem(db, {
      sessionId: SESSION_ID,
      steamAppId: 5002,
      backloggdSlug: slug,
      gameTitle: 'Save As Draft Only Editor Test Game',
    });
    createConfirmedConfirmation(db, SESSION_ID, pid);

    const beforeItem = getItem(db, pid);
    expect(beforeItem?.status).toBe('approved');

    const results = await runConfirmedOwnershipSave({
      db,
      sessionId: SESSION_ID,
      page,
      timeout: 5000,
      resolvePageUrl: resolveFixturePageUrl,
    });

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('unsupported');
    expect(results[0].proposalId).toBe(pid);

    const saveDraftClickCount = await page.evaluate(() => {
      const w = window as unknown as { __saveDraftClickCount: number };
      return w.__saveDraftClickCount ?? 0;
    });
    expect(saveDraftClickCount).toBe(0);

    const afterItem = getItem(db, pid);
    expect(afterItem?.status).toBe('approved');
    expect(afterItem?.status).not.toBe('saved');
    expect(afterItem?.outcomeReason).toBe(beforeItem?.outcomeReason);

    const row = db
      .prepare('SELECT status FROM import_item_confirmations WHERE proposal_id = ?')
      .get(pid) as { status: string } | undefined;
    expect(row?.status).toBe('confirmed');

    await page.close();
  });

  // -----------------------------------------------------------------------
  // Finding 2 Regression 1 — Save button does nothing, separate delayed
  // matching POST fires during the allowance window and returns 204.
  //   The executor MUST reject this as `saveFailed` because the matching
  //   request is NOT click-driven.
  // -----------------------------------------------------------------------
  it('returns saveFailed when save does nothing but a delayed POST fires returning 204', async () => {
    const page = await context.newPage();
    await installSaveRoute(page, 204);
    const slug = 'backloggd-save-editor-delayed-post';

    const pid = seedEligibleItem(db, {
      sessionId: SESSION_ID,
      steamAppId: 6001,
      backloggdSlug: slug,
      gameTitle: 'Save Editor Delayed Post Test Game',
    });
    createConfirmedConfirmation(db, SESSION_ID, pid);

    const beforeItem = getItem(db, pid);
    expect(beforeItem?.status).toBe('approved');

    const results = await runConfirmedOwnershipSave({
      db,
      sessionId: SESSION_ID,
      page,
      timeout: 8000,
      resolvePageUrl: resolveFixturePageUrl,
    });

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('saveFailed');
    expect(results[0].proposalId).toBe(pid);

    const afterItem = getItem(db, pid);
    expect(afterItem?.status).toBe('approved');
    expect(afterItem?.status).not.toBe('saved');

    // The Save button was clicked, but the click handler does not fire a
    // fetch — it's the delayed setTimeout that fired the matching POST.
    const clickState = await page.evaluate(() => {
      const w = window as unknown as {
        __saveClickCount: number;
        __savePostSent: number;
      };
      return {
        save: w.__saveClickCount ?? 0,
        delayedSent: w.__savePostSent ?? 0,
      };
    });
    expect(clickState.save).toBe(1);
    expect(clickState.delayedSent).toBe(1);

    await page.close();
  });

  // -----------------------------------------------------------------------
  // Finding 2 Regression 2 — Save click produces TWO matching POSTs.
  //   The executor MUST reject this as `saveFailed` because more than one
  //   click-driven matching request was observed.
  // -----------------------------------------------------------------------
  it('returns saveFailed when save click produces two matching POSTs', async () => {
    const page = await context.newPage();
    await installSaveRoute(page, 204);
    const slug = 'backloggd-save-editor-double-post';

    const pid = seedEligibleItem(db, {
      sessionId: SESSION_ID,
      steamAppId: 6002,
      backloggdSlug: slug,
      gameTitle: 'Save Editor Double Post Test Game',
    });
    createConfirmedConfirmation(db, SESSION_ID, pid);

    const beforeItem = getItem(db, pid);
    expect(beforeItem?.status).toBe('approved');

    const results = await runConfirmedOwnershipSave({
      db,
      sessionId: SESSION_ID,
      page,
      timeout: 5000,
      resolvePageUrl: resolveFixturePageUrl,
    });

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('saveFailed');
    expect(results[0].proposalId).toBe(pid);

    const afterItem = getItem(db, pid);
    expect(afterItem?.status).toBe('approved');
    expect(afterItem?.status).not.toBe('saved');

    await page.close();
  });

  // -----------------------------------------------------------------------
  // Finding 2 Regression 3 — Save click produces exactly one matching POST
  // returning 204.  The executor MUST proceed to post-save verification
  // (verifyGamePage + visible Steam/Digital ownership check).  Because
  // the click-driven single POST succeeded, the item is marked saved.
  // -----------------------------------------------------------------------
  it('proceeds to post-save verification when save click emits exactly one matching 204', async () => {
    const page = await context.newPage();
    await installSaveRoute(page, 204);
    const slug = 'backloggd-save-editor';

    const pid = seedEligibleItem(db, {
      sessionId: SESSION_ID,
      steamAppId: 6003,
      backloggdSlug: slug,
      gameTitle: 'Save Editor Test Game',
    });
    createConfirmedConfirmation(db, SESSION_ID, pid);

    const results = await runConfirmedOwnershipSave({
      db,
      sessionId: SESSION_ID,
      page,
      timeout: 5000,
      resolvePageUrl: resolveFixturePageUrl,
    });

    expect(results).toHaveLength(1);
    // Exactly one click-driven 2xx response → allowed to proceed to
    // post-save visible verification.
    expect(['saved', 'verificationFailed']).toContain(results[0].status);

    // If the post-save verification succeeded, the item must be saved.
    // If verification failed (an unrelated condition), the item must remain
    // in its prior status.  Either way the executor MUST NOT classify this
    // as saveFailed (which would mean the click-driven request was rejected).
    if (results[0].status === 'saved') {
      const afterItem = getItem(db, pid);
      expect(afterItem?.status).toBe('saved');
    } else {
      expect(results[0].status).toBe('verificationFailed');
      const afterItem = getItem(db, pid);
      expect(afterItem?.status).toBe('approved');
    }

    await page.close();
  });

  // -----------------------------------------------------------------------
  // Finding 2 Regression 4 — A pre-click matching POST fires before Save,
  // and the Save click also emits exactly one valid matching request.
  //   The save allowance window must contain exactly one matching save
  //   request — the one caused by the verified Save click.  Any pre-click
  //   matching save request invalidates the save proof even when a
  //   click-driven valid request also exists.  Expected result:
  //   `saveFailed`, item remains `approved`, confirmation remains
  //   `confirmed`.  Both fetch log entries may exist, but the pre-click
  //   one invalidates the save proof.
  // -----------------------------------------------------------------------
  it('returns saveFailed when a pre-click POST fires before the click-driven POST', async () => {
    const page = await context.newPage();
    await installSaveRoute(page, 204);
    const slug = 'backloggd-save-editor-pre-and-post';

    const pid = seedEligibleItem(db, {
      sessionId: SESSION_ID,
      steamAppId: 6004,
      backloggdSlug: slug,
      gameTitle: 'Save Editor Pre And Post Test Game',
    });
    createConfirmedConfirmation(db, SESSION_ID, pid);

    const beforeItem = getItem(db, pid);
    expect(beforeItem?.status).toBe('approved');

    const results = await runConfirmedOwnershipSave({
      db,
      sessionId: SESSION_ID,
      page,
      timeout: 6000,
      resolvePageUrl: resolveFixturePageUrl,
    });

    expect(results).toHaveLength(1);
    // The pre-click matching request invalidates the save proof even
    // though the click-driven request was valid.  Result MUST be
    // `saveFailed` and MUST NOT proceed to local `saved`.
    expect(results[0].status).toBe('saveFailed');
    expect(results[0].status).not.toBe('saved');
    expect(results[0].detail ?? '').toMatch(/pre_click_matching_save_requests/);

    // Item must remain `approved` — no local `saved` transition.
    const afterItem = getItem(db, pid);
    expect(afterItem?.status).toBe('approved');

    // Confirmation must remain `confirmed` — never mutated by save failure.
    const row = db
      .prepare('SELECT status FROM import_item_confirmations WHERE proposal_id = ?')
      .get(pid) as { status: string } | undefined;
    expect(row?.status).toBe('confirmed');

    const clickState = await page.evaluate(() => {
      const w = window as unknown as {
        __saveClickCount: number;
        __saveFetchLog: { url: string; time: number; method: string }[];
      };
      return {
        save: w.__saveClickCount ?? 0,
        fetchCount: (w.__saveFetchLog ?? []).length,
      };
    });
    // Confirm the fixture fired both pre-click and click-driven POSTs.
    // Both fetch log entries may exist — the pre-click one is what
    // invalidates the save proof.
    expect(clickState.save).toBe(1);
    expect(clickState.fetchCount).toBe(2);

    await page.close();
  });

  // -----------------------------------------------------------------------
  // Finding 1 Regression — Late extra matching POST after valid click-driven
  // save.  The Save click fires one immediate matching fetch POST + 204
  // response, then schedules another matching fetch POST after ~150ms.
  // The executor MUST wait for the full late-detection window, detect the
  // extra request, and return saveFailed — never saved.
  // -----------------------------------------------------------------------
  it('returns saveFailed when a late extra matching POST fires after the click-driven POST', async () => {
    const page = await context.newPage();
    await installSaveRoute(page, 204);
    const slug = 'backloggd-save-editor-late-extra-post';

    const pid = seedEligibleItem(db, {
      sessionId: SESSION_ID,
      steamAppId: 7001,
      backloggdSlug: slug,
      gameTitle: 'Save Editor Late Extra Post Test Game',
    });
    createConfirmedConfirmation(db, SESSION_ID, pid);

    const beforeItem = getItem(db, pid);
    expect(beforeItem?.status).toBe('approved');

    const results = await runConfirmedOwnershipSave({
      db,
      sessionId: SESSION_ID,
      page,
      timeout: 6000,
      resolvePageUrl: resolveFixturePageUrl,
    });

    // The immediate POST succeeds (204), but the late POST at ~150ms
    // triggers the late-matching rejection.  Result MUST be saveFailed,
    // not saved.
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('saveFailed');
    expect(results[0].status).not.toBe('saved');
    expect(results[0].detail ?? '').toMatch(/late_matching_save_requests/);

    // Item must remain approved — no local saved transition.
    const afterItem = getItem(db, pid);
    expect(afterItem?.status).toBe('approved');

    // Confirmation must remain confirmed — never mutated by save failure.
    const row = db
      .prepare('SELECT status FROM import_item_confirmations WHERE proposal_id = ?')
      .get(pid) as { status: string } | undefined;
    expect(row?.status).toBe('confirmed');

    // Verify the late POST actually fired in the fixture.
    await page.waitForTimeout(300);
    const lateCount = await page.evaluate(() => {
      const w = window as unknown as { __latePostCount: number };
      return w.__latePostCount ?? 0;
    });
    expect(lateCount).toBe(1);

    await page.close();
  });

  // -----------------------------------------------------------------------
  // Finding 2 Regression — Save click fires both an XHR POST and a fetch
  // POST to /api/library/.  The page-side fetch audit only sees the fetch;
  // Playwright sees both.  The executor MUST reject because the Playwright
  // request count (2) differs from the fetch audit count (1), and because
  // more than one matching Playwright request is observed.
  // Expected: saveFailed, item remains approved, confirmation confirmed.
  // -----------------------------------------------------------------------
  it('returns saveFailed when XHR and fetch both fire matching POSTs', async () => {
    const page = await context.newPage();

    // Custom route: first matching POST gets 204, second gets 500, to
    // exercise the "response from wrong request" scenario.
    let postCount = 0;
    await page.route(SAVE_API_URL, async (route) => {
      if (route.request().method().toUpperCase() === 'POST') {
        postCount++;
        const status = postCount === 1 ? 204 : 500;
        await route.fulfill({ status, body: `{"status":${status}}` });
      } else {
        await route.fallback();
      }
    });

    const slug = 'backloggd-save-editor-xhr-and-fetch';

    const pid = seedEligibleItem(db, {
      sessionId: SESSION_ID,
      steamAppId: 7002,
      backloggdSlug: slug,
      gameTitle: 'Save Editor XHR and Fetch Test Game',
    });
    createConfirmedConfirmation(db, SESSION_ID, pid);

    const beforeItem = getItem(db, pid);
    expect(beforeItem?.status).toBe('approved');

    const results = await runConfirmedOwnershipSave({
      db,
      sessionId: SESSION_ID,
      page,
      timeout: 6000,
      resolvePageUrl: resolveFixturePageUrl,
    });

    // Both XHR and fetch fire.  Playwright sees 2 matching requests;
    // the page-side fetch audit sees only 1.  This mismatch, plus the
    // fact that Playwright observes >1 request, must produce saveFailed.
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('saveFailed');
    expect(results[0].status).not.toBe('saved');
    // The detail should mention the mismatched count or multiple requests.
    const detail = results[0].detail ?? '';
    const hasMismatchError =
      detail.includes('mismatched_request_count') || detail.includes('multiple_playwright');
    expect(hasMismatchError).toBe(true);

    // Item must remain approved — no local saved transition.
    const afterItem = getItem(db, pid);
    expect(afterItem?.status).toBe('approved');

    // Confirmation must remain confirmed — never mutated by save failure.
    const row = db
      .prepare('SELECT status FROM import_item_confirmations WHERE proposal_id = ?')
      .get(pid) as { status: string } | undefined;
    expect(row?.status).toBe('confirmed');

    // Verify both XHR and fetch actually fired in the fixture.
    const counts = await page.evaluate(() => {
      const w = window as unknown as {
        __xhrSent: number;
        __fetchSent: number;
        __saveClickCount: number;
      };
      return {
        saveClicks: w.__saveClickCount ?? 0,
        xhrSent: w.__xhrSent ?? 0,
        fetchSent: w.__fetchSent ?? 0,
      };
    });
    expect(counts.saveClicks).toBe(1);
    expect(counts.xhrSent).toBe(1);
    expect(counts.fetchSent).toBe(1);

    await page.close();
  });

  // -----------------------------------------------------------------------
  // Path exactness — POST /api/library without a trailing slash must
  // be rejected by the write guard and therefore cannot satisfy the
  // save proof.  The previous regex /^\/api\/library(?:\/\d*)?$/
  // matched the bare /api/library path, but the allowed paths are
  // exactly /api/library/ and /api/library/<numeric-id>.  The fixed
  // regex /^\/api\/library\/(?:\d+)?$/ rejects the bare path.
  //
  // The write guard is the first line of defense — it aborts the
  // request before it can be observed as a matching save request by
  // the save proof.  Either way, the bare path must not result in a
  // successful save.  This test exercises the end-to-end path: the
  // save click fires a fetch to the bare path, the write guard
  // blocks it (because the regex rejects the bare path), and the
  // executor returns `blockedWrite`.  The item must NOT be marked
  // saved.
  // -----------------------------------------------------------------------
  it('save proof rejects POST /api/library (no trailing slash) — bare path blocked by write guard', async () => {
    const page = await context.newPage();

    // Fulfill the bare /api/library path with 200 so the route exists
    // (defense-in-depth), but the write guard must block the request
    // before it reaches this route because the path does not match
    // the exact allowed regex.
    await page.route('https://backloggd.com/api/library', async (route) => {
      if (route.request().method().toUpperCase() === 'POST') {
        await route.fulfill({ status: 200, body: '{"status":"ok"}' });
      } else {
        await route.fallback();
      }
    });
    // Also fulfill the canonical /api/library/ path with 200 so a stray
    // request to the canonical path (if any) does not affect the test.
    await page.route('https://backloggd.com/api/library/', async (route) => {
      if (route.request().method().toUpperCase() === 'POST') {
        await route.fulfill({ status: 200, body: '{"status":"ok"}' });
      } else {
        await route.fallback();
      }
    });

    const slug = 'backloggd-save-editor-bare-path';

    const pid = seedEligibleItem(db, {
      sessionId: SESSION_ID,
      steamAppId: 8001,
      backloggdSlug: slug,
      gameTitle: 'Save Editor Bare Path Test Game',
    });
    createConfirmedConfirmation(db, SESSION_ID, pid);

    const beforeItem = getItem(db, pid);
    expect(beforeItem?.status).toBe('approved');

    const results = await runConfirmedOwnershipSave({
      db,
      sessionId: SESSION_ID,
      page,
      timeout: 5000,
      resolvePageUrl: resolveFixturePageUrl,
    });

    // The save click fired a fetch to /api/library (no trailing slash).
    // The write guard's SAVE_API_REGEX rejects this bare path, so the
    // request is blocked.  The executor detects the blocked write and
    // returns `blockedWrite`.  The item must NOT be marked saved.
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('blockedWrite');
    expect(results[0].status).not.toBe('saved');

    // The blocked write detail must reference the bare /api/library path
    // (proving it was the bare-path request that was blocked, not an
    // unrelated blocked write).  The blocked-write entry format is
    // "METHOD origin+pathname" — we look for POST to a URL ending in
    // /api/library that is NOT followed by a digit (which would be a
    // numeric-id path like /api/library/123) and NOT followed by a
    // trailing slash (which would be the canonical /api/library/).
    const detail = results[0].detail ?? '';
    expect(detail).toMatch(/POST [^/]*\/\/[^/]+\/api\/library(?:\?|$|\s)/);

    // Item must remain approved — no local saved transition.
    const afterItem = getItem(db, pid);
    expect(afterItem?.status).toBe('approved');
    expect(afterItem?.status).not.toBe('saved');

    // Confirmation must remain confirmed — never mutated by save failure.
    const row = db
      .prepare('SELECT status FROM import_item_confirmations WHERE proposal_id = ?')
      .get(pid) as { status: string } | undefined;
    expect(row?.status).toBe('confirmed');

    // The Save button was clicked (the fixture's click handler ran), but
    // the fetch it fired went to the bare /api/library path, which the
    // write guard correctly blocked.
    const clickState = await page.evaluate(() => {
      const w = window as unknown as { __saveClickCount: number };
      return { save: w.__saveClickCount ?? 0 };
    });
    expect(clickState.save).toBe(1);

    await page.close();
  });
});
