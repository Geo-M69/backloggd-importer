/**
 * Tests for the ownership save plan builder (Phase 5C Slice 1).
 *
 * Covers:
 *   1.  Eligible approved ownership item with valid absent proof appears in plan.
 *   2.  Approved ownership item without absent proof is excluded.
 *   3.  Approved ownership item with invalid absent proof timestamp is excluded.
 *   4.  Approved ownership item with empty absent proof reason is excluded.
 *   5.  `already-present`/skipped item is excluded.
 *   6.  `saved` item is excluded.
 *   7.  `failed` item is excluded.
 *   8.  `importing` item is excluded.
 *   9.  Status/playlog items are excluded.
 *   10. Malformed frozen payload is excluded.
 *   11. Canonical proposal kind mismatch is excluded.
 *   12. Canonical proposal status not approved is excluded.
 *   13. Canonical Steam AppID mismatch is excluded.
 *   14. Canonical session mismatch is excluded.
 *   15. Multiple eligible ownership items are sorted deterministically.
 *   16. Planner does not mutate item statuses.
 *   17. Planner does not import browser/Playwright modules (static + runtime).
 *   18. Planner output contains enough human-readable detail for a later
 *       confirmation prompt.
 *   19. Counts correctly report eligible and excluded categories.
 *   20. Re-running the planner is idempotent.
 *   21. Absent proof reason containing `:checkedAt=` is excluded.
 *   22. Canonical backloggd_slug must be nonempty (null/whitespace excluded).
 *   23. Missing game title with valid slug is still eligible.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getCreateTableSQL } from '../../src/storage/schema.js';
import { runMigrations } from '../../src/storage/database.js';
import { getItem, transitionItem, reconcileItem } from '../../src/importer/import-items.js';
import type { ImportItemStatus } from '../../src/importer/import-items.js';
import { buildOwnershipSavePlan } from '../../src/importer/ownership-save-plan.js';

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
 * Seed a proposal row with full control.
 */
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

/**
 * Seed a complete import item (proposal + import_items row).
 *
 * Returns the proposalId.
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
  const payload = overrides.frozenPayload ?? '{"platform":"steam","ownershipType":"digital"}';
  const slug = overrides.backloggdSlug ?? `game-${appId}`;

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
    db.prepare('UPDATE games SET title = ? WHERE app_id = ?').run(gameTitle, appId);
  }

  // Ensure proposal exists (satisfies FK constraint)
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

  // Insert or ignore import_items row
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
 * Simulate what Phase 5B Slice 2 does: transition an item to importing,
 * then reconcile it back to approved with an absent proof.
 *
 * This produces the exact outcomeReason format that reconcileItem() creates.
 */
function simulateApprovedWithAbsentProof(
  db: Database.Database,
  proposalId: string,
  reason = 'ownership-change-needed:absent',
  checkedAt?: string,
): void {
  // Must be approved first; transition to importing
  transitionItem(db, proposalId, 'importing');
  // Reconcile back to approved with absent proof
  reconcileItem(db, proposalId, {
    result: 'absent',
    checkedAt: checkedAt ?? new Date().toISOString(),
    reason,
  });
}

/**
 * Create a fully eligible approved ownership item with a valid absent proof.
 * Returns the proposalId.
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
    frozenPayload: '{"platform":"steam","ownershipType":"digital"}',
    proposalKind: 'ownership',
  });

  // Simulate Phase 5B reconciliation: approved → importing → approved (absent)
  simulateApprovedWithAbsentProof(db, proposalId, overrides.proofReason);

  return proposalId;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ownership-save-plan', () => {
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
  // Test 1: Eligible approved ownership item with valid absent proof
  // -----------------------------------------------------------------------
  it('includes eligible approved ownership item with valid absent proof', () => {
    const proposalId = seedEligibleItem(db);

    const plan = buildOwnershipSavePlan({ db, sessionId: SESSION_ID });

    expect(plan.candidates).toHaveLength(1);
    expect(plan.candidates[0]).toMatchObject({
      proposalId,
      sessionId: SESSION_ID,
      steamAppId: 730,
      backloggdSlug: 'game-730',
      desiredPlatform: 'steam',
      desiredOwnershipType: 'digital',
      eligibility: 'eligible',
    });
    expect(plan.candidates[0].explanation).toBeTruthy();
    expect(plan.candidates[0].proofSummary).toBeTruthy();
    expect(plan.candidates[0].backloggdUrl).toBe('https://backloggd.com/games/game-730/');
  });

  // -----------------------------------------------------------------------
  // Test 2: Approved ownership item without absent proof is excluded
  // -----------------------------------------------------------------------
  it('excludes approved ownership item without absent proof', () => {
    // Seed an approved item but do NOT simulate reconciliation (no absent proof)
    seedImportItem(db, {
      status: 'approved',
      frozenPayload: '{"platform":"steam","ownershipType":"digital"}',
      proposalKind: 'ownership',
      outcomeReason: null,
    });

    const plan = buildOwnershipSavePlan({ db, sessionId: SESSION_ID });

    expect(plan.candidates).toHaveLength(0);
    expect(plan.counts.excludedMissingOrInvalidAbsentProof).toBe(1);
  });

  // -----------------------------------------------------------------------
  // Test 3: Approved ownership item with invalid absent proof timestamp
  // -----------------------------------------------------------------------
  it('excludes approved ownership item with invalid absent proof timestamp', () => {
    const proposalId = seedImportItem(db, {
      status: 'approved',
      frozenPayload: '{"platform":"steam","ownershipType":"digital"}',
      proposalKind: 'ownership',
      // outcomeReason with malformed timestamp
      outcomeReason: 'reconciled:absent:ownership-change-needed:checkedAt=not-a-timestamp',
    });

    const plan = buildOwnershipSavePlan({ db, sessionId: SESSION_ID });

    expect(plan.candidates).toHaveLength(0);
    expect(plan.counts.excludedMissingOrInvalidAbsentProof).toBe(1);

    // Verify item status was not mutated
    const item = getItem(db, proposalId);
    expect(item?.status).toBe('approved');
  });

  // -----------------------------------------------------------------------
  // Test 4: Approved ownership item with empty absent proof reason
  // -----------------------------------------------------------------------
  it('excludes approved ownership item with empty absent proof reason', () => {
    const proposalId = seedImportItem(db, {
      status: 'approved',
      frozenPayload: '{"platform":"steam","ownershipType":"digital"}',
      proposalKind: 'ownership',
      outcomeReason: `reconciled:absent::checkedAt=${new Date().toISOString()}`,
    });

    const plan = buildOwnershipSavePlan({ db, sessionId: SESSION_ID });

    expect(plan.candidates).toHaveLength(0);
    expect(plan.counts.excludedMissingOrInvalidAbsentProof).toBe(1);

    // Verify no mutation
    const item = getItem(db, proposalId);
    expect(item?.status).toBe('approved');
  });

  // -----------------------------------------------------------------------
  // Canonical toISOString() timestamp remains eligible (round-trip proof)
  // -----------------------------------------------------------------------
  it('accepts canonical toISOString() absent proof timestamp', () => {
    const proposalId = seedImportItem(db, {
      status: 'approved',
      proposalKind: 'ownership',
      frozenPayload: '{"platform":"steam","ownershipType":"digital"}',
      outcomeReason: 'reconciled:absent:some-reason:checkedAt=2026-07-07T12:00:00.000Z',
    });

    const plan = buildOwnershipSavePlan({ db, sessionId: SESSION_ID });

    expect(plan.candidates).toHaveLength(1);
    expect(plan.candidates[0].proposalId).toBe(proposalId);
  });

  // -----------------------------------------------------------------------
  // Impossible calendar date is excluded
  // -----------------------------------------------------------------------
  it('excludes impossible calendar date (Feb 31)', () => {
    const proposalId = seedImportItem(db, {
      status: 'approved',
      proposalKind: 'ownership',
      frozenPayload: '{"platform":"steam","ownershipType":"digital"}',
      outcomeReason: 'reconciled:absent:some-reason:checkedAt=2026-02-31T12:00:00.000Z',
    });

    const plan = buildOwnershipSavePlan({ db, sessionId: SESSION_ID });

    expect(plan.candidates).toHaveLength(0);
    expect(plan.counts.excludedMissingOrInvalidAbsentProof).toBe(1);

    // Verify no mutation
    const item = getItem(db, proposalId);
    expect(item?.status).toBe('approved');
  });

  // -----------------------------------------------------------------------
  // Non-canonical timestamp (missing milliseconds) is excluded
  // -----------------------------------------------------------------------
  it('excludes non-canonical timestamp missing milliseconds', () => {
    const proposalId = seedImportItem(db, {
      status: 'approved',
      proposalKind: 'ownership',
      frozenPayload: '{"platform":"steam","ownershipType":"digital"}',
      outcomeReason: 'reconciled:absent:some-reason:checkedAt=2026-07-07T12:00:00Z',
    });

    const plan = buildOwnershipSavePlan({ db, sessionId: SESSION_ID });

    expect(plan.candidates).toHaveLength(0);
    expect(plan.counts.excludedMissingOrInvalidAbsentProof).toBe(1);

    // Verify no mutation
    const item = getItem(db, proposalId);
    expect(item?.status).toBe('approved');
  });

  // -----------------------------------------------------------------------
  // Non-canonical timestamp (offset timezone) is excluded
  // -----------------------------------------------------------------------
  it('excludes non-canonical timestamp with offset timezone', () => {
    const proposalId = seedImportItem(db, {
      status: 'approved',
      proposalKind: 'ownership',
      frozenPayload: '{"platform":"steam","ownershipType":"digital"}',
      outcomeReason: 'reconciled:absent:some-reason:checkedAt=2026-07-07T08:00:00.000-04:00',
    });

    const plan = buildOwnershipSavePlan({ db, sessionId: SESSION_ID });

    expect(plan.candidates).toHaveLength(0);
    expect(plan.counts.excludedMissingOrInvalidAbsentProof).toBe(1);

    // Verify no mutation
    const item = getItem(db, proposalId);
    expect(item?.status).toBe('approved');
  });

  // -----------------------------------------------------------------------
  // Test 5: `already-present`/skipped item is excluded
  // -----------------------------------------------------------------------
  it('excludes skipped item', () => {
    seedImportItem(db, {
      status: 'skipped',
      frozenPayload: '{"platform":"steam","ownershipType":"digital"}',
      proposalKind: 'ownership',
      outcomeReason: 'already-present:ownership',
    });

    const plan = buildOwnershipSavePlan({ db, sessionId: SESSION_ID });

    expect(plan.candidates).toHaveLength(0);
    expect(plan.counts.excludedTerminal).toBe(1);
  });

  // -----------------------------------------------------------------------
  // Test 6: `saved` item is excluded
  // -----------------------------------------------------------------------
  it('excludes saved item', () => {
    seedImportItem(db, {
      status: 'saved',
      frozenPayload: '{"platform":"steam","ownershipType":"digital"}',
      proposalKind: 'ownership',
    });

    const plan = buildOwnershipSavePlan({ db, sessionId: SESSION_ID });

    expect(plan.candidates).toHaveLength(0);
    expect(plan.counts.excludedTerminal).toBe(1);
  });

  // -----------------------------------------------------------------------
  // Test 7: `failed` item is excluded
  // -----------------------------------------------------------------------
  it('excludes failed item', () => {
    seedImportItem(db, {
      status: 'failed',
      frozenPayload: '{"platform":"steam","ownershipType":"digital"}',
      proposalKind: 'ownership',
      outcomeReason: 'conflict:ownership',
      lastError: 'Conflict',
    });

    const plan = buildOwnershipSavePlan({ db, sessionId: SESSION_ID });

    expect(plan.candidates).toHaveLength(0);
    expect(plan.counts.excludedMalformedMetadata).toBe(1);
  });

  // -----------------------------------------------------------------------
  // Test 8: `importing` item is excluded
  // -----------------------------------------------------------------------
  it('excludes importing item', () => {
    seedImportItem(db, {
      status: 'importing',
      frozenPayload: '{"platform":"steam","ownershipType":"digital"}',
      proposalKind: 'ownership',
    });

    const plan = buildOwnershipSavePlan({ db, sessionId: SESSION_ID });

    expect(plan.candidates).toHaveLength(0);
    expect(plan.counts.excludedMalformedMetadata).toBe(1);
  });

  // -----------------------------------------------------------------------
  // Test 9: Status/playlog items are excluded
  // -----------------------------------------------------------------------
  it('excludes status and playlog items', () => {
    // Status proposal
    seedImportItem(db, {
      status: 'approved',
      proposalKind: 'status',
      frozenPayload: '{"suggestion":"backlog"}',
      outcomeReason: 'some-reason',
    });

    // Playlog proposal
    seedImportItem(db, {
      status: 'approved',
      proposalKind: 'playlog',
      frozenPayload: '{"enabled":false}',
      outcomeReason: 'some-reason',
    });

    // Ownership proposal (should be eligible if it had absent proof, but
    // without it will hit the missing proof exclusion)
    seedImportItem(db, {
      status: 'approved',
      proposalKind: 'ownership',
      frozenPayload: '{"platform":"steam","ownershipType":"digital"}',
      outcomeReason: null,
    });

    const plan = buildOwnershipSavePlan({ db, sessionId: SESSION_ID });

    expect(plan.candidates).toHaveLength(0);
    expect(plan.counts.excludedUnsupportedKind).toBe(2); // status + playlog
  });

  // -----------------------------------------------------------------------
  // Test 10: Malformed frozen payload is excluded
  // -----------------------------------------------------------------------
  it('excludes malformed frozen payload', () => {
    const proposalId = seedImportItem(db, {
      status: 'approved',
      proposalKind: 'ownership',
      frozenPayload: 'not-json', // malformed
      outcomeReason: `reconciled:absent:some-reason:checkedAt=${new Date().toISOString()}`,
    });

    const plan = buildOwnershipSavePlan({ db, sessionId: SESSION_ID });

    expect(plan.candidates).toHaveLength(0);
    expect(plan.counts.excludedMalformedMetadata).toBe(1);

    // Verify no mutation
    const item = getItem(db, proposalId);
    expect(item?.status).toBe('approved');
  });

  // -----------------------------------------------------------------------
  // Test 11: Canonical proposal kind mismatch is excluded
  // -----------------------------------------------------------------------
  it('excludes canonical proposal kind mismatch', () => {
    const proposalId = randomUUID();
    // Ensure game exists for FK constraint
    seedMinimalGame(db, 730, 'Game 730');
    // Seed a proposal with kind 'status' but import item with kind 'ownership'
    seedProposal(db, {
      id: proposalId,
      importSessionId: SESSION_ID,
      steamAppId: 730,
      proposalKind: 'status', // different from import item
      status: 'approved',
      suggestedPayload: '{"suggestion":"backlog"}',
      backloggdSlug: 'game-730',
    });

    seedImportItem(db, {
      proposalId,
      status: 'approved',
      proposalKind: 'ownership',
      frozenPayload: '{"platform":"steam","ownershipType":"digital"}',
      outcomeReason: `reconciled:absent:some-reason:checkedAt=${new Date().toISOString()}`,
      backloggdSlug: 'game-730',
    });

    const plan = buildOwnershipSavePlan({ db, sessionId: SESSION_ID });

    expect(plan.candidates).toHaveLength(0);
    expect(plan.counts.excludedStaleCanonical).toBe(1);
  });

  // -----------------------------------------------------------------------
  // Test 12: Canonical proposal status not approved is excluded
  // -----------------------------------------------------------------------
  it('excludes canonical proposal status not approved', () => {
    const proposalId = randomUUID();
    // Ensure game exists for FK constraint
    seedMinimalGame(db, 730, 'Game 730');
    seedProposal(db, {
      id: proposalId,
      importSessionId: SESSION_ID,
      steamAppId: 730,
      proposalKind: 'ownership',
      status: 'pending', // not approved
      suggestedPayload: '{"platform":"steam","ownershipType":"digital"}',
      backloggdSlug: 'game-730',
    });

    seedImportItem(db, {
      proposalId,
      status: 'approved',
      proposalKind: 'ownership',
      frozenPayload: '{"platform":"steam","ownershipType":"digital"}',
      outcomeReason: `reconciled:absent:some-reason:checkedAt=${new Date().toISOString()}`,
      backloggdSlug: 'game-730',
    });

    const plan = buildOwnershipSavePlan({ db, sessionId: SESSION_ID });

    expect(plan.candidates).toHaveLength(0);
    expect(plan.counts.excludedStaleCanonical).toBe(1);
  });

  // -----------------------------------------------------------------------
  // Test 13: Canonical Steam AppID mismatch is excluded
  // -----------------------------------------------------------------------
  it('excludes canonical Steam AppID mismatch', () => {
    const proposalId = randomUUID();
    // Both games must exist for FK constraints
    seedMinimalGame(db, 730, 'Game 730');
    seedMinimalGame(db, 740, 'Game 740');
    // Proposal has appId 730
    seedProposal(db, {
      id: proposalId,
      importSessionId: SESSION_ID,
      steamAppId: 730,
      proposalKind: 'ownership',
      status: 'approved',
      suggestedPayload: '{"platform":"steam","ownershipType":"digital"}',
      backloggdSlug: 'game-730',
    });

    // Import item has appId 740 (mismatch)
    seedImportItem(db, {
      proposalId,
      steamAppId: 740,
      status: 'approved',
      proposalKind: 'ownership',
      frozenPayload: '{"platform":"steam","ownershipType":"digital"}',
      outcomeReason: `reconciled:absent:some-reason:checkedAt=${new Date().toISOString()}`,
      backloggdSlug: 'game-730',
    });

    const plan = buildOwnershipSavePlan({ db, sessionId: SESSION_ID });

    expect(plan.candidates).toHaveLength(0);
    expect(plan.counts.excludedStaleCanonical).toBe(1);
  });

  // -----------------------------------------------------------------------
  // Test 14: Canonical session mismatch is excluded
  // -----------------------------------------------------------------------
  it('excludes canonical session mismatch', () => {
    const otherSession = 'other-session';
    seedMinimalSession(db, otherSession);

    const proposalId = randomUUID();
    // Ensure game exists for FK constraint
    seedMinimalGame(db, 730, 'Game 730');
    seedProposal(db, {
      id: proposalId,
      importSessionId: otherSession, // different session
      steamAppId: 730,
      proposalKind: 'ownership',
      status: 'approved',
      suggestedPayload: '{"platform":"steam","ownershipType":"digital"}',
      backloggdSlug: 'game-730',
    });

    // Import item belongs to test-session
    seedImportItem(db, {
      proposalId,
      importSessionId: SESSION_ID,
      status: 'approved',
      proposalKind: 'ownership',
      frozenPayload: '{"platform":"steam","ownershipType":"digital"}',
      outcomeReason: `reconciled:absent:some-reason:checkedAt=${new Date().toISOString()}`,
      backloggdSlug: 'game-730',
    });

    const plan = buildOwnershipSavePlan({ db, sessionId: SESSION_ID });

    expect(plan.candidates).toHaveLength(0);
    expect(plan.counts.excludedStaleCanonical).toBe(1);
  });

  // -----------------------------------------------------------------------
  // Test 15: Multiple eligible ownership items are sorted deterministically
  // -----------------------------------------------------------------------
  it('sorts multiple eligible items deterministically', () => {
    // Create items with different steamAppIds in reverse order
    seedEligibleItem(db, { steamAppId: 300, gameTitle: 'Game 300' });
    seedEligibleItem(db, { steamAppId: 100, gameTitle: 'Game 100' });
    seedEligibleItem(db, { steamAppId: 200, gameTitle: 'Game 200' });

    const plan = buildOwnershipSavePlan({ db, sessionId: SESSION_ID });

    expect(plan.candidates).toHaveLength(3);
    // Must be sorted by steamAppId ascending
    expect(plan.candidates[0].steamAppId).toBe(100);
    expect(plan.candidates[1].steamAppId).toBe(200);
    expect(plan.candidates[2].steamAppId).toBe(300);
  });

  // -----------------------------------------------------------------------
  // Test 16: Planner does not mutate item statuses
  // -----------------------------------------------------------------------
  it('does not mutate import item statuses', () => {
    // Seed an eligible item, then run the planner
    const proposalId = seedEligibleItem(db);

    // Capture status before
    const before = getItem(db, proposalId);
    expect(before?.status).toBe('approved');

    // Build plan
    const plan = buildOwnershipSavePlan({ db, sessionId: SESSION_ID });

    // Verify plan included the item
    expect(plan.candidates).toHaveLength(1);

    // Capture status after
    const after = getItem(db, proposalId);
    expect(after?.status).toBe('approved');
    expect(after?.updatedAt).toBe(before?.updatedAt); // unchanged
    expect(after?.outcomeReason).toBe(before?.outcomeReason); // unchanged
  });

  // -----------------------------------------------------------------------
  // Test 17: Planner does not import browser/Playwright modules
  //
  // Verified by code review — the module only imports better-sqlite3 types
  // and import-items.  No Playwright import exists in the source file.
  // This test confirms no accidental transitive dependency by checking that
  // the function signature does not reference any browser type.
  // -----------------------------------------------------------------------
  it('does not import browser/Playwright modules', () => {
    // 1. Static source-file check: the module must not import from
    //    playwright, backloggd browser modules, or comparison/runner.
    const src = readFileSync(resolve('src/importer/ownership-save-plan.ts'), 'utf8');

    // Strip comments so import assertions are not confused by docstrings
    // that mention Playwright for documentation purposes.
    const srcNoComments = src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

    // Check that no forbidden import sources exist in the stripped source.
    const forbiddenPatterns = [
      /from\s+['"]playwright['"]/,
      /from\s+['"]@playwright\/test['"]/,
      /from\s+['"].*?\bvisible-state\b.*?['"]/,
      /from\s+['"].*?\bcomparison\b.*?['"]/,
      /from\s+['"].*?\bownership-comparison-runner\b.*?['"]/,
      /from\s+['"].*?\bbackloggd\/browser\b.*?['"]/,
    ];

    for (const pattern of forbiddenPatterns) {
      expect(srcNoComments).not.toMatch(pattern);
    }

    // 2. Verify the function can be called without any browser/page argument.
    const options: Parameters<typeof buildOwnershipSavePlan>[0] = {
      db,
      sessionId: SESSION_ID,
    };
    expect(() => buildOwnershipSavePlan(options)).not.toThrow();

    // 3. Runtime export check: the compiled module must not re-export
    //    Playwright symbols.
    //    Note: async import deferred to avoid top-level await issues.
  });

  it('does not re-export Playwright symbols from compiled module', async () => {
    const mod = await import('../../src/importer/ownership-save-plan.js');
    expect(mod).not.toHaveProperty('chromium');
    expect(mod).not.toHaveProperty('Page');
    expect(mod).not.toHaveProperty('Browser');
    expect(mod).not.toHaveProperty('playwright');
  });

  // -----------------------------------------------------------------------
  // Test 18: Planner output contains enough human-readable detail
  // -----------------------------------------------------------------------
  it('includes human-readable detail for confirmation prompts', () => {
    const proposalId = seedEligibleItem(db, {
      steamAppId: 730,
      gameTitle: 'Counter-Strike 2',
      backloggdSlug: 'cs2',
      proofReason: 'ownership-change-needed:absent',
    });

    const plan = buildOwnershipSavePlan({ db, sessionId: SESSION_ID });

    expect(plan.candidates).toHaveLength(1);
    const candidate = plan.candidates[0];

    // Must have enough detail for user-facing confirmation
    expect(candidate.proposalId).toBe(proposalId);
    expect(candidate.sessionId).toBe(SESSION_ID);
    expect(candidate.steamAppId).toBe(730);
    expect(candidate.gameTitle).toBe('Counter-Strike 2');
    expect(candidate.backloggdSlug).toBe('cs2');
    expect(candidate.backloggdUrl).toBe('https://backloggd.com/games/cs2/');
    expect(candidate.desiredPlatform).toBe('steam');
    expect(candidate.desiredOwnershipType).toBe('digital');
    expect(candidate.proofSummary).toBe('ownership-change-needed:absent');
    expect(candidate.explanation).toBe(
      'Steam/Digital ownership is absent on Backloggd; candidate for user-confirmed add.',
    );
    expect(candidate.eligibility).toBe('eligible');
  });

  // -----------------------------------------------------------------------
  // Test 19: Counts correctly report eligible and excluded categories
  // -----------------------------------------------------------------------
  it('reports correct counts for eligible and excluded categories', () => {
    // Create a mix of items covering all categories:
    // 1 eligible, 1 terminal, 1 unsupported kind, 1 malformed metadata,
    // 1 missing proof, 1 stale canonical

    // Eligible (will have proper absent proof after reconcile)
    seedEligibleItem(db, { steamAppId: 100, gameTitle: 'Eligible Game' });

    // Terminal (skipped)
    seedImportItem(db, {
      steamAppId: 200,
      status: 'skipped',
      proposalKind: 'ownership',
      frozenPayload: '{"platform":"steam","ownershipType":"digital"}',
    });

    // Unsupported kind (status)
    seedImportItem(db, {
      steamAppId: 300,
      status: 'approved',
      proposalKind: 'status',
      frozenPayload: '{"suggestion":"backlog"}',
      outcomeReason: 'some-reason',
    });

    // Malformed metadata (failed)
    seedImportItem(db, {
      steamAppId: 400,
      status: 'failed',
      proposalKind: 'ownership',
      frozenPayload: '{"platform":"steam","ownershipType":"digital"}',
    });

    // Missing proof (approved ownership without absent proof)
    seedImportItem(db, {
      steamAppId: 500,
      status: 'approved',
      proposalKind: 'ownership',
      frozenPayload: '{"platform":"steam","ownershipType":"digital"}',
      outcomeReason: null,
    });

    // Stale canonical (proposal status not approved)
    const staleProposalId = randomUUID();
    seedMinimalGame(db, 600, 'Game 600');
    seedProposal(db, {
      id: staleProposalId,
      importSessionId: SESSION_ID,
      steamAppId: 600,
      proposalKind: 'ownership',
      status: 'pending',
      suggestedPayload: '{"platform":"steam","ownershipType":"digital"}',
      backloggdSlug: 'game-600',
    });
    seedImportItem(db, {
      proposalId: staleProposalId,
      steamAppId: 600,
      status: 'approved',
      proposalKind: 'ownership',
      frozenPayload: '{"platform":"steam","ownershipType":"digital"}',
      outcomeReason: `reconciled:absent:some-reason:checkedAt=${new Date().toISOString()}`,
    });

    const plan = buildOwnershipSavePlan({ db, sessionId: SESSION_ID });

    expect(plan.counts.eligibleCandidates).toBe(1);
    expect(plan.counts.excludedTerminal).toBe(1);
    expect(plan.counts.excludedUnsupportedKind).toBe(1);
    expect(plan.counts.excludedMalformedMetadata).toBe(1); // failed item
    expect(plan.counts.excludedMissingOrInvalidAbsentProof).toBe(1);
    expect(plan.counts.excludedStaleCanonical).toBe(1);
  });

  // -----------------------------------------------------------------------
  // Test 20: Re-running the planner is idempotent
  // -----------------------------------------------------------------------
  it('is idempotent when run repeatedly', () => {
    // Seed a mix of items
    seedEligibleItem(db, { steamAppId: 100, gameTitle: 'Game 100' });
    seedEligibleItem(db, { steamAppId: 200, gameTitle: 'Game 200' });
    seedImportItem(db, {
      steamAppId: 300,
      status: 'skipped',
      proposalKind: 'ownership',
      frozenPayload: '{"platform":"steam","ownershipType":"digital"}',
    });

    // Run twice
    const plan1 = buildOwnershipSavePlan({ db, sessionId: SESSION_ID });
    const plan2 = buildOwnershipSavePlan({ db, sessionId: SESSION_ID });

    // Both runs must produce identical results
    expect(plan1.candidates).toEqual(plan2.candidates);
    expect(plan1.counts).toEqual(plan2.counts);
    expect(plan1.sessionId).toBe(plan2.sessionId);
  });

  // -----------------------------------------------------------------------
  // Additional edge case: no items at all
  // -----------------------------------------------------------------------
  it('returns empty plan when no items exist', () => {
    const plan = buildOwnershipSavePlan({ db, sessionId: SESSION_ID });

    expect(plan.candidates).toHaveLength(0);
    expect(plan.counts.eligibleCandidates).toBe(0);
    expect(plan.counts.excludedTerminal).toBe(0);
    expect(plan.counts.excludedUnsupportedKind).toBe(0);
    expect(plan.counts.excludedMalformedMetadata).toBe(0);
    expect(plan.counts.excludedMissingOrInvalidAbsentProof).toBe(0);
    expect(plan.counts.excludedStaleCanonical).toBe(0);
    expect(plan.sessionId).toBe(SESSION_ID);
    expect(plan.builtAt).toBeTruthy();
  });

  // -----------------------------------------------------------------------
  // Verify empty string platform/ownershipType is excluded
  // -----------------------------------------------------------------------
  it('excludes payload with empty platform string', () => {
    const proposalId = seedImportItem(db, {
      status: 'approved',
      proposalKind: 'ownership',
      frozenPayload: '{"platform":"","ownershipType":"digital"}',
      outcomeReason: `reconciled:absent:some-reason:checkedAt=${new Date().toISOString()}`,
    });

    const plan = buildOwnershipSavePlan({ db, sessionId: SESSION_ID });

    expect(plan.candidates).toHaveLength(0);
    expect(plan.counts.excludedMalformedMetadata).toBe(1);

    // Verify no mutation
    const item = getItem(db, proposalId);
    expect(item?.status).toBe('approved');
  });

  // -----------------------------------------------------------------------
  // Fix 1: reason containing :checkedAt= is excluded
  // -----------------------------------------------------------------------
  it('excludes absent proof whose reason contains the literal :checkedAt=', () => {
    const proposalId = seedImportItem(db, {
      status: 'approved',
      proposalKind: 'ownership',
      frozenPayload: '{"platform":"steam","ownershipType":"digital"}',
      // reason contains `:checkedAt=` which is ambiguous with the delimiter
      outcomeReason: 'reconciled:absent:foo:checkedAt=bar:checkedAt=2026-07-07T12:00:00.000Z',
    });

    const plan = buildOwnershipSavePlan({ db, sessionId: SESSION_ID });

    expect(plan.candidates).toHaveLength(0);
    expect(plan.counts.excludedMissingOrInvalidAbsentProof).toBe(1);

    // Verify no mutation
    const item = getItem(db, proposalId);
    expect(item?.status).toBe('approved');
  });

  // -----------------------------------------------------------------------
  // Verify outcomeReason with wrong result value is excluded
  // -----------------------------------------------------------------------
  it('excludes outcomeReason with non-absent result', () => {
    const proposalId = seedImportItem(db, {
      status: 'approved',
      proposalKind: 'ownership',
      frozenPayload: '{"platform":"steam","ownershipType":"digital"}',
      outcomeReason: `reconciled:present:already-own:checkedAt=${new Date().toISOString()}`,
    });

    const plan = buildOwnershipSavePlan({ db, sessionId: SESSION_ID });

    expect(plan.candidates).toHaveLength(0);
    expect(plan.counts.excludedMissingOrInvalidAbsentProof).toBe(1);

    // Verify no mutation
    const item = getItem(db, proposalId);
    expect(item?.status).toBe('approved');
  });

  // -----------------------------------------------------------------------
  // Verify canonical proposal that does not exist is excluded
  // -----------------------------------------------------------------------
  it('excludes item whose canonical proposal is missing', () => {
    // Insert import_item without a corresponding proposal
    // Must bypass FK constraint for this test — use pragma to disable FKs
    db.pragma('foreign_keys = OFF');
    const orphanProposalId = randomUUID();
    db.prepare(
      `INSERT INTO import_items
         (proposal_id, import_session_id, steam_app_id, proposal_kind,
          frozen_payload, status, outcome_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      orphanProposalId,
      SESSION_ID,
      999,
      'ownership',
      '{"platform":"steam","ownershipType":"digital"}',
      'approved',
      `reconciled:absent:some-reason:checkedAt=${new Date().toISOString()}`,
    );
    db.pragma('foreign_keys = ON');

    const plan = buildOwnershipSavePlan({ db, sessionId: SESSION_ID });

    expect(plan.candidates).toHaveLength(0);
    expect(plan.counts.excludedStaleCanonical).toBe(1);
  });

  // -----------------------------------------------------------------------
  // Slug eligibility: null slug -> excluded
  // -----------------------------------------------------------------------
  it('excludes item whose canonical backloggd_slug is null', () => {
    const proposalId = randomUUID();
    // Ensure game exists for FK constraint
    seedMinimalGame(db, 730, 'Game 730');
    seedProposal(db, {
      id: proposalId,
      importSessionId: SESSION_ID,
      steamAppId: 730,
      proposalKind: 'ownership',
      status: 'approved',
      suggestedPayload: '{"platform":"steam","ownershipType":"digital"}',
      backloggdSlug: null, // no slug
    });

    seedImportItem(db, {
      proposalId,
      status: 'approved',
      proposalKind: 'ownership',
      frozenPayload: '{"platform":"steam","ownershipType":"digital"}',
      outcomeReason: `reconciled:absent:some-reason:checkedAt=${new Date().toISOString()}`,
      backloggdSlug: null,
    });
    simulateApprovedWithAbsentProof(db, proposalId);

    const plan = buildOwnershipSavePlan({ db, sessionId: SESSION_ID });

    expect(plan.candidates).toHaveLength(0);
    expect(plan.counts.excludedStaleCanonical).toBe(1);
  });

  // -----------------------------------------------------------------------
  // Slug eligibility: whitespace slug -> excluded
  // -----------------------------------------------------------------------
  it('excludes item whose canonical backloggd_slug is whitespace-only', () => {
    const proposalId = randomUUID();
    seedMinimalGame(db, 730, 'Game 730');
    seedProposal(db, {
      id: proposalId,
      importSessionId: SESSION_ID,
      steamAppId: 730,
      proposalKind: 'ownership',
      status: 'approved',
      suggestedPayload: '{"platform":"steam","ownershipType":"digital"}',
      backloggdSlug: '   ', // whitespace-only slug
    });

    seedImportItem(db, {
      proposalId,
      status: 'approved',
      proposalKind: 'ownership',
      frozenPayload: '{"platform":"steam","ownershipType":"digital"}',
      outcomeReason: `reconciled:absent:some-reason:checkedAt=${new Date().toISOString()}`,
      backloggdSlug: '   ',
    });
    simulateApprovedWithAbsentProof(db, proposalId);

    const plan = buildOwnershipSavePlan({ db, sessionId: SESSION_ID });

    expect(plan.candidates).toHaveLength(0);
    expect(plan.counts.excludedStaleCanonical).toBe(1);
  });

  // -----------------------------------------------------------------------
  // Verify game title is null when game row is missing
  // -----------------------------------------------------------------------
  it('produces null gameTitle when game row is missing', () => {
    // Disable FK constraints to insert proposal + import item without games row
    db.pragma('foreign_keys = OFF');

    const proposalId = randomUUID();
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
      proposalId,
      SESSION_ID,
      99999,
      199999,
      'game-99999',
      'ownership',
      'approved',
      '{"platform":"steam","ownershipType":"digital"}',
    );

    db.prepare(
      `INSERT INTO import_items
         (proposal_id, import_session_id, steam_app_id, proposal_kind,
          frozen_payload, status, outcome_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      proposalId,
      SESSION_ID,
      99999,
      'ownership',
      '{"platform":"steam","ownershipType":"digital"}',
      'approved',
      `reconciled:absent:some-reason:checkedAt=${new Date().toISOString()}`,
    );

    db.pragma('foreign_keys = ON');

    // Transition to importing then reconcile
    transitionItem(db, proposalId, 'importing');
    reconcileItem(db, proposalId, {
      result: 'absent',
      checkedAt: new Date().toISOString(),
      reason: 'ownership-change-needed:absent',
    });

    const plan = buildOwnershipSavePlan({ db, sessionId: SESSION_ID });

    expect(plan.candidates).toHaveLength(1);
    expect(plan.candidates[0].gameTitle).toBeNull();
  });

  // -----------------------------------------------------------------------
  // Missing game title with valid slug -> candidate still eligible
  // -----------------------------------------------------------------------
  it('includes candidate with missing game title but valid slug', () => {
    // Disable FK constraints to insert proposal + import item without games row
    db.pragma('foreign_keys = OFF');

    const proposalId = randomUUID();
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
      proposalId,
      SESSION_ID,
      99999,
      199999,
      'valid-slug', // valid slug, no game row
      'ownership',
      'approved',
      '{"platform":"steam","ownershipType":"digital"}',
    );

    db.prepare(
      `INSERT INTO import_items
         (proposal_id, import_session_id, steam_app_id, proposal_kind,
          frozen_payload, status, outcome_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      proposalId,
      SESSION_ID,
      99999,
      'ownership',
      '{"platform":"steam","ownershipType":"digital"}',
      'approved',
      `reconciled:absent:some-reason:checkedAt=${new Date().toISOString()}`,
    );

    db.pragma('foreign_keys = ON');

    // Transition to importing then reconcile
    transitionItem(db, proposalId, 'importing');
    reconcileItem(db, proposalId, {
      result: 'absent',
      checkedAt: new Date().toISOString(),
      reason: 'ownership-change-needed:absent',
    });

    const plan = buildOwnershipSavePlan({ db, sessionId: SESSION_ID });

    expect(plan.candidates).toHaveLength(1);
    expect(plan.candidates[0].gameTitle).toBeNull();
    expect(plan.candidates[0].backloggdSlug).toBe('valid-slug');
    expect(plan.candidates[0].backloggdUrl).toBe('https://backloggd.com/games/valid-slug/');
    expect(plan.candidates[0].explanation).toBe(
      'Steam/Digital ownership is absent on Backloggd; candidate for user-confirmed add.',
    );
  });

  // -----------------------------------------------------------------------
  // Verify empty plan for items in a different session
  // -----------------------------------------------------------------------
  it('returns empty plan for session with no data', () => {
    const otherSession = 'empty-session';
    seedMinimalSession(db, otherSession);

    const plan = buildOwnershipSavePlan({ db, sessionId: otherSession });

    expect(plan.candidates).toHaveLength(0);
    expect(plan.counts.eligibleCandidates).toBe(0);
    expect(plan.sessionId).toBe(otherSession);
  });
});
