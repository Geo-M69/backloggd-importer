import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/database.js';
import { generateProposals } from '../../src/review/generator.js';
import { getCreateTableSQL } from '../../src/storage/schema.js';
import { playlogPayload } from '../../src/review/payloads.js';

describe('database migrations', () => {
  it('adds the stale column to an existing games table via runMigrations()', () => {
    // Create a database with the old schema (without `stale` column)
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    db.exec(`
      CREATE TABLE IF NOT EXISTS games (
        app_id              INTEGER PRIMARY KEY,
        title               TEXT    NOT NULL,
        icon_url            TEXT,
        playtime_minutes    INTEGER NOT NULL DEFAULT 0 CHECK (typeof(playtime_minutes) = 'integer' AND playtime_minutes >= 0),
        last_played_at      TEXT,
        is_free             INTEGER NOT NULL DEFAULT 0 CHECK (typeof(is_free) = 'integer' AND is_free IN (0, 1)),
        has_details         INTEGER NOT NULL DEFAULT 1 CHECK (typeof(has_details) = 'integer' AND has_details IN (0, 1)),
        created_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
    `);

    // Insert a row before migration to prove existing data survives
    db.prepare('INSERT INTO games (app_id, title, playtime_minutes) VALUES (?, ?, ?)').run(
      730,
      'CS2',
      100,
    );

    // Verify stale does not exist yet
    const before = (db.pragma('table_info(games)') as { name: string }[]).map((col) => col.name);
    expect(before).not.toContain('stale');

    // Run the actual migration function
    runMigrations(db);

    // Verify stale now exists
    const after = (db.pragma('table_info(games)') as { name: string }[]).map((col) => col.name);
    expect(after).toContain('stale');

    // Existing row is preserved and stale defaults to 0
    const row = db.prepare('SELECT app_id, stale FROM games WHERE app_id = ?').get(730) as {
      app_id: number;
      stale: number;
    };
    expect(row.app_id).toBe(730);
    expect(row.stale).toBe(0);

    db.close();
  });

  it('is idempotent — runMigrations() does not error when stale already exists', () => {
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    // Create the table WITH stale already present (e.g.
    // opened a second time with getCreateTableSQL())
    db.exec(`
      CREATE TABLE IF NOT EXISTS games (
        app_id              INTEGER PRIMARY KEY,
        title               TEXT    NOT NULL,
        stale               INTEGER NOT NULL DEFAULT 0,
        created_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
    `);

    // This must not throw
    expect(() => runMigrations(db)).not.toThrow();

    db.close();
  });

  it('migrates old proposals schema rows and is idempotent', () => {
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    // Old-style base tables
    db.exec(`
      CREATE TABLE IF NOT EXISTS games (
        app_id              INTEGER PRIMARY KEY,
        title               TEXT NOT NULL,
        playtime_minutes    INTEGER NOT NULL DEFAULT 0,
        created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );

      CREATE TABLE IF NOT EXISTS import_sessions (
        id TEXT PRIMARY KEY,
        started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        status TEXT NOT NULL DEFAULT 'in-progress' CHECK (status IN ('in-progress', 'paused', 'completed', 'aborted')),
        total_games INTEGER NOT NULL DEFAULT 0,
        matched_games INTEGER NOT NULL DEFAULT 0,
        proposed_changes INTEGER NOT NULL DEFAULT 0,
        approved_changes INTEGER NOT NULL DEFAULT 0,
        applied_changes INTEGER NOT NULL DEFAULT 0,
        skipped_games INTEGER NOT NULL DEFAULT 0,
        failed_games INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS proposals (
        id                  TEXT    PRIMARY KEY,
        import_session_id   TEXT    NOT NULL,
        steam_app_id        INTEGER NOT NULL,
        igdb_id             INTEGER NOT NULL,
        backloggd_slug      TEXT    NOT NULL,
        action              TEXT    NOT NULL CHECK (action IN ('add-ownership', 'update-status', 'add-to-backlog', 'mark-played')),
        status              TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'skipped', 'applied', 'failed')),
        match_confidence    TEXT    NOT NULL CHECK (match_confidence IN ('exact', 'probable', 'ambiguous', 'unmatched')),
        notes               TEXT,
        created_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        FOREIGN KEY (steam_app_id) REFERENCES games(app_id),
        FOREIGN KEY (import_session_id) REFERENCES import_sessions(id)
      );
    `);

    db.prepare('INSERT INTO games (app_id, title) VALUES (?, ?)').run(730, 'CS2');
    db.prepare('INSERT INTO games (app_id, title) VALUES (?, ?)').run(440, 'TF2');
    db.prepare('INSERT INTO import_sessions (id) VALUES (?)').run('s1');

    db.prepare(
      `INSERT INTO proposals
         (id, import_session_id, steam_app_id, igdb_id, backloggd_slug, action, status, match_confidence, notes)
       VALUES
         (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('p1', 's1', 730, 12345, 'counter-strike-2', 'add-ownership', 'approved', 'exact', 'ok');

    db.prepare(
      `INSERT INTO proposals
         (id, import_session_id, steam_app_id, igdb_id, backloggd_slug, action, status, match_confidence, notes)
       VALUES
         (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('p2', 's1', 440, 12346, 'team-fortress-2', 'add-to-backlog', 'pending', 'probable', null);

    // First migration pass
    expect(() => runMigrations(db)).not.toThrow();

    const migrated = db
      .prepare(
        `SELECT id, proposal_kind, status, match_confidence, requires_manual_review
         FROM proposals ORDER BY id`,
      )
      .all() as {
      id: string;
      proposal_kind: string;
      status: string;
      match_confidence: string;
      requires_manual_review: number;
    }[];

    expect(migrated).toHaveLength(2);
    expect(migrated[0]).toMatchObject({
      id: 'p1',
      proposal_kind: 'ownership',
      status: 'approved',
      match_confidence: 'exact',
      requires_manual_review: 0,
    });
    expect(migrated[1]).toMatchObject({
      id: 'p2',
      proposal_kind: 'status',
      status: 'pending',
      match_confidence: 'probable',
      requires_manual_review: 0,
    });

    // Second migration pass must be idempotent
    expect(() => runMigrations(db)).not.toThrow();
    const count = db.prepare('SELECT COUNT(*) AS cnt FROM proposals').get() as { cnt: number };
    expect(count.cnt).toBe(2);

    db.close();
  });

  it('migrates old proposals with matches backfill and survives regeneration', () => {
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    db.exec(`
      CREATE TABLE IF NOT EXISTS games (
        app_id              INTEGER PRIMARY KEY,
        title               TEXT NOT NULL,
        playtime_minutes    INTEGER NOT NULL DEFAULT 0,
        created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );

      CREATE TABLE IF NOT EXISTS matches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        steam_app_id INTEGER NOT NULL UNIQUE,
        igdb_id INTEGER,
        igdb_name TEXT,
        backloggd_slug TEXT,
        confidence TEXT NOT NULL DEFAULT 'unmatched',
        match_method TEXT,
        matched_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        FOREIGN KEY (steam_app_id) REFERENCES games(app_id)
      );

      CREATE TABLE IF NOT EXISTS import_sessions (
        id                  TEXT PRIMARY KEY,
        started_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        completed_at        TEXT,
        status              TEXT NOT NULL DEFAULT 'in-progress',
        total_games         INTEGER NOT NULL DEFAULT 0,
        matched_games       INTEGER NOT NULL DEFAULT 0,
        proposed_changes    INTEGER NOT NULL DEFAULT 0,
        approved_changes    INTEGER NOT NULL DEFAULT 0,
        applied_changes     INTEGER NOT NULL DEFAULT 0,
        skipped_games       INTEGER NOT NULL DEFAULT 0,
        failed_games        INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS proposals (
        id                  TEXT    PRIMARY KEY,
        import_session_id   TEXT    NOT NULL,
        steam_app_id        INTEGER NOT NULL,
        igdb_id             INTEGER NOT NULL,
        backloggd_slug      TEXT    NOT NULL,
        action              TEXT    NOT NULL CHECK (action IN ('add-ownership', 'update-status', 'add-to-backlog', 'mark-played')),
        status              TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'skipped', 'applied', 'failed')),
        match_confidence    TEXT    NOT NULL CHECK (match_confidence IN ('exact', 'probable', 'ambiguous', 'unmatched')),
        notes               TEXT,
        created_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        FOREIGN KEY (steam_app_id) REFERENCES games(app_id),
        FOREIGN KEY (import_session_id) REFERENCES import_sessions(id)
      );
    `);

    db.prepare('INSERT INTO games (app_id, title) VALUES (?, ?)').run(730, 'CS2');
    db.prepare(
      'INSERT INTO matches (steam_app_id, igdb_id, igdb_name, backloggd_slug, confidence) VALUES (?, ?, ?, ?, ?)',
    ).run(730, 12345, 'Counter-Strike 2', 'counter-strike-2', 'exact');
    db.prepare('INSERT INTO import_sessions (id, status) VALUES (?, ?)').run('s1', 'in-progress');
    db.prepare(
      `INSERT INTO proposals (id, import_session_id, steam_app_id, igdb_id, backloggd_slug, action, status, match_confidence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('p1', 's1', 730, 12345, 'counter-strike-2', 'add-ownership', 'approved', 'exact');

    // Migrate
    expect(() => runMigrations(db)).not.toThrow();

    // Check igdb_name was backfilled
    const p1 = db
      .prepare('SELECT igdb_name, steam_title FROM proposals WHERE id = ?')
      .get('p1') as { igdb_name: string | null; steam_title: string | null };
    expect(p1.igdb_name).toBe('Counter-Strike 2');
    expect(p1.steam_title).toBe('CS2');

    // Regeneration should not demote unchanged approved proposal
    generateProposals(db);

    const after = db.prepare('SELECT status FROM proposals WHERE id = ?').get('p1') as {
      status: string;
    };
    expect(after.status).toBe('approved');

    db.close();
  });

  it('openDatabase works on old schema database', () => {
    // Validate getCreateTableSQL + runMigrations on an old-style DB in memory
    // that had `action` instead of `proposal_kind`, `steam_title`, etc.
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    // Old schema (no steam_title, no igdb_name, has `action`)
    db.exec(`
      CREATE TABLE IF NOT EXISTS games (
        app_id              INTEGER PRIMARY KEY,
        title               TEXT NOT NULL,
        playtime_minutes    INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS matches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        steam_app_id INTEGER NOT NULL UNIQUE,
        igdb_id INTEGER,
        igdb_name TEXT,
        backloggd_slug TEXT,
        confidence TEXT NOT NULL DEFAULT 'unmatched',
        match_method TEXT,
        matched_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        FOREIGN KEY (steam_app_id) REFERENCES games(app_id)
      );
      CREATE TABLE IF NOT EXISTS import_sessions (
        id TEXT PRIMARY KEY
      );
      CREATE TABLE IF NOT EXISTS proposals (
        id               TEXT PRIMARY KEY,
        import_session_id TEXT NOT NULL,
        steam_app_id      INTEGER NOT NULL,
        igdb_id           INTEGER NOT NULL,
        backloggd_slug    TEXT NOT NULL,
        action            TEXT NOT NULL,
        status            TEXT NOT NULL DEFAULT 'pending',
        match_confidence  TEXT NOT NULL,
        notes             TEXT,
        created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        FOREIGN KEY (steam_app_id) REFERENCES games(app_id),
        FOREIGN KEY (import_session_id) REFERENCES import_sessions(id)
      );
    `);

    db.prepare('INSERT INTO games (app_id, title) VALUES (?, ?)').run(730, 'CS2');
    db.prepare(
      'INSERT INTO matches (steam_app_id, igdb_id, igdb_name, backloggd_slug, confidence) VALUES (?, ?, ?, ?, ?)',
    ).run(730, 12345, 'Counter-Strike 2', 'counter-strike-2', 'exact');
    db.prepare('INSERT INTO import_sessions (id) VALUES (?)').run('s1');
    db.prepare(
      `INSERT INTO proposals (id, import_session_id, steam_app_id, igdb_id, backloggd_slug, action, status, match_confidence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('p1', 's1', 730, 12345, 'counter-strike-2', 'add-ownership', 'approved', 'exact');

    // Now simulate openDatabase: getCreateTableSQL + runMigrations
    // getCreateTableSQL should not fail on old table
    expect(() => db.exec(getCreateTableSQL())).not.toThrow();

    // Now run migrations
    expect(() => runMigrations(db)).not.toThrow();

    // Verify migrated
    const migrated = db
      .prepare('SELECT proposal_kind, status, igdb_name, steam_title FROM proposals WHERE id = ?')
      .get('p1') as {
      proposal_kind: string;
      status: string;
      igdb_name: string | null;
      steam_title: string | null;
    };
    expect(migrated.proposal_kind).toBe('ownership');
    expect(migrated.status).toBe('approved');
    expect(migrated.igdb_name).toBe('Counter-Strike 2');
    expect(migrated.steam_title).toBe('CS2');

    db.close();
  });

  it('migrates old mark-played proposal and survives regeneration without false drift', () => {
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    // Old schema
    db.exec(`
      CREATE TABLE IF NOT EXISTS games (
        app_id              INTEGER PRIMARY KEY,
        title               TEXT NOT NULL,
        icon_url            TEXT,
        playtime_minutes    INTEGER NOT NULL DEFAULT 0,
        last_played_at      TEXT,
        is_free             INTEGER NOT NULL DEFAULT 0,
        has_details         INTEGER NOT NULL DEFAULT 1,
        stale               INTEGER NOT NULL DEFAULT 0,
        created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      CREATE TABLE IF NOT EXISTS matches (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        steam_app_id        INTEGER NOT NULL UNIQUE,
        igdb_id             INTEGER,
        igdb_name           TEXT,
        backloggd_slug      TEXT,
        confidence          TEXT NOT NULL DEFAULT 'unmatched',
        match_method        TEXT,
        matched_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        FOREIGN KEY (steam_app_id) REFERENCES games(app_id)
      );
      CREATE TABLE IF NOT EXISTS import_sessions (
        id                  TEXT PRIMARY KEY,
        started_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        completed_at        TEXT,
        status              TEXT NOT NULL DEFAULT 'in-progress',
        total_games         INTEGER NOT NULL DEFAULT 0,
        matched_games       INTEGER NOT NULL DEFAULT 0,
        proposed_changes    INTEGER NOT NULL DEFAULT 0,
        approved_changes    INTEGER NOT NULL DEFAULT 0,
        applied_changes     INTEGER NOT NULL DEFAULT 0,
        skipped_games       INTEGER NOT NULL DEFAULT 0,
        failed_games        INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS proposals (
        id                  TEXT    PRIMARY KEY,
        import_session_id   TEXT    NOT NULL,
        steam_app_id        INTEGER NOT NULL,
        igdb_id             INTEGER NOT NULL,
        backloggd_slug      TEXT    NOT NULL,
        action              TEXT    NOT NULL,
        status              TEXT    NOT NULL DEFAULT 'pending',
        match_confidence    TEXT    NOT NULL,
        notes               TEXT,
        created_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        FOREIGN KEY (steam_app_id) REFERENCES games(app_id),
        FOREIGN KEY (import_session_id) REFERENCES import_sessions(id)
      );
    `);

    db.prepare('INSERT INTO games (app_id, title, playtime_minutes) VALUES (?, ?, ?)').run(
      730,
      'CS2',
      500,
    );

    db.prepare(
      'INSERT INTO matches (steam_app_id, igdb_id, igdb_name, backloggd_slug, confidence) VALUES (?, ?, ?, ?, ?)',
    ).run(730, 12345, 'Counter-Strike 2', 'counter-strike-2', 'exact');

    db.prepare('INSERT INTO import_sessions (id, status, started_at) VALUES (?, ?, ?)').run(
      's1',
      'in-progress',
      new Date().toISOString(),
    );

    db.prepare(
      `INSERT INTO proposals (id, import_session_id, steam_app_id, igdb_id, backloggd_slug, action, status, match_confidence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('p1', 's1', 730, 12345, 'counter-strike-2', 'mark-played', 'approved', 'exact');

    // Run full migration
    db.exec(getCreateTableSQL());
    runMigrations(db);

    // Verify canonical playlog payload
    const row = db.prepare('SELECT suggested_payload FROM proposals WHERE id = ?').get('p1') as {
      suggested_payload: string;
    };
    const canonical = playlogPayload(500);
    expect(row.suggested_payload).toBe(canonical);

    // Regeneration must NOT demote unchanged approved proposal
    generateProposals(db);

    const after = db.prepare('SELECT status FROM proposals WHERE id = ?').get('p1') as {
      status: string;
    };
    expect(after.status).toBe('approved');

    db.close();
  });

  it('repairs partially migrated NULL snapshot columns and survives regeneration', () => {
    // Simulate a DB that already has steam_title/igdb_name/suggested_payload
    // columns but left them NULL — e.g. opened by an earlier migration version.
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    // Create new-style tables but with NULL snapshot values
    db.exec(getCreateTableSQL());

    db.prepare('INSERT INTO games (app_id, title, playtime_minutes) VALUES (?, ?, ?)').run(
      730,
      'CS2',
      500,
    );
    db.prepare(
      'INSERT INTO matches (steam_app_id, igdb_id, igdb_name, backloggd_slug, confidence) VALUES (?, ?, ?, ?, ?)',
    ).run(730, 12345, 'Counter-Strike 2', 'counter-strike-2', 'exact');

    // Create a session and an approved ownership proposal with NULL snapshots
    db.prepare(
      `INSERT INTO import_sessions (id, status, started_at)
       VALUES (?, ?, ?)`,
    ).run('s1', 'in-progress', new Date().toISOString());

    db.prepare(
      `INSERT INTO proposals
         (id, import_session_id, steam_app_id, steam_title, igdb_id, igdb_name, backloggd_slug, proposal_kind, status, match_confidence, suggested_payload)
       VALUES
         (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'p1',
      's1',
      730,
      null,
      12345,
      null,
      'counter-strike-2',
      'ownership',
      'approved',
      'exact',
      null,
    );

    // Run migrations — repair steps should fix the NULLs
    runMigrations(db);

    const repaired = db
      .prepare('SELECT steam_title, igdb_name, suggested_payload FROM proposals WHERE id = ?')
      .get('p1') as {
      steam_title: string | null;
      igdb_name: string | null;
      suggested_payload: string | null;
    };

    expect(repaired.steam_title).toBe('CS2');
    expect(repaired.igdb_name).toBe('Counter-Strike 2');
    expect(repaired.suggested_payload).toBe('{"platform":"steam","ownershipType":"digital"}');

    // Regeneration must not demote
    generateProposals(db);

    const status = db.prepare('SELECT status FROM proposals WHERE id = ?').get('p1') as {
      status: string;
    };
    expect(status.status).toBe('approved');

    db.close();
  });
});
