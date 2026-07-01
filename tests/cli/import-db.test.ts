import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { getCreateTableSQL } from '../../src/storage/schema.js';
import { runProposalGenerate } from '../../src/cli/proposal-generate.js';
import { runProposalApprove } from '../../src/cli/proposal-approve.js';
import { runProposalManifest } from '../../src/cli/proposal-manifest.js';

function createDb(path: string): Database.Database {
  const db = new Database(path);
  db.exec(getCreateTableSQL());
  return db;
}

function seedFixtureData(path: string): void {
  const db = createDb(path);
  db.prepare('INSERT INTO games (app_id, title, playtime_minutes, stale) VALUES (?, ?, ?, 0)').run(
    730,
    'CS2',
    120,
  );
  db.prepare(
    `INSERT INTO matches (steam_app_id, igdb_id, igdb_name, backloggd_slug, confidence, match_method)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(730, 12345, 'Counter-Strike 2', 'counter-strike-2', 'exact', 'steam-appid');
  db.close();
}

function liveProposalCount(path: string): number {
  const db = new Database(path);
  const row = db.prepare('SELECT COUNT(*) AS cnt FROM proposals').get() as { cnt: number };
  db.close();
  return row.cnt;
}

function liveSessionCount(path: string): number {
  const db = new Database(path);
  const row = db.prepare('SELECT COUNT(*) AS cnt FROM import_sessions').get() as { cnt: number };
  db.close();
  return row.cnt;
}

describe.sequential('Milestone 3 CLI fixture/live DB isolation', () => {
  let tempDir: string;
  let previousCwd: string;
  let fixturePath: string;
  let livePath: string;
  let fixtureEnv: NodeJS.ProcessEnv;

  beforeEach(async () => {
    previousCwd = process.cwd();
    tempDir = await mkdtemp(join(tmpdir(), 'backloggd-import-m3-'));
    process.chdir(tempDir);

    fixturePath = join(tempDir, 'import.fixture.db');
    livePath = join(tempDir, 'import.db');

    seedFixtureData(fixturePath);
    const liveDb = createDb(livePath);
    liveDb.close();

    fixtureEnv = {
      DB_PATH: livePath,
      STEAM_API_KEY: undefined,
      STEAM_USER_ID: undefined,
      IGDB_CLIENT_ID: undefined,
      IGDB_CLIENT_SECRET: undefined,
    };
  });

  afterEach(async () => {
    process.chdir(previousCwd);
    await rm(tempDir, { recursive: true, force: true });
  });

  it('fixture-mode proposal generation uses the fixture database', () => {
    const result = runProposalGenerate([], fixtureEnv);
    expect(result.ownershipProposals).toBe(1);

    const fixtureDb = new Database(fixturePath);
    const fixtureCount = fixtureDb
      .prepare("SELECT COUNT(*) AS cnt FROM proposals WHERE proposal_kind = 'ownership'")
      .get() as {
      cnt: number;
    };
    fixtureDb.close();

    expect(fixtureCount.cnt).toBe(1);
    expect(liveProposalCount(livePath)).toBe(0);
  });

  it('fixture-mode approval uses the fixture database', () => {
    runProposalGenerate([], fixtureEnv);

    const approve = runProposalApprove(fixtureEnv);
    expect(approve.approved).toBe(1);

    const fixtureDb = new Database(fixturePath);
    const approved = fixtureDb
      .prepare("SELECT COUNT(*) AS cnt FROM proposals WHERE status = 'approved'")
      .get() as { cnt: number };
    fixtureDb.close();

    expect(approved.cnt).toBe(1);

    const liveDb = new Database(livePath);
    const liveApproved = liveDb
      .prepare("SELECT COUNT(*) AS cnt FROM proposals WHERE status = 'approved'")
      .get() as { cnt: number };
    liveDb.close();
    expect(liveApproved.cnt).toBe(0);
  });

  it('fixture-mode manifest export uses the fixture database', async () => {
    runProposalGenerate([], fixtureEnv);
    runProposalApprove(fixtureEnv);

    const result = await runProposalManifest([], fixtureEnv);
    expect(result.manifest.summary.totalApproved).toBe(1);
    expect(result.manifest.items[0].steamAppId).toBe(730);
  });

  it('live database remains unchanged during fixture-mode import commands', async () => {
    const beforeProposals = liveProposalCount(livePath);
    const beforeSessions = liveSessionCount(livePath);

    runProposalGenerate([], fixtureEnv);
    runProposalApprove(fixtureEnv);
    await runProposalManifest([], fixtureEnv);

    const afterProposals = liveProposalCount(livePath);
    const afterSessions = liveSessionCount(livePath);

    expect(afterProposals).toBe(beforeProposals);
    expect(afterSessions).toBe(beforeSessions);
  });
});
