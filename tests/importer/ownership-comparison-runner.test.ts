/**
 * Tests for the ownership comparison runner (Phase 5B Slice 2).
 *
 * Covers:
 *   1.  Approved exact ownership item becomes `skipped`.
 *   2.  Approved absent ownership item returns to `approved` via reconcileItem.
 *   3.  Conflict result becomes `failed`.
 *   4.  Deterministic unknown result becomes `failed`.
 *   5.  Browser disappearance leaves item `importing`.
 *   6.  Saved/skipped/failed items are not selected or modified.
 *   7.  Status/playlog items are not processed.
 *   8.  Malformed ownership payload becomes `failed`.
 *   9.  Multiple ownership proposals for one game classified independently.
 *   10. Session counters are recalculated.
 *   11. The runner never calls processItem (verified by import analysis).
 *   12. The runner never clicks or mutates Backloggd controls.
 *   13. Write guard not triggered during successful read-only processing.
 *   14. Re-running the slice does not reprocess terminal items.
 *   15. change-needed remains available for Phase 5C.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { getCreateTableSQL } from '../../src/storage/schema.js';
import { runMigrations } from '../../src/storage/database.js';
import { getItem } from '../../src/importer/import-items.js';
import type { ImportItemStatus } from '../../src/importer/import-items.js';
import { runOwnershipComparison } from '../../src/importer/ownership-comparison-runner.js';
import type { OwnershipComparisonRunnerResult } from '../../src/importer/ownership-comparison-runner.js';
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

/**
 * Insert a proposal row directly without ON CONFLICT handling.
 * Uses a simple INSERT — the caller must ensure the key is unique.
 */
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
 * Seed a complete import item (proposal + import_items row) with full control.
 *
 * Ensures the session, game, and proposal rows exist before inserting the
 * import_items row.  Uses separate inserts for proposal and import_items
 * so multiple items for the same (session, appId, kind) do not conflict.
 */
function seedImportItem(
  db: Database.Database,
  overrides: {
    proposalId?: string;
    importSessionId?: string;
    steamAppId?: number;
    proposalKind?: string;
    frozenPayload?: string | null;
    status?: ImportItemStatus;
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

  // Ensure session exists
  const sessionExists = db.prepare('SELECT id FROM import_sessions WHERE id = ?').get(sessionId);
  if (!sessionExists) {
    seedMinimalSession(db, sessionId);
  }

  // Ensure game exists
  const gameTitle = overrides.gameTitle ?? `Game ${appId}`;
  const gameExists = db.prepare('SELECT app_id FROM games WHERE app_id = ?').get(appId);
  if (!gameExists) {
    seedMinimalGame(db, appId, gameTitle);
  } else if (overrides.gameTitle) {
    // Update title if explicitly provided
    db.prepare('UPDATE games SET title = ? WHERE app_id = ?').run(gameTitle, appId);
  }

  // Insert proposal (idempotent on proposal_id PK)
  const existingProposal = db.prepare('SELECT id FROM proposals WHERE id = ?').get(proposalId);
  if (!existingProposal) {
    insertProposal(db, {
      id: proposalId,
      importSessionId: sessionId,
      steamAppId: appId,
      proposalKind: kind,
      status: 'approved',
      suggestedPayload: overrides.frozenPayload ?? STEAM_DIGITAL_PAYLOAD,
      backloggdSlug: overrides.backloggdSlug ?? null,
    });
  }

  // Insert import_item (idempotent on proposal_id PK)
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
    overrides.frozenPayload ?? STEAM_DIGITAL_PAYLOAD,
    status,
    overrides.attemptCount ?? 0,
    overrides.outcomeReason ?? null,
    overrides.lastError ?? null,
  );

  return proposalId;
}

function fixtureUrl(fileName: string): string {
  return `file://${FIXTURES_DIR}/${fileName}`;
}

/**
 * Resolve a slug to a fixture URL.  The slug is expected to match the fixture
 * filename stem (e.g. slug "backloggd-ownership-steam-digital-present" maps to
 * "fixtures/backloggd-ownership-steam-digital-present.html").
 */
function resolveFixturePageUrl(slug: string): string {
  return fixtureUrl(`${slug}.html`);
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('ownership-comparison-runner', () => {
  let browser: Browser;
  let context: BrowserContext;
  let db: Database.Database;

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
    seedMinimalSession(db);
  });

  // -----------------------------------------------------------------------
  // Helper to run the runner for a single scenario
  // -----------------------------------------------------------------------

  async function runForFixture(
    fixtureFileName: string,
    gameTitle: string,
    gameAppId: number,
    items: {
      proposalId?: string;
      frozenPayload?: string | null;
      proposalKind?: string;
      status?: ImportItemStatus;
    }[],
  ): Promise<{
    result: OwnershipComparisonRunnerResult;
    page: Page;
    proposalIds: string[];
  }> {
    const page = await context.newPage();
    await installWriteGuard(page);

    const proposalIds: string[] = [];

    for (const itemDef of items) {
      const pid = itemDef.proposalId ?? randomUUID();
      proposalIds.push(pid);

      // Seed import item with matching slug for fixture resolution
      const slug = fixtureFileName.replace(/\.html$/i, '');
      seedImportItem(db, {
        proposalId: pid,
        steamAppId: gameAppId,
        proposalKind: itemDef.proposalKind ?? 'ownership',
        frozenPayload: itemDef.frozenPayload ?? STEAM_DIGITAL_PAYLOAD,
        status: itemDef.status ?? 'approved',
        backloggdSlug: slug,
        gameTitle,
      });
    }

    const result = await runOwnershipComparison({
      db,
      sessionId: 'test-session',
      page,
      timeout: 2000,
      resolvePageUrl: resolveFixturePageUrl,
    });

    return { result, page, proposalIds };
  }

  // ===================================================================
  //  1. Approved exact ownership → skipped
  // ===================================================================

  it('marks exact ownership match as skipped with already-present:ownership', async () => {
    const { result, page, proposalIds } = await runForFixture(
      'backloggd-ownership-steam-digital-present.html',
      'Team Fortress 2',
      440,
      [{ frozenPayload: STEAM_DIGITAL_PAYLOAD }],
    );

    expect(result.processed).toBe(1);
    expect(result.alreadyPresent).toBe(1);
    expect(result.changeNeeded).toBe(0);
    expect(result.conflict).toBe(0);
    expect(result.unknown).toBe(0);
    expect(result.leftImporting).toBe(0);
    expect(result.malformed).toBe(0);

    const item = getItem(db, proposalIds[0]);
    expect(item?.status).toBe('skipped');
    expect(item?.outcomeReason).toBe('already-present:ownership');

    await page.close();
  });

  // ===================================================================
  //  2. Approved absent ownership → approved via reconcileItem
  // ===================================================================

  it('returns approved with reconcileItem when ownership change is needed', async () => {
    const { result, page, proposalIds } = await runForFixture(
      'backloggd-ownership-other-platforms.html',
      'BioShock',
      730,
      [{ frozenPayload: STEAM_DIGITAL_PAYLOAD }],
    );

    expect(result.processed).toBe(1);
    expect(result.alreadyPresent).toBe(0);
    expect(result.changeNeeded).toBe(1);
    expect(result.conflict).toBe(0);
    expect(result.unknown).toBe(0);
    expect(result.leftImporting).toBe(0);
    expect(result.malformed).toBe(0);

    const item = getItem(db, proposalIds[0]);
    // reconcileItem moves importing → approved
    expect(item?.status).toBe('approved');
    expect(item?.outcomeReason).toContain('reconciled:absent:ownership-change-needed');
    expect(item?.outcomeReason).toContain('checkedAt=');

    await page.close();
  });

  it('returns approved with reconcileItem for empty library with unique add control', async () => {
    const { result, page, proposalIds } = await runForFixture(
      'backloggd-ownership-empty.html',
      'Half-Life 2',
      220,
      [{ frozenPayload: STEAM_DIGITAL_PAYLOAD }],
    );

    expect(result.processed).toBe(1);
    expect(result.changeNeeded).toBe(1);

    const item = getItem(db, proposalIds[0]);
    expect(item?.status).toBe('approved');
    expect(item?.outcomeReason).toContain('reconciled:absent:ownership-change-needed');

    await page.close();
  });

  // ===================================================================
  //  3. Conflict → failed
  // ===================================================================

  it('marks conflicting ownership as failed', async () => {
    const { result, page, proposalIds } = await runForFixture(
      'backloggd-ownership-steam-conflict.html',
      'Doom',
      730,
      [{ frozenPayload: STEAM_DIGITAL_PAYLOAD }],
    );

    expect(result.processed).toBe(1);
    expect(result.alreadyPresent).toBe(0);
    expect(result.changeNeeded).toBe(0);
    expect(result.conflict).toBe(1);
    expect(result.unknown).toBe(0);

    const item = getItem(db, proposalIds[0]);
    expect(item?.status).toBe('failed');
    expect(item?.outcomeReason).toContain('conflict:ownership:');
    expect(item?.lastError).toContain('Conflict');

    await page.close();
  });

  // ===================================================================
  //  4. Deterministic unknown → failed
  // ===================================================================

  it('marks unsupported read as failed with unknown:ownership:', async () => {
    const { result, page, proposalIds } = await runForFixture(
      'backloggd-ownership-generic.html',
      'Portal 2',
      620,
      [{ frozenPayload: STEAM_DIGITAL_PAYLOAD }],
    );

    expect(result.processed).toBe(1);
    expect(result.alreadyPresent).toBe(0);
    expect(result.changeNeeded).toBe(0);
    expect(result.unknown).toBe(1);

    const item = getItem(db, proposalIds[0]);
    expect(item?.status).toBe('failed');
    expect(item?.outcomeReason).toContain('unknown:ownership:');

    await page.close();
  });

  it('stops after login blocker and leaves later approved rows retryable', async () => {
    const page = await context.newPage();
    await installWriteGuard(page);

    const alreadyPresentPid = randomUUID();
    seedImportItem(db, {
      proposalId: alreadyPresentPid,
      steamAppId: 100,
      frozenPayload: STEAM_DIGITAL_PAYLOAD,
      status: 'approved',
      backloggdSlug: 'backloggd-ownership-steam-digital-present',
      gameTitle: 'Team Fortress 2',
    });

    const loginBlockedPid = randomUUID();
    seedImportItem(db, {
      proposalId: loginBlockedPid,
      steamAppId: 200,
      frozenPayload: STEAM_DIGITAL_PAYLOAD,
      status: 'approved',
      backloggdSlug: 'backloggd-login-page',
      gameTitle: 'Blocked Page',
    });

    const unprocessedPid = randomUUID();
    seedImportItem(db, {
      proposalId: unprocessedPid,
      steamAppId: 300,
      frozenPayload: STEAM_DIGITAL_PAYLOAD,
      status: 'approved',
      backloggdSlug: 'backloggd-ownership-other-platforms',
      gameTitle: 'BioShock',
    });

    const result = await runOwnershipComparison({
      db,
      sessionId: 'test-session',
      page,
      timeout: 2000,
      resolvePageUrl: resolveFixturePageUrl,
    });

    expect(result.sessionBlocker).toBe('login');
    expect(result.alreadyPresent).toBe(1);
    expect(result.unknown).toBe(1);
    expect(result.leftImporting).toBe(0);

    expect(getItem(db, alreadyPresentPid)?.status).toBe('skipped');
    expect(getItem(db, alreadyPresentPid)?.outcomeReason).toBe('already-present:ownership');
    expect(getItem(db, loginBlockedPid)?.status).toBe('failed');
    expect(getItem(db, loginBlockedPid)?.outcomeReason).toBe('unknown:ownership:page-type:login');
    expect(getItem(db, unprocessedPid)?.status).toBe('approved');
    expect(getItem(db, unprocessedPid)?.outcomeReason).toBeNull();

    await page.close();
  });

  it.each([
    ['challenge', 'backloggd-challenge-page'] as const,
    ['rate-limit', 'backloggd-rate-limit-page'] as const,
  ])('stops after %s blocker and leaves later approved rows retryable', async (pageType, slug) => {
    const page = await context.newPage();
    await installWriteGuard(page);

    const blockedPid = randomUUID();
    seedImportItem(db, {
      proposalId: blockedPid,
      steamAppId: 210,
      frozenPayload: STEAM_DIGITAL_PAYLOAD,
      status: 'approved',
      backloggdSlug: slug,
      gameTitle: 'Blocked Page',
    });

    const unprocessedPid = randomUUID();
    seedImportItem(db, {
      proposalId: unprocessedPid,
      steamAppId: 310,
      frozenPayload: STEAM_DIGITAL_PAYLOAD,
      status: 'approved',
      backloggdSlug: 'backloggd-ownership-other-platforms',
      gameTitle: 'BioShock',
    });

    const result = await runOwnershipComparison({
      db,
      sessionId: 'test-session',
      page,
      timeout: 2000,
      resolvePageUrl: resolveFixturePageUrl,
    });

    expect(result.sessionBlocker).toBe(pageType);
    expect(result.unknown).toBe(1);
    expect(result.leftImporting).toBe(0);

    expect(getItem(db, blockedPid)?.status).toBe('failed');
    expect(getItem(db, blockedPid)?.outcomeReason).toBe(`unknown:ownership:page-type:${pageType}`);
    expect(getItem(db, unprocessedPid)?.status).toBe('approved');
    expect(getItem(db, unprocessedPid)?.outcomeReason).toBeNull();

    await page.close();
  });

  // ===================================================================
  //  5. Browser disappearance → importing left
  // ===================================================================

  it('leaves item importing when page disappears before read', async () => {
    const page = await context.newPage();
    await installWriteGuard(page);

    const proposalId = randomUUID();
    seedImportItem(db, {
      proposalId,
      steamAppId: 730,
      frozenPayload: STEAM_DIGITAL_PAYLOAD,
      status: 'approved',
      backloggdSlug: 'backloggd-ownership-steam-digital-present',
    });

    // Close the page before the runner can use it
    await page.close();

    const result = await runOwnershipComparison({
      db,
      sessionId: 'test-session',
      page,
      timeout: 2000,
      resolvePageUrl: resolveFixturePageUrl,
    });

    // The runner tried to navigate/read on a closed page → error caught
    expect(result.processed).toBe(0);
    expect(result.leftImporting).toBe(1);

    const item = getItem(db, proposalId);
    // Transitioned approved → importing before the read attempt
    expect(item?.status).toBe('importing');
  });

  // ===================================================================
  //  6. Terminal items not selected
  // ===================================================================

  it('does not select saved/skipped/failed items', async () => {
    // Use distinct appIds to avoid proposal unique-key conflicts
    const savedPid = seedImportItem(db, {
      steamAppId: 440,
      status: 'saved',
      frozenPayload: STEAM_DIGITAL_PAYLOAD,
    });
    const skippedPid = seedImportItem(db, {
      steamAppId: 441,
      status: 'skipped',
      frozenPayload: STEAM_DIGITAL_PAYLOAD,
    });
    const failedPid = seedImportItem(db, {
      steamAppId: 442,
      status: 'failed',
      frozenPayload: STEAM_DIGITAL_PAYLOAD,
    });

    // Also create an approved ownership item with a compatible fixture
    // Use a distinct steamAppId (443) to avoid the proposals unique constraint
    const approvedPid = randomUUID();
    seedImportItem(db, {
      proposalId: approvedPid,
      steamAppId: 443,
      frozenPayload: STEAM_DIGITAL_PAYLOAD,
      status: 'approved',
      backloggdSlug: 'backloggd-ownership-steam-digital-present',
      gameTitle: 'Team Fortress 2',
    });

    const page = await context.newPage();
    await installWriteGuard(page);

    const result = await runOwnershipComparison({
      db,
      sessionId: 'test-session',
      page,
      timeout: 2000,
      resolvePageUrl: resolveFixturePageUrl,
    });

    // Only the approved item should be processed
    expect(result.processed).toBe(1);

    // Terminal items remain unchanged
    expect(getItem(db, savedPid)?.status).toBe('saved');
    expect(getItem(db, skippedPid)?.status).toBe('skipped');
    expect(getItem(db, failedPid)?.status).toBe('failed');

    await page.close();
  });

  // ===================================================================
  //  7. Non-ownership items not processed
  // ===================================================================

  it('does not process status or playlog items', async () => {
    const statusPid = randomUUID();
    seedImportItem(db, {
      proposalId: statusPid,
      steamAppId: 440,
      proposalKind: 'status',
      frozenPayload: '{"status":"playing"}',
      status: 'approved',
    });

    const playlogPid = randomUUID();
    seedImportItem(db, {
      proposalId: playlogPid,
      steamAppId: 441,
      proposalKind: 'playlog',
      frozenPayload: '{"hours":10}',
      status: 'approved',
    });

    const page = await context.newPage();
    await installWriteGuard(page);

    const result = await runOwnershipComparison({
      db,
      sessionId: 'test-session',
      page,
      timeout: 2000,
      resolvePageUrl: resolveFixturePageUrl,
    });

    // No ownership items → nothing processed
    expect(result.processed).toBe(0);
    expect(result.unsupportedKind).toBe(2);

    // Status and playlog items remain approved
    expect(getItem(db, statusPid)?.status).toBe('approved');
    expect(getItem(db, playlogPid)?.status).toBe('approved');

    await page.close();
  });

  // ===================================================================
  //  8. Malformed payload → failed
  // ===================================================================

  it('marks empty-object frozenPayload as malformed', async () => {
    const { result, page, proposalIds } = await runForFixture(
      'backloggd-ownership-steam-digital-present.html',
      'Team Fortress 2',
      440,
      [{ frozenPayload: '{}' }],
    );

    expect(result.malformed).toBe(1);
    expect(result.processed).toBe(0);

    const item = getItem(db, proposalIds[0]);
    expect(item?.status).toBe('failed');
    expect(item?.outcomeReason).toContain('malformed:ownership:invalid-payload');

    await page.close();
  });

  it('marks payload missing ownershipType as malformed', async () => {
    const { result, page, proposalIds } = await runForFixture(
      'backloggd-ownership-steam-digital-present.html',
      'Team Fortress 2',
      440,
      [{ frozenPayload: '{"platform":"steam"}' }],
    );

    expect(result.malformed).toBe(1);

    const item = getItem(db, proposalIds[0]);
    expect(item?.status).toBe('failed');
    expect(item?.outcomeReason).toContain('malformed:ownership:invalid-payload');

    await page.close();
  });

  it('marks non-JSON payload as malformed', async () => {
    const { result, page, proposalIds } = await runForFixture(
      'backloggd-ownership-steam-digital-present.html',
      'Team Fortress 2',
      440,
      [{ frozenPayload: 'not-json' }],
    );

    expect(result.malformed).toBe(1);

    const item = getItem(db, proposalIds[0]);
    expect(item?.status).toBe('failed');
    expect(item?.outcomeReason).toContain('malformed:ownership:invalid-payload');

    await page.close();
  });

  // ===================================================================
  //  9. Multiple proposals for one game classified independently
  // ===================================================================

  it('classifies multiple ownership proposals for one game independently', async () => {
    const page = await context.newPage();
    await installWriteGuard(page);

    // Two ownership proposals pointing at the same Backloggd fixture via the
    // same slug.  Each has its own steamAppId to satisfy the proposals-table
    // unique index on (import_session_id, steam_app_id, proposal_kind).
    //
    // The runner groups by steamAppId so these will get separate page reads,
    // but both loads target the same fixture URL so the read result is
    // identical — verifying that each proposal is classified independently.
    //
    // Both proposals match the visible Steam/Digital entry, so both should
    // receive `already-present` — but independently, without one item's
    // result masking the other.
    const pid1 = randomUUID();
    const pid2 = randomUUID();

    const slug = 'backloggd-ownership-steam-digital-present';
    seedImportItem(db, {
      proposalId: pid1,
      steamAppId: 440,
      frozenPayload: STEAM_DIGITAL_PAYLOAD,
      status: 'approved',
      backloggdSlug: slug,
      gameTitle: 'Team Fortress 2',
    });

    seedImportItem(db, {
      proposalId: pid2,
      steamAppId: 441,
      frozenPayload: STEAM_DIGITAL_PAYLOAD,
      status: 'approved',
      backloggdSlug: slug,
      gameTitle: 'Team Fortress 2',
    });

    const result = await runOwnershipComparison({
      db,
      sessionId: 'test-session',
      page,
      timeout: 2000,
      resolvePageUrl: resolveFixturePageUrl,
    });

    expect(result.processed).toBe(2);
    expect(result.alreadyPresent).toBe(2);
    expect(result.conflict).toBe(0);

    // Both items: already present → skipped
    const item1 = getItem(db, pid1);
    expect(item1?.status).toBe('skipped');
    expect(item1?.outcomeReason).toBe('already-present:ownership');

    const item2 = getItem(db, pid2);
    expect(item2?.status).toBe('skipped');
    expect(item2?.outcomeReason).toBe('already-present:ownership');

    await page.close();
  });

  // ===================================================================
  //  10. Session counters recalculated
  // ===================================================================

  it('recalculates session counters after processing', async () => {
    const page = await context.newPage();
    await installWriteGuard(page);

    // Seed an item that will be already-present — must match fixture title
    const pid = randomUUID();
    seedImportItem(db, {
      proposalId: pid,
      steamAppId: 440,
      frozenPayload: STEAM_DIGITAL_PAYLOAD,
      status: 'approved',
      backloggdSlug: 'backloggd-ownership-steam-digital-present',
      gameTitle: 'Team Fortress 2',
    });

    // Get counters before
    await runOwnershipComparison({
      db,
      sessionId: 'test-session',
      page,
      timeout: 2000,
      resolvePageUrl: resolveFixturePageUrl,
    });

    // Counters should reflect the skipped item
    const afterCounts = db
      .prepare(
        'SELECT approved_changes, applied_changes, skipped_games, failed_games FROM import_sessions WHERE id = ?',
      )
      .get('test-session') as {
      approved_changes: number;
      applied_changes: number;
      skipped_games: number;
      failed_games: number;
    };

    expect(afterCounts.skipped_games).toBe(1);
    expect(afterCounts.approved_changes).toBe(0);

    await page.close();
  });

  // ===================================================================
  //  11. Runner never calls processItem (module import check)
  // ===================================================================

  it('does not import processItem from the backloggd browser module', async () => {
    // Read the runner source and verify it doesn't import processItem
    const fs = await import('node:fs');
    const source = fs.readFileSync(resolve('src/importer/ownership-comparison-runner.ts'), 'utf-8');
    expect(source).not.toContain('processItem');
    expect(source).not.toContain('click');
    expect(source).not.toContain('fill');
    expect(source).not.toContain('selectOption');
    expect(source).not.toContain('Save');
    expect(source).not.toContain('Submit');
    expect(source).not.toContain('Update');
  });

  // ===================================================================
  //  12. Never clicks or mutates Backloggd controls
  // ===================================================================

  it('does not click, fill, or mutate any controls (proven by write guard)', async () => {
    const result = await runForFixture(
      'backloggd-ownership-steam-digital-present.html',
      'Team Fortress 2',
      440,
      [{ frozenPayload: STEAM_DIGITAL_PAYLOAD }],
    );

    // If any write was attempted, the write guard would have aborted it and
    // the runner or test would have failed.  Successful completion proves
    // no writes.
    expect(result.result.processed).toBe(1);
    expect(result.result.alreadyPresent).toBe(1);

    await result.page.close();
  });

  // ===================================================================
  //  13. Write guard not triggered during successful read-only processing
  // ===================================================================

  it('does not trigger write guard during read-only ownership comparison', async () => {
    // This test uses a custom approach to verify no console output from
    // the write guard (which logs blocked requests).
    const page = await context.newPage();
    await installWriteGuard(page);

    const pid = randomUUID();
    seedImportItem(db, {
      proposalId: pid,
      steamAppId: 440,
      frozenPayload: STEAM_DIGITAL_PAYLOAD,
      status: 'approved',
      backloggdSlug: 'backloggd-ownership-steam-digital-present',
      gameTitle: 'Team Fortress 2',
    });

    // Track console output for write guard messages
    const blockedWrites: string[] = [];
    page.on('console', (msg: { text: () => string }) => {
      if (msg.text().includes('Write guard blocked')) {
        blockedWrites.push(msg.text());
      }
    });

    await runOwnershipComparison({
      db,
      sessionId: 'test-session',
      page,
      timeout: 2000,
      resolvePageUrl: resolveFixturePageUrl,
    });

    expect(blockedWrites).toHaveLength(0);

    await page.close();
  });

  // ===================================================================
  //  14. Re-running does not reprocess terminal items
  // ===================================================================

  it('does not reprocess items that are already terminal', async () => {
    const page = await context.newPage();
    await installWriteGuard(page);

    const pid = randomUUID();
    seedImportItem(db, {
      proposalId: pid,
      steamAppId: 440,
      frozenPayload: STEAM_DIGITAL_PAYLOAD,
      status: 'approved',
      backloggdSlug: 'backloggd-ownership-steam-digital-present',
      gameTitle: 'Team Fortress 2',
    });

    // First run
    const result1 = await runOwnershipComparison({
      db,
      sessionId: 'test-session',
      page,
      timeout: 2000,
      resolvePageUrl: resolveFixturePageUrl,
    });

    expect(result1.processed).toBe(1);

    // Second run — item is now skipped, not approved
    const result2 = await runOwnershipComparison({
      db,
      sessionId: 'test-session',
      page,
      timeout: 2000,
      resolvePageUrl: resolveFixturePageUrl,
    });

    expect(result2.processed).toBe(0);
    expect(result2.alreadyPresent).toBe(0);

    await page.close();
  });

  // ===================================================================
  //  15. change-needed remains available for Phase 5C
  // ===================================================================

  it('does not make change-needed items terminal — they stay approved', async () => {
    const { result, page, proposalIds } = await runForFixture(
      'backloggd-ownership-other-platforms.html',
      'BioShock',
      730,
      [{ frozenPayload: STEAM_DIGITAL_PAYLOAD }],
    );

    expect(result.changeNeeded).toBe(1);

    const item = getItem(db, proposalIds[0]);
    // reconcileItem returns to approved, NOT skipped/saved/failed
    expect(item?.status).toBe('approved');
    // outcomeReason contains the reconciliation proof
    expect(item?.outcomeReason).toContain('reconciled:absent:ownership-change-needed');
    // Not in any terminal state
    expect(item?.status).not.toBe('skipped');
    expect(item?.status).not.toBe('saved');
    expect(item?.status).not.toBe('failed');

    await page.close();
  });

  // ===================================================================
  //  16. Finding 1 — Malformed payload is failed before any page read
  //      Regression: malformed payload with closed page must not leave
  //      item importing.
  // ===================================================================

  it('fails malformed payload as malformed even when page is closed (Finding 1)', async () => {
    const page = await context.newPage();
    await installWriteGuard(page);

    const proposalId = randomUUID();
    seedImportItem(db, {
      proposalId,
      steamAppId: 730,
      frozenPayload: '{}',
      status: 'approved',
      backloggdSlug: 'backloggd-ownership-steam-digital-present',
      gameTitle: 'Counter-Strike',
    });

    // Close the page before running — page read would fail if reached
    await page.close();

    const result = await runOwnershipComparison({
      db,
      sessionId: 'test-session',
      page,
      timeout: 2000,
      resolvePageUrl: resolveFixturePageUrl,
    });

    // Payload is validated before any browser work, so the item is failed
    // as malformed — never attempts page navigation.
    expect(result.malformed).toBe(1);
    expect(result.leftImporting).toBe(0);
    expect(result.processed).toBe(0);

    const item = getItem(db, proposalId);
    expect(item?.status).toBe('failed');
    expect(item?.outcomeReason).toBe('malformed:ownership:invalid-payload');
  });

  // ===================================================================
  //  17. Finding 2 — Canonical proposal metadata mismatch detection
  // ===================================================================

  it('fails item when canonical proposal kind is status, not ownership (Finding 2)', async () => {
    const page = await context.newPage();
    await installWriteGuard(page);

    const proposalId = randomUUID();
    seedImportItem(db, {
      proposalId,
      steamAppId: 440,
      proposalKind: 'ownership',
      frozenPayload: STEAM_DIGITAL_PAYLOAD,
      status: 'approved',
      backloggdSlug: 'backloggd-ownership-steam-digital-present',
      gameTitle: 'Team Fortress 2',
    });

    // Corrupt the canonical proposal's kind to status (simulates stale snapshot)
    db.prepare('UPDATE proposals SET proposal_kind = ? WHERE id = ?').run('status', proposalId);

    const result = await runOwnershipComparison({
      db,
      sessionId: 'test-session',
      page,
      timeout: 2000,
      resolvePageUrl: resolveFixturePageUrl,
    });

    // Must not navigate or read the page
    expect(result.malformed).toBe(1);
    expect(result.processed).toBe(0);
    expect(result.leftImporting).toBe(0);

    const item = getItem(db, proposalId);
    expect(item?.status).toBe('failed');
    expect(item?.outcomeReason).toBe('malformed:ownership:metadata-mismatch');

    await page.close();
  });

  it('fails item when canonical steam_app_id differs from import item (Finding 2)', async () => {
    const page = await context.newPage();
    await installWriteGuard(page);

    const proposalId = randomUUID();
    seedImportItem(db, {
      proposalId,
      steamAppId: 440,
      proposalKind: 'ownership',
      frozenPayload: STEAM_DIGITAL_PAYLOAD,
      status: 'approved',
      backloggdSlug: 'backloggd-ownership-steam-digital-present',
      gameTitle: 'Team Fortress 2',
    });

    // Ensure the FK target game exists before updating steam_app_id
    seedMinimalGame(db, 730, 'Other Game');

    // Change canonical proposal's steam_app_id to a different value
    db.prepare('UPDATE proposals SET steam_app_id = ? WHERE id = ?').run(730, proposalId);

    const result = await runOwnershipComparison({
      db,
      sessionId: 'test-session',
      page,
      timeout: 2000,
      resolvePageUrl: resolveFixturePageUrl,
    });

    // Must not navigate
    expect(result.malformed).toBe(1);
    expect(result.processed).toBe(0);

    const item = getItem(db, proposalId);
    expect(item?.status).toBe('failed');
    expect(item?.outcomeReason).toBe('malformed:ownership:metadata-mismatch');

    await page.close();
  });

  it('fails item when canonical proposal belongs to a different session (Finding 2)', async () => {
    const page = await context.newPage();
    await installWriteGuard(page);

    const proposalId = randomUUID();
    seedImportItem(db, {
      proposalId,
      steamAppId: 440,
      proposalKind: 'ownership',
      frozenPayload: STEAM_DIGITAL_PAYLOAD,
      status: 'approved',
      backloggdSlug: 'backloggd-ownership-steam-digital-present',
      gameTitle: 'Team Fortress 2',
    });

    // Ensure the FK target session exists before updating import_session_id
    seedMinimalSession(db, 'other-session');

    // Move the canonical proposal to a different session
    db.prepare('UPDATE proposals SET import_session_id = ? WHERE id = ?').run(
      'other-session',
      proposalId,
    );

    const result = await runOwnershipComparison({
      db,
      sessionId: 'test-session',
      page,
      timeout: 2000,
      resolvePageUrl: resolveFixturePageUrl,
    });

    // Must not navigate
    expect(result.malformed).toBe(1);
    expect(result.processed).toBe(0);

    const item = getItem(db, proposalId);
    expect(item?.status).toBe('failed');
    expect(item?.outcomeReason).toBe('malformed:ownership:metadata-mismatch');

    await page.close();
  });

  it('processes valid canonical ownership item normally (Finding 2 positive case)', async () => {
    const { result, page, proposalIds } = await runForFixture(
      'backloggd-ownership-steam-digital-present.html',
      'Team Fortress 2',
      440,
      [{ frozenPayload: STEAM_DIGITAL_PAYLOAD }],
    );

    // Valid item should be processed normally (already present → skipped)
    expect(result.processed).toBe(1);
    expect(result.alreadyPresent).toBe(1);
    expect(result.malformed).toBe(0);

    const item = getItem(db, proposalIds[0]);
    expect(item?.status).toBe('skipped');
    expect(item?.outcomeReason).toBe('already-present:ownership');

    await page.close();
  });

  // ===================================================================
  //  21. Finding 1 — Canonical proposal status must be approved
  // ===================================================================

  it('fails item when canonical proposal status is pending (Finding 1)', async () => {
    const page = await context.newPage();
    await installWriteGuard(page);

    const proposalId = randomUUID();
    seedImportItem(db, {
      proposalId,
      steamAppId: 440,
      proposalKind: 'ownership',
      frozenPayload: STEAM_DIGITAL_PAYLOAD,
      status: 'approved',
      backloggdSlug: 'backloggd-ownership-steam-digital-present',
      gameTitle: 'Team Fortress 2',
    });

    // Downgrade canonical proposal status to pending (simulates stale snapshot)
    db.prepare('UPDATE proposals SET status = ? WHERE id = ?').run('pending', proposalId);

    const result = await runOwnershipComparison({
      db,
      sessionId: 'test-session',
      page,
      timeout: 2000,
      resolvePageUrl: resolveFixturePageUrl,
    });

    // Must not navigate or read the page
    expect(result.malformed).toBe(1);
    expect(result.processed).toBe(0);
    expect(result.leftImporting).toBe(0);

    const item = getItem(db, proposalId);
    expect(item?.status).toBe('failed');
    expect(item?.outcomeReason).toBe('malformed:ownership:metadata-mismatch');

    await page.close();
  });

  // ===================================================================
  //  22. Finding 2 — Malformed payload fails before slug lookup (Phase C)
  //      Regression: payload validation in Phase B must not query
  //      backloggd_slug.  A slug-throwing resolver proves Phase C
  //      (page-target lookup) is never reached for malformed items.
  // ===================================================================

  it('does not resolve slug or navigate for malformed payload (Finding 2)', async () => {
    const page = await context.newPage();
    await installWriteGuard(page);

    const proposalId = randomUUID();
    seedImportItem(db, {
      proposalId,
      steamAppId: 440,
      proposalKind: 'ownership',
      frozenPayload: '{}',
      status: 'approved',
      backloggdSlug: 'backloggd-ownership-steam-digital-present',
      gameTitle: 'Team Fortress 2',
    });

    // If the resolver is called, Phase C was reached despite malformed payload.
    const resolverSpy = (): string => {
      throw new Error('Phase C slug resolution was reached for a malformed item');
    };

    const result = await runOwnershipComparison({
      db,
      sessionId: 'test-session',
      page,
      timeout: 2000,
      resolvePageUrl: resolverSpy,
    });

    // Item failed in Phase B — no slug lookup, no resolver call, no navigation.
    expect(result.malformed).toBe(1);
    expect(result.processed).toBe(0);
    expect(result.leftImporting).toBe(0);

    const item = getItem(db, proposalId);
    expect(item?.status).toBe('failed');
    expect(item?.outcomeReason).toBe('malformed:ownership:invalid-payload');

    await page.close();
  });
});
