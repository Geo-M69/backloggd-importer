/**
 * Static safety and executable tests for the import:seed-items CLI
 * (Phase 5F Slice 4h).
 *
 * Static tests verify by source inspection that the CLI:
 * - Does not import Playwright or Backloggd browser modules.
 * - Does not import ownership confirm/save modules.
 * - Has help safety before any side effects.
 * - Package script exists and is not chained with compare/confirm/save.
 *
 * Executable tests verify with a temp database and temp manifest that:
 * - Missing manifest fails safely.
 * - Nonexistent manifest fails safely.
 * - Invalid JSON fails safely.
 * - Invalid manifest shape fails safely.
 * - Valid manifest seeds import_items through the real library path.
 * - Command does not create import_item_confirmations.
 * - Command does not alter proposal statuses unexpectedly.
 */

import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { getCreateTableSQL } from '../../src/storage/schema.js';
import { runMigrations } from '../../src/storage/database.js';
import { buildManifest } from '../../src/review/manifest.js';
import { runSeedItems } from '../../src/cli/import-seed-items.js';
import type { ImportManifest } from '../../src/review/manifest.js';

// ---------------------------------------------------------------------------
// Constants — paths for source inspection
// ---------------------------------------------------------------------------

const CLI_SOURCE_PATH = resolve('src/cli/import-seed-items.ts');
const SOURCE = readFileSync(CLI_SOURCE_PATH, 'utf-8');

const PACKAGE_JSON_PATH = resolve('package.json');
const PACKAGE_JSON = readFileSync(PACKAGE_JSON_PATH, 'utf-8');
const PACKAGE = JSON.parse(PACKAGE_JSON) as { scripts?: Record<string, string> };
const SCRIPTS = PACKAGE.scripts ?? {};

// ---------------------------------------------------------------------------
// Helper — credential env for live mode
// ---------------------------------------------------------------------------

function liveModeEnv(dbPath: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    STEAM_API_KEY: 'test-key',
    STEAM_USER_ID: 'test-user',
    IGDB_CLIENT_ID: 'test-igdb-id',
    IGDB_CLIENT_SECRET: 'test-igdb-secret',
    DB_PATH: dbPath,
  };
}

// ---------------------------------------------------------------------------
// Static safety tests
// ---------------------------------------------------------------------------

describe('import:seed-items CLI — static import safety', () => {
  it('does not import playwright', () => {
    const importLines = SOURCE.split('\n').filter(
      (l) => l.includes('import') && l.includes('playwright'),
    );
    expect(importLines).toHaveLength(0);
  });

  it('does not import backloggd browser modules', () => {
    const importLines = SOURCE.split('\n').filter(
      (l) => l.includes('import') && l.includes('backloggd'),
    );
    expect(importLines).toHaveLength(0);
  });

  it('does not import ownership confirm modules', () => {
    const forbidden = [
      'ownership-save-confirm',
      'ownership-confirm',
      'ownership-save-command',
      'ownership-save-executor',
      'ownership-save-plan',
      'ownership-staging-executor',
      'ownership-comparison-runner',
      'ownership-compare-command',
    ];
    const importLines = SOURCE.split('\n').filter((l) => l.includes('import'));
    for (const mod of forbidden) {
      const bad = importLines.filter((l) => l.includes(mod));
      expect(bad).toHaveLength(0);
    }
  });

  it('does not import confirmation or save executor symbols', () => {
    const forbidden = [
      'applyOwnershipConfirmationSelection',
      'runConfirmedOwnershipSave',
      'executeConfirmedOwnershipSaves',
      'runOwnershipComparison',
      'runOwnershipCompareCommand',
      'buildOwnershipSavePlan',
      'runConfirmedOwnershipStaging',
    ];
    for (const sym of forbidden) {
      expect(SOURCE).not.toContain(sym);
    }
  });

  it('imports hasHelpFlag from cli-help', () => {
    expect(SOURCE).toContain("import { hasHelpFlag } from './cli-help.js'");
  });

  it('has usage text with npm run pattern', () => {
    expect(SOURCE).toMatch(/Usage: npm run import:seed-items/);
  });

  it('exits 0 for help before any side effects', () => {
    expect(SOURCE).toContain('process.exit(0)');
    const helpLine = SOURCE.indexOf('hasHelpFlag(args)');
    expect(helpLine).not.toBe(-1);

    const mainStart = SOURCE.indexOf('async function main');
    expect(mainStart).not.toBe(-1);

    const beforeHelp = SOURCE.slice(mainStart, helpLine);
    const dbOpens = (beforeHelp.match(/openDatabase/g) || []).length;
    const manifestReads = (beforeHelp.match(/readFileSync/g) || []).length;
    expect(dbOpens).toBe(0);
    expect(manifestReads).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Executable tests
// ---------------------------------------------------------------------------

describe('import:seed-items CLI — executable behavior', () => {
  let tmpDir: string;
  let dbPath: string;

  function makeManifestPath(name: string): string {
    return join(tmpDir, name);
  }

  function writeManifest(data: unknown, name = 'manifest.json'): string {
    const path = makeManifestPath(name);
    writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8');
    return path;
  }

  function createDb(): Database.Database {
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.exec(getCreateTableSQL());
    runMigrations(db);
    return db;
  }

  function seedMinimalSession(db: Database.Database, sessionId = 'test-seed-session'): void {
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

  function seedApprovedProposal(
    db: Database.Database,
    id: string,
    appId: number,
    sessionId = 'test-seed-session',
  ): void {
    seedMinimalSession(db, sessionId);
    seedMinimalGame(db, appId, `Game ${appId}`);

    db.prepare(
      `INSERT INTO proposals
         (id, import_session_id, steam_app_id, igdb_id, backloggd_slug,
          proposal_kind, status, match_confidence,
          requires_manual_review, suggested_payload,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
               strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
               strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       ON CONFLICT(import_session_id, steam_app_id, proposal_kind) DO UPDATE SET
         id = excluded.id,
         status = excluded.status,
         suggested_payload = excluded.suggested_payload,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    ).run(
      id,
      sessionId,
      appId,
      10000 + appId,
      `game-${appId}`,
      'ownership',
      'approved',
      'exact',
      0,
      '{"platform":"steam","ownershipType":"digital"}',
    );
  }

  function buildValidManifest(
    db: Database.Database,
    importSessionId = 'test-seed-session',
  ): ImportManifest {
    return buildManifest(importSessionId, db);
  }

  function countImportItems(db: Database.Database): number {
    const row = db.prepare('SELECT COUNT(*) AS cnt FROM import_items').get() as { cnt: number };
    return row.cnt;
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'import-seed-items-test-'));
    dbPath = join(tmpDir, 'test.db');
  });

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // Test 1: nonexistent manifest path fails safely
  // -----------------------------------------------------------------------
  it('fails safely when manifest file does not exist', () => {
    const env = liveModeEnv(dbPath);
    expect(() => runSeedItems('/nonexistent/path/manifest.json', env)).toThrow(
      /Cannot read manifest/,
    );
  });

  // -----------------------------------------------------------------------
  // Test 2: invalid JSON fails safely
  // -----------------------------------------------------------------------
  it('fails safely when manifest contains invalid JSON', () => {
    const manifestPath = makeManifestPath('bad.json');
    writeFileSync(manifestPath, 'not valid json{{{', 'utf-8');
    const env = liveModeEnv(dbPath);
    expect(() => runSeedItems(manifestPath, env)).toThrow(/Invalid JSON/);
  });

  // -----------------------------------------------------------------------
  // Test 3: invalid manifest shape (missing manifestVersion)
  // -----------------------------------------------------------------------
  it('fails safely when manifest has no manifestVersion', () => {
    const badManifest = { items: [] };
    const manifestPath = writeManifest(badManifest);
    const env = liveModeEnv(dbPath);
    expect(() => runSeedItems(manifestPath, env)).toThrow(
      /Manifest must have a string manifestVersion/,
    );
  });

  // -----------------------------------------------------------------------
  // Test 4: invalid manifest shape (missing items array)
  // -----------------------------------------------------------------------
  it('fails safely when manifest has no items array', () => {
    const badManifest = { manifestVersion: '2.0.0' };
    const manifestPath = writeManifest(badManifest);
    const env = liveModeEnv(dbPath);
    expect(() => runSeedItems(manifestPath, env)).toThrow(/Manifest must have an items array/);
  });

  // -----------------------------------------------------------------------
  // Test 5: invalid manifest shape (items not an array)
  // -----------------------------------------------------------------------
  it('fails safely when manifest items is not an array', () => {
    const badManifest = { manifestVersion: '2.0.0', items: 'not-an-array' };
    const manifestPath = writeManifest(badManifest);
    const env = liveModeEnv(dbPath);
    expect(() => runSeedItems(manifestPath, env)).toThrow(/Manifest must have an items array/);
  });

  // -----------------------------------------------------------------------
  // Test 6: valid manifest seeds import_items
  // -----------------------------------------------------------------------
  it('seeds import_items from a valid manifest', () => {
    const db = createDb();
    seedApprovedProposal(db, 'p-seed-valid-1', 730);
    seedApprovedProposal(db, 'p-seed-valid-2', 440);
    db.close();

    const manifest = buildValidManifest(createDb());
    const manifestPath = writeManifest(manifest, 'valid-manifest.json');

    const env = liveModeEnv(dbPath);
    const result = runSeedItems(manifestPath, env);

    expect(result.totalManifestProposals).toBe(2);
    expect(result.created).toBe(2);
    expect(result.drifted).toBe(0);
    expect(result.alreadyPresent).toBe(0);
    expect(result.preserved).toBe(0);

    const verifyDb = createDb();
    const items = verifyDb
      .prepare('SELECT proposal_id, status, proposal_kind, steam_app_id FROM import_items')
      .all() as {
      proposal_id: string;
      status: string;
      proposal_kind: string;
      steam_app_id: number;
    }[];
    verifyDb.close();

    expect(items).toHaveLength(2);

    const item1 = items.find((i) => i.proposal_id === 'p-seed-valid-1');
    expect(item1).toBeTruthy();
    expect(item1?.status).toBe('approved');
    expect(item1?.proposal_kind).toBe('ownership');
    expect(item1?.steam_app_id).toBe(730);

    const item2 = items.find((i) => i.proposal_id === 'p-seed-valid-2');
    expect(item2).toBeTruthy();
    expect(item2?.status).toBe('approved');
    expect(item2?.proposal_kind).toBe('ownership');
    expect(item2?.steam_app_id).toBe(440);
  });

  // -----------------------------------------------------------------------
  // Test 7: command does not create import_item_confirmations
  // -----------------------------------------------------------------------
  it('does not create import_item_confirmations', () => {
    const db = createDb();
    seedApprovedProposal(db, 'p-no-confirm', 730);
    db.close();

    const manifest = buildValidManifest(createDb());
    const manifestPath = writeManifest(manifest, 'no-confirm-manifest.json');

    const env = liveModeEnv(dbPath);
    const result = runSeedItems(manifestPath, env);
    expect(result.created).toBeGreaterThan(0);

    const verifyDb = createDb();
    const confirmCount = verifyDb
      .prepare('SELECT COUNT(*) AS cnt FROM import_item_confirmations')
      .get() as { cnt: number };
    verifyDb.close();
    expect(confirmCount.cnt).toBe(0);
  });

  // -----------------------------------------------------------------------
  // Test 8: command does not alter proposal statuses
  // -----------------------------------------------------------------------
  it('does not alter proposal statuses', () => {
    const db = createDb();
    seedApprovedProposal(db, 'p-no-status-change', 730);

    const approvedBefore = (
      db.prepare("SELECT COUNT(*) AS cnt FROM proposals WHERE status = 'approved'").get() as {
        cnt: number;
      }
    ).cnt;
    expect(approvedBefore).toBeGreaterThan(0);
    db.close();

    const manifest = buildValidManifest(createDb());
    const manifestPath = writeManifest(manifest, 'no-status-change-manifest.json');

    const env = liveModeEnv(dbPath);
    runSeedItems(manifestPath, env);

    const verifyDb = createDb();
    const approvedAfter = (
      verifyDb.prepare("SELECT COUNT(*) AS cnt FROM proposals WHERE status = 'approved'").get() as {
        cnt: number;
      }
    ).cnt;
    verifyDb.close();
    expect(approvedAfter).toBe(approvedBefore);
  });

  // -----------------------------------------------------------------------
  // Test 9: re-running is idempotent
  // -----------------------------------------------------------------------
  it('is idempotent when re-running with the same manifest', () => {
    const db = createDb();
    seedApprovedProposal(db, 'p-idempotent', 730);
    db.close();

    const manifest = buildValidManifest(createDb());
    const manifestPath = writeManifest(manifest, 'idempotent-manifest.json');

    const env = liveModeEnv(dbPath);

    const result1 = runSeedItems(manifestPath, env);
    expect(result1.created).toBe(1);

    const verify1 = createDb();
    expect(countImportItems(verify1)).toBe(1);
    verify1.close();

    const result2 = runSeedItems(manifestPath, env);
    expect(result2.created).toBe(0);
    expect(result2.alreadyPresent).toBe(1);

    const verify2 = createDb();
    expect(countImportItems(verify2)).toBe(1);
    verify2.close();
  });

  // -----------------------------------------------------------------------
  // Test 10: rejected drift does not create partial import_items
  // -----------------------------------------------------------------------
  it('rejects entire manifest on drift without creating partial items', () => {
    const db = createDb();
    seedApprovedProposal(db, 'p-drift-a', 730, 'test-seed-session');
    seedApprovedProposal(db, 'p-drift-b', 440, 'test-seed-session');

    const manifest = buildValidManifest(db, 'test-seed-session');

    db.prepare(
      `UPDATE proposals
       SET suggested_payload = '{"platform":"steam","ownershipType":"physical"}',
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ?`,
    ).run('p-drift-b');
    db.close();

    const manifestPath = writeManifest(manifest, 'drift-manifest.json');
    const env = liveModeEnv(dbPath);

    expect(() => runSeedItems(manifestPath, env)).toThrow();

    const verifyDb = createDb();
    expect(countImportItems(verifyDb)).toBe(0);
    verifyDb.close();
  });
});

// ---------------------------------------------------------------------------
// Package script safety tests
// ---------------------------------------------------------------------------

describe('import:seed-items — package script safety', () => {
  it('has import:seed-items script', () => {
    expect(SCRIPTS).toHaveProperty('import:seed-items');
  });

  it('points only to import-seed-items CLI', () => {
    const script = SCRIPTS['import:seed-items'];
    expect(script).toBe('node --import dotenv/config dist/cli/import-seed-items.js');
  });

  it('is not chained with compare/confirm/save commands', () => {
    const script = SCRIPTS['import:seed-items'];
    const chainedCommands = ['ownership:compare', 'ownership:confirm', 'ownership:save'];
    for (const cmd of chainedCommands) {
      expect(script).not.toContain(cmd);
    }
  });
});
