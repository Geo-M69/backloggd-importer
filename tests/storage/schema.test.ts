import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { getCreateTableSQL } from '../../src/storage/schema.js';

describe('schema', () => {
  it('produces valid SQL that creates all five tables', () => {
    const db = new Database(':memory:');
    expect(() => db.exec(getCreateTableSQL())).not.toThrow();

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];

    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain('games');
    expect(tableNames).toContain('matches');
    expect(tableNames).toContain('proposals');
    expect(tableNames).toContain('import_sessions');
    expect(tableNames).toContain('api_cache');

    db.close();
  });

  it('is idempotent (can be run twice)', () => {
    const db = new Database(':memory:');
    db.exec(getCreateTableSQL());
    expect(() => db.exec(getCreateTableSQL())).not.toThrow();
    db.close();
  });

  describe('CHECK constraints', () => {
    it('rejects negative playtime_minutes', () => {
      const db = new Database(':memory:');
      db.exec(getCreateTableSQL());
      expect(() =>
        db
          .prepare('INSERT INTO games (app_id, title, playtime_minutes) VALUES (?, ?, ?)')
          .run(1, 'Test', -1),
      ).toThrow();
      db.close();
    });

    it('rejects invalid is_free value', () => {
      const db = new Database(':memory:');
      db.exec(getCreateTableSQL());
      expect(() =>
        db.prepare('INSERT INTO games (app_id, title, is_free) VALUES (?, ?, ?)').run(2, 'Test', 2),
      ).toThrow();
      db.close();
    });

    it('rejects invalid has_details value', () => {
      const db = new Database(':memory:');
      db.exec(getCreateTableSQL());
      expect(() =>
        db
          .prepare('INSERT INTO games (app_id, title, has_details) VALUES (?, ?, ?)')
          .run(3, 'Test', -1),
      ).toThrow();
      db.close();
    });

    it('rejects invalid match confidence', () => {
      const db = new Database(':memory:');
      db.exec(getCreateTableSQL());
      expect(() =>
        db.prepare('INSERT INTO matches (steam_app_id, confidence) VALUES (?, ?)').run(1, 'bogus'),
      ).toThrow();
      db.close();
    });

    it('rejects invalid proposal action', () => {
      const db = new Database(':memory:');
      db.exec(getCreateTableSQL());
      expect(() =>
        db
          .prepare(
            'INSERT INTO proposals (id, import_session_id, steam_app_id, igdb_id, backloggd_slug, action, match_confidence) VALUES (?, ?, ?, ?, ?, ?, ?)',
          )
          .run('p1', 's1', 1, 99, 'some-game', 'delete-ownership', 'exact'),
      ).toThrow();
      db.close();
    });

    it('rejects invalid proposal status', () => {
      const db = new Database(':memory:');
      db.exec(getCreateTableSQL());
      expect(() =>
        db
          .prepare(
            'INSERT INTO proposals (id, import_session_id, steam_app_id, igdb_id, backloggd_slug, action, status, match_confidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .run('p2', 's1', 1, 99, 'some-game', 'add-ownership', 'unknown-status', 'exact'),
      ).toThrow();
      db.close();
    });

    it('rejects invalid session status', () => {
      const db = new Database(':memory:');
      db.exec(getCreateTableSQL());
      expect(() =>
        db.prepare('INSERT INTO import_sessions (id, status) VALUES (?, ?)').run('s1', 'crashed'),
      ).toThrow();
      db.close();
    });

    it('rejects negative counters in import_sessions', () => {
      const db = new Database(':memory:');
      db.exec(getCreateTableSQL());
      expect(() =>
        db.prepare('INSERT INTO import_sessions (id, total_games) VALUES (?, ?)').run('s1', -5),
      ).toThrow();
      db.close();
    });

    it('rejects fractional playtime_minutes', () => {
      const db = new Database(':memory:');
      db.exec(getCreateTableSQL());
      expect(() =>
        db
          .prepare('INSERT INTO games (app_id, title, playtime_minutes) VALUES (?, ?, ?)')
          .run(10, 'Test', 1.5),
      ).toThrow();
      db.close();
    });

    it('rejects text value for playtime_minutes', () => {
      const db = new Database(':memory:');
      db.exec(getCreateTableSQL());
      expect(() =>
        db
          .prepare('INSERT INTO games (app_id, title, playtime_minutes) VALUES (?, ?, ?)')
          .run(11, 'Test', 'not-a-number'),
      ).toThrow();
      db.close();
    });

    it('rejects fractional total_games', () => {
      const db = new Database(':memory:');
      db.exec(getCreateTableSQL());
      expect(() =>
        db.prepare('INSERT INTO import_sessions (id, total_games) VALUES (?, ?)').run('s2', 99.9),
      ).toThrow();
      db.close();
    });

    it('rejects text value for is_free', () => {
      const db = new Database(':memory:');
      db.exec(getCreateTableSQL());
      expect(() =>
        db
          .prepare('INSERT INTO games (app_id, title, is_free) VALUES (?, ?, ?)')
          .run(12, 'Test', 'yes'),
      ).toThrow();
      db.close();
    });
  });

  describe('api_cache table', () => {
    it('stores and retrieves a cached response', () => {
      const db = new Database(':memory:');
      db.exec(getCreateTableSQL());

      db.prepare('INSERT INTO api_cache (cache_key, response_body) VALUES (?, ?)').run(
        'test:cache:key',
        '{"hello":"world"}',
      );

      const row = db
        .prepare('SELECT response_body FROM api_cache WHERE cache_key = ?')
        .get('test:cache:key') as { response_body: string };

      expect(row.response_body).toBe('{"hello":"world"}');
      db.close();
    });

    it('upserts on conflict', () => {
      const db = new Database(':memory:');
      db.exec(getCreateTableSQL());

      db.prepare('INSERT INTO api_cache (cache_key, response_body) VALUES (?, ?)').run(
        'k1',
        'first',
      );

      db.prepare('INSERT OR REPLACE INTO api_cache (cache_key, response_body) VALUES (?, ?)').run(
        'k1',
        'second',
      );

      const row = db
        .prepare('SELECT response_body FROM api_cache WHERE cache_key = ?')
        .get('k1') as { response_body: string };
      expect(row.response_body).toBe('second');
      db.close();
    });

    it('records fetched_at automatically', () => {
      const db = new Database(':memory:');
      db.exec(getCreateTableSQL());

      db.prepare('INSERT INTO api_cache (cache_key, response_body) VALUES (?, ?)').run(
        'k-timestamp',
        '{}',
      );

      const row = db
        .prepare('SELECT fetched_at FROM api_cache WHERE cache_key = ?')
        .get('k-timestamp') as { fetched_at: string };
      expect(row.fetched_at).toBeTruthy();
      expect(() => new Date(row.fetched_at)).not.toThrow();
      db.close();
    });
  });
});
