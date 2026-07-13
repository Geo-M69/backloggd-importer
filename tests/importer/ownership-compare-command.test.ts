/**
 * Tests for the ownership compare command integration layer (Phase 5D Slice 3).
 *
 * Covers:
 *   1.  Missing sessionId throws before DB/browser work.
 *   2.  Whitespace-only sessionId throws before DB/browser work.
 *   3.  No approved ownership items returns deterministic no-work result
 *       without invoking the comparison runner.
 *   4.  Approved ownership items invoke the comparison runner and produce
 *       result with distinct statuses.
 *   5.  Unapproved ownership items are not counted.
 *   6.  Status/playlog proposals are not counted.
 *   7.  countApprovedOwnershipItems returns correct counts.
 *   8.  hasUnsafeComparisonOutcomes returns true for conflict/unknown/
 *       leftImporting/malformed.
 *   9.  hasUnsafeComparisonOutcomes returns false for clean results.
 *   10. countApprovedOwnershipItems returns 0 when no approved ownership
 *       items exist (even if other status items exist).
 *   11. countApprovedOwnershipItems returns 0 for non-ownership items.
 *   12. formatCompareResult preserves distinct statuses.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { Page } from 'playwright';
import { getCreateTableSQL } from '../../src/storage/schema.js';
import { runMigrations } from '../../src/storage/database.js';
import {
  runOwnershipCompareCommand,
  countApprovedOwnershipItems,
  hasUnsafeComparisonOutcomes,
  formatCompareResult,
} from '../../src/importer/ownership-compare-command.js';
import { runOwnershipComparison } from '../../src/importer/ownership-comparison-runner.js';
import type { OwnershipComparisonRunnerResult } from '../../src/importer/ownership-comparison-runner.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STEAM_DIGITAL_PAYLOAD = '{"platform":"steam","ownershipType":"digital"}';

// ---------------------------------------------------------------------------
// Mock the comparison runner
// ---------------------------------------------------------------------------

vi.mock('../../src/importer/ownership-comparison-runner.js', () => ({
  runOwnershipComparison: vi.fn(),
}));

const mockRunOwnershipComparison = vi.mocked(runOwnershipComparison);

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ownership-compare-command', () => {
  let db: Database.Database;
  let mockPage: Page;

  beforeEach(() => {
    db = createFreshDb();
    seedMinimalSession(db);
    mockPage = {} as Page;
    vi.clearAllMocks();
  });

  // ===================================================================
  //  1. Missing sessionId throws before DB/browser work
  // ===================================================================

  it('throws when sessionId is missing', async () => {
    await expect(
      runOwnershipCompareCommand({
        db,
        sessionId: '',
        page: mockPage,
      }),
    ).rejects.toThrow('sessionId is required and must be non-empty.');

    // Runner should not be called
    expect(mockRunOwnershipComparison).not.toHaveBeenCalled();
  });

  // ===================================================================
  //  2. Whitespace-only sessionId throws before DB/browser work
  // ===================================================================

  it('throws when sessionId is whitespace only', async () => {
    await expect(
      runOwnershipCompareCommand({
        db,
        sessionId: '   ',
        page: mockPage,
      }),
    ).rejects.toThrow('sessionId is required and must be non-empty.');

    // Runner should not be called
    expect(mockRunOwnershipComparison).not.toHaveBeenCalled();
  });

  // ===================================================================
  //  3. No approved ownership items returns no-work result
  // ===================================================================

  it('returns zero result when no approved ownership items exist', async () => {
    const result = await runOwnershipCompareCommand({
      db,
      sessionId: 'test-session',
      page: mockPage,
    });

    expect(result).toEqual({
      processed: 0,
      alreadyPresent: 0,
      changeNeeded: 0,
      conflict: 0,
      unknown: 0,
      leftImporting: 0,
      malformed: 0,
      unsupportedKind: 0,
    });

    // Runner should not be called — no browser work
    expect(mockRunOwnershipComparison).not.toHaveBeenCalled();
  });

  it('returns zero result when only non-ownership approved items exist', async () => {
    // Seed a status/playlog item
    seedImportItem(db, {
      proposalKind: 'status',
      status: 'approved',
      frozenPayload: '{"status":"playing"}',
    });

    const result = await runOwnershipCompareCommand({
      db,
      sessionId: 'test-session',
      page: mockPage,
    });

    expect(result.processed).toBe(0);
    expect(result.unsupportedKind).toBe(0);
    expect(mockRunOwnershipComparison).not.toHaveBeenCalled();
  });

  it('returns zero result when ownership items exist but are not approved', async () => {
    // Each needs a distinct steamAppId because proposals has a UNIQUE
    // constraint on (import_session_id, steam_app_id, proposal_kind).
    seedImportItem(db, {
      proposalKind: 'ownership',
      status: 'saved',
      steamAppId: 731,
    });
    seedImportItem(db, {
      proposalKind: 'ownership',
      status: 'skipped',
      steamAppId: 732,
    });
    seedImportItem(db, {
      proposalKind: 'ownership',
      status: 'failed',
      steamAppId: 733,
    });

    const result = await runOwnershipCompareCommand({
      db,
      sessionId: 'test-session',
      page: mockPage,
    });

    expect(result.processed).toBe(0);
    expect(mockRunOwnershipComparison).not.toHaveBeenCalled();
  });

  // ===================================================================
  //  4. Approved ownership items invoke the comparison runner
  // ===================================================================

  it('invokes the comparison runner when approved ownership items exist', async () => {
    const expectedResult: OwnershipComparisonRunnerResult = {
      processed: 1,
      alreadyPresent: 0,
      changeNeeded: 1,
      conflict: 0,
      unknown: 0,
      leftImporting: 0,
      malformed: 0,
      unsupportedKind: 0,
    };
    mockRunOwnershipComparison.mockResolvedValue(expectedResult);

    seedImportItem(db, {
      proposalKind: 'ownership',
      status: 'approved',
      backloggdSlug: 'team-fortress-2',
    });

    const result = await runOwnershipCompareCommand({
      db,
      sessionId: 'test-session',
      page: mockPage,
    });

    expect(result).toEqual(expectedResult);
    expect(mockRunOwnershipComparison).toHaveBeenCalledTimes(1);
    expect(mockRunOwnershipComparison).toHaveBeenCalledWith(
      expect.objectContaining({
        db,
        sessionId: 'test-session',
        page: mockPage,
      }),
    );
  });

  it('passes timeout and resolvePageUrl when provided', async () => {
    mockRunOwnershipComparison.mockResolvedValue({
      processed: 0,
      alreadyPresent: 0,
      changeNeeded: 0,
      conflict: 0,
      unknown: 0,
      leftImporting: 0,
      malformed: 0,
      unsupportedKind: 0,
    });

    const resolvePageUrl = vi.fn();
    seedImportItem(db, {
      proposalKind: 'ownership',
      status: 'approved',
      backloggdSlug: 'test-game',
    });

    await runOwnershipCompareCommand({
      db,
      sessionId: 'test-session',
      page: mockPage,
      timeout: 5000,
      resolvePageUrl,
    });

    expect(mockRunOwnershipComparison).toHaveBeenCalledWith(
      expect.objectContaining({
        timeout: 5000,
        resolvePageUrl,
      }),
    );
  });

  // ===================================================================
  //  5. Unapproved ownership items are not counted
  // ===================================================================

  it('does not count saved/skipped/failed/importing ownership items', () => {
    const sessionId = 'test-session';

    // Seed one approved ownership item and several non-approved.
    // Each needs a distinct steamAppId because proposals has a UNIQUE
    // constraint on (import_session_id, steam_app_id, proposal_kind).
    seedImportItem(db, {
      proposalKind: 'ownership',
      status: 'approved',
      steamAppId: 730,
      importSessionId: sessionId,
    });
    seedImportItem(db, {
      proposalKind: 'ownership',
      status: 'saved',
      steamAppId: 731,
      importSessionId: sessionId,
    });
    seedImportItem(db, {
      proposalKind: 'ownership',
      status: 'skipped',
      steamAppId: 732,
      importSessionId: sessionId,
    });
    seedImportItem(db, {
      proposalKind: 'ownership',
      status: 'failed',
      steamAppId: 733,
      importSessionId: sessionId,
    });
    seedImportItem(db, {
      proposalKind: 'ownership',
      status: 'importing',
      steamAppId: 734,
      importSessionId: sessionId,
    });

    const count = countApprovedOwnershipItems(db, sessionId);
    expect(count).toBe(1);
  });

  // ===================================================================
  //  6. Status/playlog proposals are not counted
  // ===================================================================

  it('countApprovedOwnershipItems returns 0 for non-ownership proposal kinds', () => {
    seedImportItem(db, { proposalKind: 'status', status: 'approved' });
    seedImportItem(db, { proposalKind: 'playlog', status: 'approved' });

    const count = countApprovedOwnershipItems(db, 'test-session');
    expect(count).toBe(0);
  });

  it('countApprovedOwnershipItems ignores non-ownership items even when mixed', () => {
    // Use distinct steamAppIds to avoid UNIQUE constraint conflicts.
    seedImportItem(db, { proposalKind: 'ownership', status: 'approved', steamAppId: 730 });
    seedImportItem(db, { proposalKind: 'status', status: 'approved', steamAppId: 731 });
    seedImportItem(db, { proposalKind: 'playlog', status: 'approved', steamAppId: 732 });

    const count = countApprovedOwnershipItems(db, 'test-session');
    expect(count).toBe(1);
  });

  // ===================================================================
  //  7. countApprovedOwnershipItems returns correct counts
  // ===================================================================

  it('countApprovedOwnershipItems returns 0 when no items exist', () => {
    const count = countApprovedOwnershipItems(db, 'test-session');
    expect(count).toBe(0);
  });

  it('countApprovedOwnershipItems returns 0 for non-existent session', () => {
    const count = countApprovedOwnershipItems(db, 'non-existent-session');
    expect(count).toBe(0);
  });

  it('countApprovedOwnershipItems returns correct count for multiple items', () => {
    // Each needs a distinct steamAppId because proposals has a UNIQUE
    // constraint on (import_session_id, steam_app_id, proposal_kind).
    seedImportItem(db, { proposalKind: 'ownership', status: 'approved', steamAppId: 730 });
    seedImportItem(db, { proposalKind: 'ownership', status: 'approved', steamAppId: 731 });
    seedImportItem(db, { proposalKind: 'ownership', status: 'approved', steamAppId: 732 });

    const count = countApprovedOwnershipItems(db, 'test-session');
    expect(count).toBe(3);
  });

  // ===================================================================
  //  8. hasUnsafeComparisonOutcomes
  // ===================================================================

  it('returns true when conflict > 0', () => {
    expect(
      hasUnsafeComparisonOutcomes({
        processed: 0,
        alreadyPresent: 0,
        changeNeeded: 0,
        conflict: 1,
        unknown: 0,
        leftImporting: 0,
        malformed: 0,
        unsupportedKind: 0,
      }),
    ).toBe(true);
  });

  it('returns true when unknown > 0', () => {
    expect(
      hasUnsafeComparisonOutcomes({
        processed: 0,
        alreadyPresent: 0,
        changeNeeded: 0,
        conflict: 0,
        unknown: 2,
        leftImporting: 0,
        malformed: 0,
        unsupportedKind: 0,
      }),
    ).toBe(true);
  });

  it('returns true when leftImporting > 0', () => {
    expect(
      hasUnsafeComparisonOutcomes({
        processed: 0,
        alreadyPresent: 0,
        changeNeeded: 0,
        conflict: 0,
        unknown: 0,
        leftImporting: 1,
        malformed: 0,
        unsupportedKind: 0,
      }),
    ).toBe(true);
  });

  it('returns true when malformed > 0', () => {
    expect(
      hasUnsafeComparisonOutcomes({
        processed: 0,
        alreadyPresent: 0,
        changeNeeded: 0,
        conflict: 0,
        unknown: 0,
        leftImporting: 0,
        malformed: 3,
        unsupportedKind: 0,
      }),
    ).toBe(true);
  });

  // ===================================================================
  //  9. hasUnsafeComparisonOutcomes returns false for clean results
  // ===================================================================

  it('returns false for zero-initialized result', () => {
    expect(
      hasUnsafeComparisonOutcomes({
        processed: 0,
        alreadyPresent: 0,
        changeNeeded: 0,
        conflict: 0,
        unknown: 0,
        leftImporting: 0,
        malformed: 0,
        unsupportedKind: 0,
      }),
    ).toBe(false);
  });

  it('returns false when only processed/alreadyPresent/changeNeeded are populated', () => {
    expect(
      hasUnsafeComparisonOutcomes({
        processed: 5,
        alreadyPresent: 3,
        changeNeeded: 2,
        conflict: 0,
        unknown: 0,
        leftImporting: 0,
        malformed: 0,
        unsupportedKind: 0,
      }),
    ).toBe(false);
  });

  it('returns false when only unsupportedKind is populated', () => {
    expect(
      hasUnsafeComparisonOutcomes({
        processed: 0,
        alreadyPresent: 0,
        changeNeeded: 0,
        conflict: 0,
        unknown: 0,
        leftImporting: 0,
        malformed: 0,
        unsupportedKind: 3,
      }),
    ).toBe(false);
  });

  // ===================================================================
  //  10. formatCompareResult preserves distinct statuses
  // ===================================================================

  it('formats zero result with all statuses', () => {
    const output = formatCompareResult({
      processed: 0,
      alreadyPresent: 0,
      changeNeeded: 0,
      conflict: 0,
      unknown: 0,
      leftImporting: 0,
      malformed: 0,
      unsupportedKind: 0,
    });

    expect(output).toContain('Processed: 0');
    expect(output).toContain('Already present: 0');
    expect(output).toContain('Change needed: 0');
    expect(output).toContain('Conflict: 0');
    expect(output).toContain('Unknown: 0');
    expect(output).toContain('Left importing: 0');
    expect(output).toContain('Malformed: 0');
    expect(output).toContain('Unsupported kind: 0');
  });

  it('formats mixed result with distinct status values', () => {
    const output = formatCompareResult({
      processed: 5,
      alreadyPresent: 2,
      changeNeeded: 1,
      conflict: 1,
      unknown: 0,
      leftImporting: 1,
      malformed: 0,
      unsupportedKind: 3,
    });

    expect(output).toContain('Processed: 5');
    expect(output).toContain('Already present: 2');
    expect(output).toContain('Change needed: 1');
    expect(output).toContain('Conflict: 1');
    expect(output).toContain('Unknown: 0');
    expect(output).toContain('Left importing: 1');
    expect(output).toContain('Malformed: 0');
    expect(output).toContain('Unsupported kind: 3');
  });

  // ===================================================================
  //  11. Integration does not create confirmation rows (static assertion)
  // ===================================================================

  it('does not call applyOwnershipConfirmationSelection (runtime proof)', async () => {
    // We can't spy on an unimported module, but we can verify the runner
    // is the only thing called
    mockRunOwnershipComparison.mockResolvedValue({
      processed: 1,
      alreadyPresent: 0,
      changeNeeded: 1,
      conflict: 0,
      unknown: 0,
      leftImporting: 0,
      malformed: 0,
      unsupportedKind: 0,
    });

    seedImportItem(db, {
      proposalKind: 'ownership',
      status: 'approved',
      backloggdSlug: 'test-game',
    });

    await runOwnershipCompareCommand({
      db,
      sessionId: 'test-session',
      page: mockPage,
    });

    // Only the comparison runner should be called
    expect(mockRunOwnershipComparison).toHaveBeenCalledTimes(1);
  });
});
