import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { getCreateTableSQL } from '../../src/storage/schema.js';
import { runMigrations } from '../../src/storage/database.js';
import { getItem } from '../../src/importer/import-items.js';
import {
  countOwnershipCompareFailuresForRetryByReasonPrefix,
  resetOwnershipCompareFailuresForRetryByReasonPrefix,
} from '../../src/importer/import-items.js';
import type { OwnershipRetryFailedCliDeps } from '../../src/cli/ownership-retry-failed.js';
import { runOwnershipRetryFailedCli } from '../../src/cli/ownership-retry-failed.js';

function createFreshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(getCreateTableSQL());
  runMigrations(db);
  return db;
}

function seedSession(db: Database.Database, sessionId = 'test-session'): void {
  db.prepare('INSERT OR IGNORE INTO import_sessions (id, total_games) VALUES (?, ?)').run(
    sessionId,
    0,
  );
}

function seedImportItem(
  db: Database.Database,
  fields: {
    proposalId: string;
    sessionId?: string;
    steamAppId: number;
    proposalKind?: 'ownership' | 'status' | 'playlog';
    status?: 'approved' | 'importing' | 'saved' | 'skipped' | 'failed';
    outcomeReason?: string | null;
    lastError?: string | null;
  },
): void {
  const sessionId = fields.sessionId ?? 'test-session';
  const proposalKind = fields.proposalKind ?? 'ownership';
  const status = fields.status ?? 'failed';
  seedSession(db, sessionId);
  db.prepare('INSERT OR IGNORE INTO games (app_id, title, playtime_minutes) VALUES (?, ?, ?)').run(
    fields.steamAppId,
    `Game ${fields.steamAppId}`,
    0,
  );
  db.prepare(
    `INSERT INTO proposals
       (id, import_session_id, steam_app_id, backloggd_slug, proposal_kind,
        status, match_confidence, requires_manual_review, suggested_payload)
     VALUES (?, ?, ?, ?, ?, 'approved', 'exact', 0, ?)`,
  ).run(
    fields.proposalId,
    sessionId,
    fields.steamAppId,
    `game-${fields.steamAppId}`,
    proposalKind,
    '{"platform":"steam","ownershipType":"digital"}',
  );
  db.prepare(
    `INSERT INTO import_items
       (proposal_id, import_session_id, steam_app_id, proposal_kind, frozen_payload,
        status, outcome_reason, last_error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    fields.proposalId,
    sessionId,
    fields.steamAppId,
    proposalKind,
    '{"platform":"steam","ownershipType":"digital"}',
    status,
    fields.outcomeReason ?? null,
    fields.lastError ?? null,
  );
}

function createDeps(db: Database.Database): {
  deps: OwnershipRetryFailedCliDeps;
  calls: {
    openDatabase: ReturnType<typeof vi.fn>;
    closeDatabase: ReturnType<typeof vi.fn>;
    resolveImportDbPath: ReturnType<typeof vi.fn>;
    countFailures: ReturnType<typeof vi.fn>;
    resetFailures: ReturnType<typeof vi.fn>;
    consoleLog: ReturnType<typeof vi.fn>;
    consoleError: ReturnType<typeof vi.fn>;
  };
} {
  const openDatabase = vi.fn<() => Database.Database>().mockReturnValue(db);
  const closeDatabase = vi.fn<() => void>();
  const resolveImportDbPath = vi.fn().mockReturnValue({ mode: 'fixture', dbPath: ':memory:' });
  const countFailures = vi.fn(countOwnershipCompareFailuresForRetryByReasonPrefix);
  const resetFailures = vi.fn(resetOwnershipCompareFailuresForRetryByReasonPrefix);
  const consoleLog = vi.fn<(message: string) => void>();
  const consoleError = vi.fn<(message: string) => void>();

  return {
    deps: {
      openDatabase,
      closeDatabase,
      resolveImportDbPath,
      countFailures,
      resetFailures,
      consoleLog,
      consoleError,
    },
    calls: {
      openDatabase,
      closeDatabase,
      resolveImportDbPath,
      countFailures,
      resetFailures,
      consoleLog,
      consoleError,
    },
  };
}

describe('ownership-retry-failed CLI', () => {
  it('prints help and exits 0 before DB open', async () => {
    const db = createFreshDb();
    const { deps, calls } = createDeps(db);

    const exitCode = await runOwnershipRetryFailedCli(['--help'], deps);

    expect(exitCode).toBe(0);
    expect(calls.consoleLog).toHaveBeenCalledWith(
      expect.stringContaining('Usage: npm run ownership:retry-failed'),
    );
    expect(calls.resolveImportDbPath).not.toHaveBeenCalled();
    expect(calls.openDatabase).not.toHaveBeenCalled();
    expect(calls.resetFailures).not.toHaveBeenCalled();
  });

  it('prints short help and exits 0 before DB open', async () => {
    const db = createFreshDb();
    const { deps, calls } = createDeps(db);

    const exitCode = await runOwnershipRetryFailedCli(['-h'], deps);

    expect(exitCode).toBe(0);
    expect(calls.resolveImportDbPath).not.toHaveBeenCalled();
    expect(calls.openDatabase).not.toHaveBeenCalled();
  });

  it('missing session fails before mutation', async () => {
    const db = createFreshDb();
    const { deps, calls } = createDeps(db);

    const exitCode = await runOwnershipRetryFailedCli(
      ['--reason-prefix', 'unknown:ownership:page-type:login'],
      deps,
    );

    expect(exitCode).toBe(1);
    expect(calls.resolveImportDbPath).not.toHaveBeenCalled();
    expect(calls.openDatabase).not.toHaveBeenCalled();
    expect(calls.resetFailures).not.toHaveBeenCalled();
  });

  it('blank session fails before mutation', async () => {
    const db = createFreshDb();
    const { deps, calls } = createDeps(db);

    const exitCode = await runOwnershipRetryFailedCli(
      ['--session', '   ', '--reason-prefix', 'unknown:ownership:page-type:login'],
      deps,
    );

    expect(exitCode).toBe(1);
    expect(calls.openDatabase).not.toHaveBeenCalled();
    expect(calls.resetFailures).not.toHaveBeenCalled();
  });

  it('missing reason prefix fails before mutation', async () => {
    const db = createFreshDb();
    const { deps, calls } = createDeps(db);

    const exitCode = await runOwnershipRetryFailedCli(['--session', 'test-session'], deps);

    expect(exitCode).toBe(1);
    expect(calls.resolveImportDbPath).not.toHaveBeenCalled();
    expect(calls.openDatabase).not.toHaveBeenCalled();
    expect(calls.resetFailures).not.toHaveBeenCalled();
  });

  it('blank reason prefix fails before mutation', async () => {
    const db = createFreshDb();
    const { deps, calls } = createDeps(db);

    const exitCode = await runOwnershipRetryFailedCli(
      ['--session', 'test-session', '--reason-prefix', '   '],
      deps,
    );

    expect(exitCode).toBe(1);
    expect(calls.openDatabase).not.toHaveBeenCalled();
    expect(calls.resetFailures).not.toHaveBeenCalled();
  });

  it('resets only matching local ownership compare failures', async () => {
    const db = createFreshDb();
    seedImportItem(db, {
      proposalId: 'login-failed',
      steamAppId: 101,
      status: 'failed',
      outcomeReason: 'unknown:ownership:page-type:login',
      lastError: 'Page not ready: page-type:login',
    });
    seedImportItem(db, {
      proposalId: 'login-importing',
      steamAppId: 102,
      status: 'importing',
      outcomeReason: 'unknown:ownership:page-type:login',
      lastError: 'Page not ready: page-type:login',
    });
    seedImportItem(db, {
      proposalId: 'challenge-failed',
      steamAppId: 103,
      status: 'failed',
      outcomeReason: 'unknown:ownership:page-type:challenge',
      lastError: 'Page not ready: page-type:challenge',
    });
    seedImportItem(db, {
      proposalId: 'saved-login',
      steamAppId: 104,
      status: 'saved',
      outcomeReason: 'unknown:ownership:page-type:login',
      lastError: 'terminal',
    });
    seedImportItem(db, {
      proposalId: 'skipped-login',
      steamAppId: 105,
      status: 'skipped',
      outcomeReason: 'unknown:ownership:page-type:login',
      lastError: 'terminal',
    });
    seedImportItem(db, {
      proposalId: 'status-login',
      steamAppId: 106,
      proposalKind: 'status',
      status: 'failed',
      outcomeReason: 'unknown:ownership:page-type:login',
      lastError: 'not ownership',
    });
    seedImportItem(db, {
      proposalId: 'other-session-login',
      sessionId: 'other-session',
      steamAppId: 107,
      status: 'failed',
      outcomeReason: 'unknown:ownership:page-type:login',
      lastError: 'other session',
    });
    db.prepare(
      `INSERT INTO import_item_confirmations
         (proposal_id, import_session_id, confirmation_batch_id, planned_platform,
          planned_ownership_type, planned_slug)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('saved-login', 'test-session', 'batch-1', 'steam', 'digital', 'game-104');
    const confirmationsBefore = db
      .prepare('SELECT COUNT(*) AS cnt FROM import_item_confirmations')
      .get() as { cnt: number };

    const { deps, calls } = createDeps(db);
    const exitCode = await runOwnershipRetryFailedCli(
      ['--session', 'test-session', '--reason-prefix', 'unknown:ownership:page-type:login'],
      deps,
    );

    expect(exitCode).toBe(0);
    expect(calls.countFailures).toHaveBeenCalled();
    expect(calls.resetFailures).toHaveBeenCalled();
    expect(getItem(db, 'login-failed')?.status).toBe('approved');
    expect(getItem(db, 'login-failed')?.outcomeReason).toBeNull();
    expect(getItem(db, 'login-failed')?.lastError).toBeNull();
    expect(getItem(db, 'login-importing')?.status).toBe('approved');
    expect(getItem(db, 'challenge-failed')?.status).toBe('failed');
    expect(getItem(db, 'saved-login')?.status).toBe('saved');
    expect(getItem(db, 'skipped-login')?.status).toBe('skipped');
    expect(getItem(db, 'status-login')?.status).toBe('failed');
    expect(getItem(db, 'other-session-login')?.status).toBe('failed');
    const counters = db
      .prepare(
        `SELECT approved_changes, applied_changes, skipped_games, failed_games
         FROM import_sessions
         WHERE id = ?`,
      )
      .get('test-session') as {
      approved_changes: number;
      applied_changes: number;
      skipped_games: number;
      failed_games: number;
    };
    expect(counters).toEqual({
      approved_changes: 2,
      applied_changes: 1,
      skipped_games: 1,
      failed_games: 2,
    });
    const confirmationsAfter = db
      .prepare('SELECT COUNT(*) AS cnt FROM import_item_confirmations')
      .get() as { cnt: number };
    expect(confirmationsAfter.cnt).toBe(confirmationsBefore.cnt);
    expect(calls.consoleLog).toHaveBeenCalledWith('Matched rows: 2');
    expect(calls.consoleLog).toHaveBeenCalledWith('Reset rows: 2');
  });

  it('dry-run reports matches without resetting rows', async () => {
    const db = createFreshDb();
    seedImportItem(db, {
      proposalId: 'login-failed',
      steamAppId: 201,
      status: 'failed',
      outcomeReason: 'unknown:ownership:page-type:login',
      lastError: 'Page not ready: page-type:login',
    });
    const { deps, calls } = createDeps(db);

    const exitCode = await runOwnershipRetryFailedCli(
      [
        '--session',
        'test-session',
        '--reason-prefix',
        'unknown:ownership:page-type:login',
        '--dry-run',
      ],
      deps,
    );

    expect(exitCode).toBe(0);
    expect(calls.resetFailures).not.toHaveBeenCalled();
    expect(getItem(db, 'login-failed')?.status).toBe('failed');
    expect(calls.consoleLog).toHaveBeenCalledWith('Matched rows: 1');
    expect(calls.consoleLog).toHaveBeenCalledWith('Reset rows: 0');
  });

  it('is idempotent on second run', async () => {
    const db = createFreshDb();
    seedImportItem(db, {
      proposalId: 'login-failed',
      steamAppId: 301,
      status: 'failed',
      outcomeReason: 'unknown:ownership:page-type:login',
      lastError: 'Page not ready: page-type:login',
    });
    const { deps: firstDeps } = createDeps(db);
    const { deps: secondDeps, calls: secondCalls } = createDeps(db);

    await runOwnershipRetryFailedCli(
      ['--session', 'test-session', '--reason-prefix', 'unknown:ownership:page-type:login'],
      firstDeps,
    );
    const exitCode = await runOwnershipRetryFailedCli(
      ['--session', 'test-session', '--reason-prefix', 'unknown:ownership:page-type:login'],
      secondDeps,
    );

    expect(exitCode).toBe(0);
    expect(secondCalls.consoleLog).toHaveBeenCalledWith('Matched rows: 0');
    expect(secondCalls.consoleLog).toHaveBeenCalledWith('Reset rows: 0');
  });
});

describe('ownership-retry-failed static safety', () => {
  const source = readFileSync(resolve('src/cli/ownership-retry-failed.ts'), 'utf-8');
  const importLines = source
    .split('\n')
    .filter((line) => line.trimStart().startsWith('import'))
    .join('\n');
  const scripts = JSON.parse(readFileSync(resolve('package.json'), 'utf-8')).scripts as Record<
    string,
    string
  >;

  it('package script exists and is not chained', () => {
    const script = scripts['ownership:retry-failed'];
    expect(script).toBe('node --import dotenv/config dist/cli/ownership-retry-failed.js');
    expect(script).not.toMatch(/&&|;|\|\||\|/);
    expect(script).not.toContain('ownership:compare');
    expect(script).not.toContain('ownership:confirm');
    expect(script).not.toContain('ownership:save');
  });

  it('does not import browser, Backloggd, confirm, save, or compare paths', () => {
    expect(importLines).not.toContain('../backloggd/');
    expect(importLines).not.toContain('ownership-compare');
    expect(importLines).not.toContain('ownership-confirm');
    expect(importLines).not.toContain('ownership-save');
    expect(importLines).not.toContain('ownership-save-command');
    expect(importLines).not.toContain('ownership-save-executor');
    expect(importLines).not.toContain('ownership-staging-executor');
    expect(importLines).not.toContain('ownership-save-confirmation');
  });
});
