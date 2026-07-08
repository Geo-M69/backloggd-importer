import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { getCreateTableSQL } from '../../src/storage/schema.js';
import { runMigrations } from '../../src/storage/database.js';
import { getItem, transitionItem, reconcileItem } from '../../src/importer/import-items.js';
import { buildOwnershipSavePlan } from '../../src/importer/ownership-save-plan.js';
import type { OwnershipSavePlan } from '../../src/importer/ownership-save-plan.js';
import {
  buildOwnershipConfirmationPrompt,
  applyOwnershipConfirmationSelection,
} from '../../src/importer/ownership-save-confirmation.js';
import { readFileSync } from 'node:fs';

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
// Helpers (copied pattern from ownership-save-plan tests)
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

describe('ownership-save-confirmation', () => {
  let db: Database.Database;
  const SESSION_ID = 'test-session';

  beforeEach(() => {
    db = createFreshDb();
    seedMinimalSession(db, SESSION_ID);
  });

  afterEach(() => {
    db.close();
  });

  it('prompt builder includes required human-readable fields and is deterministic', () => {
    const proposalId = seedEligibleItem(db, {
      steamAppId: 730,
      gameTitle: 'CS2',
      backloggdSlug: 'cs2',
    });
    const plan = buildOwnershipSavePlan({ db, sessionId: SESSION_ID });
    const prompt1 = buildOwnershipConfirmationPrompt(plan);
    const prompt2 = buildOwnershipConfirmationPrompt(plan);

    expect(prompt1.items).toHaveLength(1);
    const it = prompt1.items[0];
    expect(it.proposalId).toBe(proposalId);
    expect(it.steamAppId).toBe(730);
    expect(it.gameTitle).toBe('CS2');
    expect(it.backloggdUrl).toBe('https://backloggd.com/games/cs2/');
    expect(it.desiredPlatform).toBe('steam');
    expect(it.desiredOwnershipType).toBe('digital');
    expect(it.proofSummary).toBeTruthy();
    expect(it.proofCheckedAt).toBeTruthy();
    expect(it.index).toBe(1);

    // Fully deterministic: same plan → identical prompt objects
    expect(prompt1.text).toBe(prompt2.text);
    expect(prompt1.builtAt).toBe(prompt2.builtAt);
    expect(prompt1.items).toEqual(prompt2.items);
  });

  it('prompt builder performs no DB writes', () => {
    seedEligibleItem(db);
    const plan = buildOwnershipSavePlan({ db, sessionId: SESSION_ID });
    buildOwnershipConfirmationPrompt(plan);
    const row = db.prepare('SELECT COUNT(*) AS cnt FROM import_item_confirmations').get() as {
      cnt: number;
    };
    expect(row.cnt).toBe(0);
  });

  it('empty plan produces empty prompt/selection set', () => {
    const emptyPlan: OwnershipSavePlan = {
      sessionId: SESSION_ID,
      candidates: [],
      counts: {
        eligibleCandidates: 0,
        excludedTerminal: 0,
        excludedUnsupportedKind: 0,
        excludedMalformedMetadata: 0,
        excludedMissingOrInvalidAbsentProof: 0,
        excludedStaleCanonical: 0,
      },
      builtAt: new Date().toISOString(),
    };
    const prompt = buildOwnershipConfirmationPrompt(emptyPlan);
    expect(prompt.items).toHaveLength(0);
    expect(prompt.text).toContain('NO WRITES PERFORMED YET');
  });

  it('selection by proposal id works', () => {
    const pid = seedEligibleItem(db);
    const plan = buildOwnershipSavePlan({ db, sessionId: SESSION_ID });
    const res = applyOwnershipConfirmationSelection(db, plan, { byProposalIds: [pid] });
    expect(res.confirmed).toHaveLength(1);
    const row = db
      .prepare('SELECT * FROM import_item_confirmations WHERE proposal_id = ?')
      .get(pid) as ConfirmationRow | undefined;
    expect(row?.proposal_id).toBe(pid);
    expect(row?.planned_platform).toBe('steam');
  });

  it('selection by stable index works', () => {
    const pid = seedEligibleItem(db);
    const plan = buildOwnershipSavePlan({ db, sessionId: SESSION_ID });
    const res = applyOwnershipConfirmationSelection(db, plan, { byIndexes: [1] });
    expect(res.confirmed).toHaveLength(1);
    const row = db
      .prepare('SELECT * FROM import_item_confirmations WHERE proposal_id = ?')
      .get(pid) as ConfirmationRow | undefined;
    expect(row?.id).toBeGreaterThanOrEqual(0);
  });

  it('select all works', () => {
    seedEligibleItem(db, { steamAppId: 101 });
    seedEligibleItem(db, { steamAppId: 102 });
    const plan = buildOwnershipSavePlan({ db, sessionId: SESSION_ID });
    const res = applyOwnershipConfirmationSelection(db, plan, { selectAll: true });
    expect(res.confirmed.length).toBeGreaterThanOrEqual(2);
    const rows = db.prepare('SELECT COUNT(*) AS cnt FROM import_item_confirmations').get() as {
      cnt: number;
    };
    expect(rows.cnt).toBeGreaterThanOrEqual(2);
  });

  it('unknown proposal id is rejected', () => {
    const plan = buildOwnershipSavePlan({ db, sessionId: SESSION_ID });
    expect(() =>
      applyOwnershipConfirmationSelection(db, plan, { byProposalIds: ['no-such'] }),
    ).toThrow();
  });

  it('duplicate proposal id is rejected', () => {
    const pid = seedEligibleItem(db);
    const plan = buildOwnershipSavePlan({ db, sessionId: SESSION_ID });
    expect(() =>
      applyOwnershipConfirmationSelection(db, plan, { byProposalIds: [pid, pid] }),
    ).toThrow();
  });

  it('out-of-range index is rejected', () => {
    seedEligibleItem(db);
    const plan = buildOwnershipSavePlan({ db, sessionId: SESSION_ID });
    expect(() => applyOwnershipConfirmationSelection(db, plan, { byIndexes: [999] })).toThrow();
  });

  it('duplicate index is rejected', () => {
    seedEligibleItem(db);
    const plan = buildOwnershipSavePlan({ db, sessionId: SESSION_ID });
    expect(() => applyOwnershipConfirmationSelection(db, plan, { byIndexes: [1, 1] })).toThrow();
  });

  it('empty selection is rejected by default', () => {
    seedEligibleItem(db);
    const plan = buildOwnershipSavePlan({ db, sessionId: SESSION_ID });
    expect(() => applyOwnershipConfirmationSelection(db, plan, { byProposalIds: [] })).toThrow();
  });

  it('empty selection allowed with explicit option', () => {
    seedEligibleItem(db);
    const plan = buildOwnershipSavePlan({ db, sessionId: SESSION_ID });
    const res = applyOwnershipConfirmationSelection(
      db,
      plan,
      { byProposalIds: [] },
      { allowEmptySelection: true },
    );
    expect(res.confirmed).toHaveLength(0);
  });

  it('candidate not in supplied plan cannot be confirmed', () => {
    const pid = seedEligibleItem(db);
    const plan = {
      ...(buildOwnershipSavePlan({ db, sessionId: SESSION_ID }) as OwnershipSavePlan),
      candidates: [],
    } as OwnershipSavePlan;
    expect(() => applyOwnershipConfirmationSelection(db, plan, { byProposalIds: [pid] })).toThrow();
  });

  it('selected item status changed to saved is rejected', () => {
    const pid = seedEligibleItem(db);
    const plan = buildOwnershipSavePlan({ db, sessionId: SESSION_ID });
    // change status after plan was built
    db.prepare('UPDATE import_items SET status = ? WHERE proposal_id = ?').run('saved', pid);
    const res = applyOwnershipConfirmationSelection(db, plan, { byProposalIds: [pid] });
    expect(res.confirmed).toHaveLength(0);
    expect(res.rejected[0].reason).toMatch(/import_item_status_saved/);
  });

  it('selected item status changed to importing is rejected', () => {
    const pid = seedEligibleItem(db);
    const plan = buildOwnershipSavePlan({ db, sessionId: SESSION_ID });
    db.prepare('UPDATE import_items SET status = ? WHERE proposal_id = ?').run('importing', pid);
    const res = applyOwnershipConfirmationSelection(db, plan, { byProposalIds: [pid] });
    expect(res.confirmed).toHaveLength(0);
    expect(res.rejected[0].reason).toMatch(/import_item_status_importing/);
  });

  it('selected canonical proposal changed to non-approved is rejected', () => {
    const pid = seedEligibleItem(db);
    const plan = buildOwnershipSavePlan({ db, sessionId: SESSION_ID });
    db.prepare('UPDATE proposals SET status = ? WHERE id = ?').run('pending', pid);
    const res = applyOwnershipConfirmationSelection(db, plan, { byProposalIds: [pid] });
    expect(res.rejected[0].reason).toBe('canonical_status_not_approved');
  });

  it('selected canonical slug changed is rejected', () => {
    const pid = seedEligibleItem(db);
    const plan = buildOwnershipSavePlan({ db, sessionId: SESSION_ID });
    db.prepare('UPDATE proposals SET backloggd_slug = ? WHERE id = ?').run('different-slug', pid);
    const res = applyOwnershipConfirmationSelection(db, plan, { byProposalIds: [pid] });
    expect(res.rejected[0].reason).toBe('canonical_slug_mismatch');
  });

  it('selected frozen payload changed is rejected', () => {
    const pid = seedEligibleItem(db);
    const plan = buildOwnershipSavePlan({ db, sessionId: SESSION_ID });
    db.prepare('UPDATE import_items SET frozen_payload = ? WHERE proposal_id = ?').run(
      '{"platform":"other","ownershipType":"digital"}',
      pid,
    );
    const res = applyOwnershipConfirmationSelection(db, plan, { byProposalIds: [pid] });
    expect(res.rejected[0].reason).toBe('frozen_payload_mismatch');
  });

  it('selected absent proof changed/missing is rejected', () => {
    const pid = seedEligibleItem(db);
    const plan = buildOwnershipSavePlan({ db, sessionId: SESSION_ID });
    // remove proof after plan built
    db.prepare('UPDATE import_items SET outcome_reason = NULL WHERE proposal_id = ?').run(pid);
    const res = applyOwnershipConfirmationSelection(db, plan, { byProposalIds: [pid] });
    expect(res.rejected[0].reason).toBe('absent_proof_missing_or_invalid');
  });

  it('valid selected candidate records confirmation and does not mutate import item', () => {
    const pid = seedEligibleItem(db);
    const before = getItem(db, pid);
    const plan = buildOwnershipSavePlan({ db, sessionId: SESSION_ID });
    const res = applyOwnershipConfirmationSelection(db, plan, { byProposalIds: [pid] });
    expect(res.confirmed).toHaveLength(1);
    const after = getItem(db, pid);
    expect(after?.status).toBe(before?.status);
    expect(after?.outcomeReason).toBe(before?.outcomeReason);
  });

  it('re-confirming same candidate is idempotent and does not duplicate active confirmation', () => {
    const pid = seedEligibleItem(db);
    const plan = buildOwnershipSavePlan({ db, sessionId: SESSION_ID });
    applyOwnershipConfirmationSelection(db, plan, { byProposalIds: [pid] });
    // confirm again
    const res2 = applyOwnershipConfirmationSelection(db, plan, { byProposalIds: [pid] });
    // second call reports alreadyConfirmed
    expect(res2.alreadyConfirmed).toContain(pid);
    const rows = db
      .prepare('SELECT COUNT(*) AS cnt FROM import_item_confirmations WHERE proposal_id = ?')
      .get(pid) as { cnt: number };
    expect(rows.cnt).toBe(1);
  });

  it('multiple selected candidates record independently', () => {
    const p1 = seedEligibleItem(db, { steamAppId: 210 });
    const p2 = seedEligibleItem(db, { steamAppId: 211 });
    const plan = buildOwnershipSavePlan({ db, sessionId: SESSION_ID });
    const res = applyOwnershipConfirmationSelection(db, plan, { byProposalIds: [p1, p2] });
    expect(res.confirmed.length).toBe(2);
    const rows = db.prepare('SELECT COUNT(*) AS cnt FROM import_item_confirmations').get() as {
      cnt: number;
    };
    expect(rows.cnt).toBeGreaterThanOrEqual(2);
  });

  it('confirmation records include planned data for later write', () => {
    const pid = seedEligibleItem(db, { steamAppId: 333, backloggdSlug: 'slug-333' });
    const plan = buildOwnershipSavePlan({ db, sessionId: SESSION_ID });
    applyOwnershipConfirmationSelection(db, plan, { byProposalIds: [pid] });
    const row = db
      .prepare('SELECT * FROM import_item_confirmations WHERE proposal_id = ?')
      .get(pid) as ConfirmationRow | undefined;
    expect(row?.planned_platform).toBe('steam');
    expect(row?.planned_ownership_type).toBe('digital');
    expect(row?.planned_slug).toBe('slug-333');
    expect(row?.planned_absent_checked_at).toBeTruthy();
  });

  // -----------------------------------------------------------------------
  // Finding 1 — checkedAt mismatch is rejected
  // -----------------------------------------------------------------------
  it('rejects candidate whose absent proof checkedAt changed', () => {
    const pid = seedEligibleItem(db);
    const plan = buildOwnershipSavePlan({ db, sessionId: SESSION_ID });
    const candidate = plan.candidates[0];
    const originalCheckedAt = candidate.proofCheckedAt;

    // Mutate outcome_reason with same reason but different checkedAt
    const newCheckedAt = new Date(new Date(originalCheckedAt).getTime() + 1000).toISOString();
    db.prepare(`UPDATE import_items SET outcome_reason = ? WHERE proposal_id = ?`).run(
      `reconciled:absent:ownership-change-needed:absent:checkedAt=${newCheckedAt}`,
      pid,
    );

    const res = applyOwnershipConfirmationSelection(db, plan, { byProposalIds: [pid] });
    expect(res.confirmed).toHaveLength(0);
    expect(res.rejected[0].reason).toBe('absent_proof_reason_or_checked_at_mismatch');

    // Import item must not have been mutated
    const item = getItem(db, pid);
    expect(item?.status).toBe('approved');
    expect(item?.outcomeReason).toBeTruthy();

    // No confirmation row inserted
    const cnt = db
      .prepare('SELECT COUNT(*) AS cnt FROM import_item_confirmations WHERE proposal_id = ?')
      .get(pid) as { cnt: number };
    expect(cnt.cnt).toBe(0);
  });

  // -----------------------------------------------------------------------
  // Finding 2 — Steam AppID must match plan candidate
  // -----------------------------------------------------------------------
  it('rejects candidate whose Steam AppID changed from what the plan captured', () => {
    const pid = seedEligibleItem(db, { steamAppId: 730 });
    const plan = buildOwnershipSavePlan({ db, sessionId: SESSION_ID });

    // Ensure the target FK game row exists before mutating
    seedMinimalGame(db, 999, 'Game 999');
    db.pragma('foreign_keys = OFF');
    db.prepare('UPDATE proposals SET steam_app_id = ? WHERE id = ?').run(999, pid);
    db.prepare('UPDATE import_items SET steam_app_id = ? WHERE proposal_id = ?').run(999, pid);
    db.pragma('foreign_keys = ON');

    const res = applyOwnershipConfirmationSelection(db, plan, { byProposalIds: [pid] });
    expect(res.confirmed).toHaveLength(0);
    expect(res.rejected[0].reason).toBe('canonical_steam_appid_mismatch');

    // No confirmation row inserted
    const cnt = db
      .prepare('SELECT COUNT(*) AS cnt FROM import_item_confirmations WHERE proposal_id = ?')
      .get(pid) as { cnt: number };
    expect(cnt.cnt).toBe(0);
  });

  // -----------------------------------------------------------------------
  // Finding 3 — prompt is purely derived from plan (deterministic)
  // -----------------------------------------------------------------------
  it('prompt is deterministic across different wall-clock times', () => {
    seedEligibleItem(db, { steamAppId: 730, gameTitle: 'CS2' });
    const plan = buildOwnershipSavePlan({ db, sessionId: SESSION_ID });

    // Modify plan.builtAt to a past time to prove prompt uses plan time, not current time
    const oldPlan = { ...plan, builtAt: '2024-01-01T00:00:00.000Z' };
    const newPlan = { ...plan, builtAt: '2026-07-07T12:00:00.000Z' };

    const promptFromOld = buildOwnershipConfirmationPrompt(oldPlan);
    const promptFromNew = buildOwnershipConfirmationPrompt(newPlan);

    // Different plans (different builtAt) produce different builtAt in prompt
    expect(promptFromOld.builtAt).toBe('2024-01-01T00:00:00.000Z');
    expect(promptFromNew.builtAt).toBe('2026-07-07T12:00:00.000Z');

    // Same plan always produces identical output
    const promptAgain = buildOwnershipConfirmationPrompt(oldPlan);
    expect(promptAgain.builtAt).toBe('2024-01-01T00:00:00.000Z');
    expect(promptAgain.text).toBe(promptFromOld.text);
    expect(promptAgain.items).toEqual(promptFromOld.items);
  });

  it('module does not import Playwright or browser/runner modules', () => {
    const src = readFileSync('src/importer/ownership-save-confirmation.ts', 'utf8');
    const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const forbidden = [
      /from\s+['"]playwright['"]/,
      /visible-state/,
      /comparison/,
      /ownership-comparison-runner/,
      /backloggd\/browser/,
    ];
    for (const pat of forbidden) expect(stripped).not.toMatch(pat);
  });
});
