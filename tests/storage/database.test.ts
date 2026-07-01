import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/database.js';

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
});
