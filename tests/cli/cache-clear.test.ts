import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { clearTokenCache } from '../../src/igdb/auth.js';
import { clearSteamCache } from '../../src/steam/client.js';
import { getCreateTableSQL } from '../../src/storage/schema.js';
import type { CacheClearCliDeps } from '../../src/cli/cache-clear.js';
import { runCacheClearCli } from '../../src/cli/cache-clear.js';

const source = readFileSync(resolve('src/cli/cache-clear.ts'), 'utf-8');
const scripts = JSON.parse(readFileSync(resolve('package.json'), 'utf-8')).scripts as Record<
  string,
  string
>;

function createDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(getCreateTableSQL());
  db.prepare('INSERT INTO games (app_id, title, playtime_minutes) VALUES (?, ?, ?)').run(
    1,
    'Preserved game',
    0,
  );
  db.prepare('INSERT INTO api_cache (cache_key, response_body) VALUES (?, ?)').run(
    'steam:GetOwnedGames:steam-user',
    'steam-cache',
  );
  db.prepare('INSERT INTO api_cache (cache_key, response_body) VALUES (?, ?)').run(
    'igdb:oauth:access_token:igdb-client',
    'igdb-token',
  );
  db.prepare('INSERT INTO api_cache (cache_key, response_body) VALUES (?, ?)').run(
    'steam:GetOwnedGames:other-user',
    'other-steam-cache',
  );
  db.prepare('INSERT INTO api_cache (cache_key, response_body) VALUES (?, ?)').run(
    'unrelated:cache',
    'preserved-cache',
  );
  return db;
}

function getCacheKeys(db: Database.Database): string[] {
  return (
    db.prepare('SELECT cache_key FROM api_cache ORDER BY cache_key').all() as {
      cache_key: string;
    }[]
  ).map((row) => row.cache_key);
}

function createDeps(db: Database.Database): {
  deps: CacheClearCliDeps;
  calls: {
    openCacheDatabase: ReturnType<typeof vi.fn>;
    closeCacheDatabase: ReturnType<typeof vi.fn>;
    resolveImportDbPath: ReturnType<typeof vi.fn>;
    clearSteamCache: ReturnType<typeof vi.fn>;
    clearTokenCache: ReturnType<typeof vi.fn>;
    consoleLog: ReturnType<typeof vi.fn>;
    consoleError: ReturnType<typeof vi.fn>;
  };
} {
  const openCacheDatabase = vi.fn<() => Database.Database>().mockReturnValue(db);
  const closeCacheDatabase = vi.fn<(database: Database.Database) => void>();
  const resolveImportDbPath = vi.fn().mockReturnValue({ mode: 'live', dbPath: ':memory:' });
  const clearSteamCacheDependency = vi.fn(clearSteamCache);
  const clearTokenCacheDependency = vi.fn(clearTokenCache);
  const consoleLog = vi.fn<(message: string) => void>();
  const consoleError = vi.fn<(message: string) => void>();

  return {
    deps: {
      openCacheDatabase,
      closeCacheDatabase,
      resolveImportDbPath,
      clearSteamCache: clearSteamCacheDependency,
      clearTokenCache: clearTokenCacheDependency,
      consoleLog,
      consoleError,
    },
    calls: {
      openCacheDatabase,
      closeCacheDatabase,
      resolveImportDbPath,
      clearSteamCache: clearSteamCacheDependency,
      clearTokenCache: clearTokenCacheDependency,
      consoleLog,
      consoleError,
    },
  };
}

const liveEnv: NodeJS.ProcessEnv = {
  STEAM_API_KEY: 'steam-key',
  STEAM_USER_ID: 'steam-user',
  IGDB_CLIENT_ID: 'igdb-client',
  IGDB_CLIENT_SECRET: 'igdb-secret',
  DB_PATH: ':memory:',
};

const protectedTables = [
  'games',
  'matches',
  'proposals',
  'import_sessions',
  'import_items',
  'import_item_confirmations',
] as const;

function protectedState(db: Database.Database): Record<string, unknown> {
  return Object.fromEntries(
    protectedTables.map((table) => [
      table,
      {
        schema:
          (
            db
              .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
              .get(table) as { sql: string } | undefined
          )?.sql ?? null,
        rows: db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      },
    ]),
  );
}

function createTemporaryDatabase(seed: (db: Database.Database) => void): {
  dbPath: string;
  remove: () => void;
} {
  const directory = mkdtempSync(join(tmpdir(), 'backloggd-cache-clear-'));
  const dbPath = join(directory, 'import.db');
  const db = new Database(dbPath);
  try {
    seed(db);
  } finally {
    db.close();
  }
  return { dbPath, remove: () => rmSync(directory, { recursive: true, force: true }) };
}

function seedProtectedImporterState(db: Database.Database): void {
  db.exec(getCreateTableSQL());
  db.prepare('INSERT INTO games (app_id, title) VALUES (?, ?)').run(1, 'Preserved game');
  db.prepare('INSERT INTO import_sessions (id, status, policy_json) VALUES (?, ?, ?)').run(
    'session-1',
    'paused',
    '{"source":"test"}',
  );
  db.prepare(
    `INSERT INTO matches (steam_app_id, igdb_id, igdb_name, backloggd_slug, confidence)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(1, 101, 'Preserved match', 'preserved-match', 'exact');
  db.prepare(
    `INSERT INTO proposals (
       id, import_session_id, steam_app_id, steam_title, igdb_id, igdb_name,
       backloggd_slug, proposal_kind, status, match_confidence, suggested_payload
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'proposal-1',
    'session-1',
    1,
    'Preserved game',
    101,
    'Preserved match',
    'preserved-match',
    'ownership',
    'approved',
    'exact',
    '{"platform":"steam","ownershipType":"digital"}',
  );
  db.prepare(
    `INSERT INTO import_items (
       proposal_id, import_session_id, steam_app_id, proposal_kind, frozen_payload, status
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    'proposal-1',
    'session-1',
    1,
    'ownership',
    '{"platform":"steam","ownershipType":"digital"}',
    'approved',
  );
  db.prepare(
    `INSERT INTO import_item_confirmations (
       proposal_id, import_session_id, confirmation_batch_id, planned_payload
     ) VALUES (?, ?, ?, ?)`,
  ).run('proposal-1', 'session-1', 'batch-1', '{"platform":"steam"}');
}

describe('cache:clear CLI', () => {
  it('prints help before configuration, database, or cache side effects', async () => {
    const db = createDb();
    const { deps, calls } = createDeps(db);

    const exitCode = await runCacheClearCli(['--help'], deps, liveEnv);

    expect(exitCode).toBe(0);
    expect(calls.consoleLog).toHaveBeenCalledWith(
      expect.stringContaining('Usage: npm run cache:clear'),
    );
    expect(calls.resolveImportDbPath).not.toHaveBeenCalled();
    expect(calls.openCacheDatabase).not.toHaveBeenCalled();
    expect(calls.clearSteamCache).not.toHaveBeenCalled();
    expect(calls.clearTokenCache).not.toHaveBeenCalled();
    expect(getCacheKeys(db)).toHaveLength(4);
    db.close();
  });

  it('clears only the selected Steam cache entry', async () => {
    const db = createDb();
    const { deps, calls } = createDeps(db);

    const exitCode = await runCacheClearCli(['--steam'], deps, liveEnv);

    expect(exitCode).toBe(0);
    expect(calls.clearSteamCache).toHaveBeenCalledWith('steam-user', db);
    expect(calls.clearTokenCache).not.toHaveBeenCalled();
    expect(getCacheKeys(db)).toEqual([
      'igdb:oauth:access_token:igdb-client',
      'steam:GetOwnedGames:other-user',
      'unrelated:cache',
    ]);
    expect(db.prepare('SELECT COUNT(*) AS count FROM games').get()).toEqual({ count: 1 });
    db.close();
  });

  it('clears only the selected IGDB token cache entry', async () => {
    const db = createDb();
    const { deps, calls } = createDeps(db);

    const exitCode = await runCacheClearCli(['--igdb'], deps, liveEnv);

    expect(exitCode).toBe(0);
    expect(calls.clearSteamCache).not.toHaveBeenCalled();
    expect(calls.clearTokenCache).toHaveBeenCalledWith('igdb-client', db);
    expect(getCacheKeys(db)).toEqual([
      'steam:GetOwnedGames:other-user',
      'steam:GetOwnedGames:steam-user',
      'unrelated:cache',
    ]);
    db.close();
  });

  it('clears both explicitly selected cache entries with --all', async () => {
    const db = createDb();
    const { deps, calls } = createDeps(db);

    const exitCode = await runCacheClearCli(['--all'], deps, liveEnv);

    expect(exitCode).toBe(0);
    expect(calls.clearSteamCache).toHaveBeenCalledWith('steam-user', db);
    expect(calls.clearTokenCache).toHaveBeenCalledWith('igdb-client', db);
    expect(getCacheKeys(db)).toEqual(['steam:GetOwnedGames:other-user', 'unrelated:cache']);
    db.close();
  });

  it.each([
    { argv: [] },
    { argv: ['--unknown'] },
    { argv: ['--steam', '--igdb'] },
    { argv: ['--all', '--steam'] },
    { argv: ['--steam', '--steam'] },
  ])(
    'rejects invalid or ambiguous input without database side effects: $argv',
    async ({ argv }) => {
      const db = createDb();
      const { deps, calls } = createDeps(db);

      const exitCode = await runCacheClearCli(argv, deps, liveEnv);

      expect(exitCode).toBe(1);
      expect(calls.resolveImportDbPath).not.toHaveBeenCalled();
      expect(calls.openCacheDatabase).not.toHaveBeenCalled();
      expect(calls.clearSteamCache).not.toHaveBeenCalled();
      expect(calls.clearTokenCache).not.toHaveBeenCalled();
      expect(getCacheKeys(db)).toHaveLength(4);
      db.close();
    },
  );

  it.each(['', ' '])(
    'rejects an empty or whitespace-only cache-key credential before database access: %j',
    async (steamUserId) => {
      const db = createDb();
      const { deps, calls } = createDeps(db);

      const exitCode = await runCacheClearCli(['--steam'], deps, {
        ...liveEnv,
        STEAM_USER_ID: steamUserId,
      });

      expect(exitCode).toBe(1);
      expect(calls.resolveImportDbPath).not.toHaveBeenCalled();
      expect(calls.openCacheDatabase).not.toHaveBeenCalled();
      expect(calls.clearSteamCache).not.toHaveBeenCalled();
      expect(getCacheKeys(db)).toHaveLength(4);
      db.close();
    },
  );

  it('uses the production cache-only path without changing protected importer state', async () => {
    const temporary = createTemporaryDatabase((db) => {
      seedProtectedImporterState(db);
      db.prepare('INSERT INTO api_cache (cache_key, response_body) VALUES (?, ?)').run(
        'steam:GetOwnedGames:steam-user',
        'steam-cache',
      );
      db.prepare('INSERT INTO api_cache (cache_key, response_body) VALUES (?, ?)').run(
        'igdb:oauth:access_token:igdb-client',
        'igdb-cache',
      );
      db.prepare('INSERT INTO api_cache (cache_key, response_body) VALUES (?, ?)').run(
        'steam:GetOwnedGames:STEAM-USER',
        'differently-cased-cache',
      );
      db.prepare('INSERT INTO api_cache (cache_key, response_body) VALUES (?, ?)').run(
        'unrelated:cache',
        'preserved-cache',
      );
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      const before = new Database(temporary.dbPath);
      const stateBefore = protectedState(before);
      before.close();

      await expect(
        runCacheClearCli(['--steam'], undefined, { ...liveEnv, DB_PATH: temporary.dbPath }),
      ).resolves.toBe(0);

      const after = new Database(temporary.dbPath);
      expect(getCacheKeys(after)).toEqual([
        'igdb:oauth:access_token:igdb-client',
        'steam:GetOwnedGames:STEAM-USER',
        'unrelated:cache',
      ]);
      expect(protectedState(after)).toEqual(stateBefore);
      after.close();
      expect(log).toHaveBeenCalledWith('Cleared Steam GetOwnedGames cache entry.');
    } finally {
      log.mockRestore();
      temporary.remove();
    }
  });

  it('preserves whitespace in STEAM_USER_ID when clearing the production cache entry', async () => {
    const steamUserId = ' steam-user ';
    const targetCacheKey = `steam:GetOwnedGames:${steamUserId}`;
    const trimmedCacheKey = 'steam:GetOwnedGames:steam-user';
    const temporary = createTemporaryDatabase((db) => {
      seedProtectedImporterState(db);
      db.prepare('INSERT INTO api_cache (cache_key, response_body) VALUES (?, ?)').run(
        targetCacheKey,
        'target-cache',
      );
      db.prepare('INSERT INTO api_cache (cache_key, response_body) VALUES (?, ?)').run(
        trimmedCacheKey,
        'trimmed-cache',
      );
      db.prepare('INSERT INTO api_cache (cache_key, response_body) VALUES (?, ?)').run(
        'unrelated:cache',
        'preserved-cache',
      );
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      const before = new Database(temporary.dbPath);
      const stateBefore = protectedState(before);
      before.close();

      await expect(
        runCacheClearCli(['--steam'], undefined, {
          ...liveEnv,
          STEAM_USER_ID: steamUserId,
          DB_PATH: temporary.dbPath,
        }),
      ).resolves.toBe(0);

      const after = new Database(temporary.dbPath);
      expect(getCacheKeys(after)).toEqual([trimmedCacheKey, 'unrelated:cache']);
      expect(protectedState(after)).toEqual(stateBefore);
      after.close();
      expect(log).toHaveBeenCalledWith('Cleared Steam GetOwnedGames cache entry.');
    } finally {
      log.mockRestore();
      temporary.remove();
    }
  });

  it('preserves whitespace in IGDB_CLIENT_ID when clearing the production cache entry', async () => {
    const igdbClientId = ' igdb-client ';
    const targetCacheKey = `igdb:oauth:access_token:${igdbClientId}`;
    const trimmedCacheKey = 'igdb:oauth:access_token:igdb-client';
    const temporary = createTemporaryDatabase((db) => {
      seedProtectedImporterState(db);
      db.prepare('INSERT INTO api_cache (cache_key, response_body) VALUES (?, ?)').run(
        targetCacheKey,
        'target-cache',
      );
      db.prepare('INSERT INTO api_cache (cache_key, response_body) VALUES (?, ?)').run(
        trimmedCacheKey,
        'trimmed-cache',
      );
      db.prepare('INSERT INTO api_cache (cache_key, response_body) VALUES (?, ?)').run(
        'unrelated:cache',
        'preserved-cache',
      );
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      const before = new Database(temporary.dbPath);
      const stateBefore = protectedState(before);
      before.close();

      await expect(
        runCacheClearCli(['--igdb'], undefined, {
          ...liveEnv,
          IGDB_CLIENT_ID: igdbClientId,
          DB_PATH: temporary.dbPath,
        }),
      ).resolves.toBe(0);

      const after = new Database(temporary.dbPath);
      expect(getCacheKeys(after)).toEqual([trimmedCacheKey, 'unrelated:cache']);
      expect(protectedState(after)).toEqual(stateBefore);
      after.close();
      expect(log).toHaveBeenCalledWith('Cleared IGDB OAuth token cache entry.');
    } finally {
      log.mockRestore();
      temporary.remove();
    }
  });

  it('rejects api_cache triggers before they can mutate protected or unrelated rows', async () => {
    const steamUserId = 'steam-user-secret';
    const targetCacheKey = `steam:GetOwnedGames:${steamUserId}`;
    const temporary = createTemporaryDatabase((db) => {
      seedProtectedImporterState(db);
      db.prepare('INSERT INTO api_cache (cache_key, response_body) VALUES (?, ?)').run(
        targetCacheKey,
        'steam-cache',
      );
      db.prepare('INSERT INTO api_cache (cache_key, response_body) VALUES (?, ?)').run(
        'unrelated:cache',
        'preserved-cache',
      );
      db.exec(`
        CREATE TRIGGER api_cache_delete_trigger
        AFTER DELETE ON "API_CACHE"
        BEGIN
          UPDATE games SET title = 'triggered' WHERE app_id = 1;
          DELETE FROM api_cache WHERE cache_key = 'unrelated:cache';
        END;
      `);
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      const before = new Database(temporary.dbPath);
      const stateBefore = protectedState(before);
      before.close();

      const error = await runCacheClearCli(['--steam'], undefined, {
        ...liveEnv,
        STEAM_USER_ID: steamUserId,
        IGDB_CLIENT_ID: 'igdb-client-secret',
        DB_PATH: temporary.dbPath,
      }).catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(Error);
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain('api_cache triggers are unsupported');
      expect(message).not.toContain(steamUserId);
      expect(message).not.toContain(targetCacheKey);
      expect(message).not.toContain('igdb-client-secret');
      expect(log).not.toHaveBeenCalled();

      const after = new Database(temporary.dbPath);
      expect(getCacheKeys(after)).toEqual([targetCacheKey, 'unrelated:cache']);
      expect(protectedState(after)).toEqual(stateBefore);
      after.close();
    } finally {
      log.mockRestore();
      temporary.remove();
    }
  });

  it.each([
    { collation: 'NOCASE', preservedKey: 'steam:GetOwnedGames:STEAM-USER' },
    { collation: 'RTRIM', preservedKey: 'steam:GetOwnedGames:steam-user ' },
  ])(
    'uses BINARY equality when cache_key has $collation column collation',
    async ({ collation, preservedKey }) => {
      const targetCacheKey = 'steam:GetOwnedGames:steam-user';
      const temporary = createTemporaryDatabase((db) => {
        db.exec(`
          CREATE TABLE api_cache (
            cache_key TEXT COLLATE ${collation},
            response_body TEXT NOT NULL,
            fetched_at TEXT NOT NULL DEFAULT 'test',
            expires_at TEXT,
            PRIMARY KEY (cache_key COLLATE BINARY)
          );
        `);
        db.prepare('INSERT INTO api_cache (cache_key, response_body) VALUES (?, ?)').run(
          targetCacheKey,
          'target-cache',
        );
        db.prepare('INSERT INTO api_cache (cache_key, response_body) VALUES (?, ?)').run(
          preservedKey,
          'preserved-cache',
        );
      });

      try {
        await expect(
          runCacheClearCli(['--steam'], undefined, { ...liveEnv, DB_PATH: temporary.dbPath }),
        ).resolves.toBe(0);

        const after = new Database(temporary.dbPath);
        expect(getCacheKeys(after)).toEqual([preservedKey]);
        after.close();
      } finally {
        temporary.remove();
      }
    },
  );

  it.each(['CASCADE', 'SET NULL'])(
    'rejects inbound api_cache foreign keys with ON DELETE %s before mutation',
    async (onDelete) => {
      const steamUserId = 'steam-user-secret';
      const targetCacheKey = `steam:GetOwnedGames:${steamUserId}`;
      const temporary = createTemporaryDatabase((db) => {
        db.pragma('foreign_keys = ON');
        seedProtectedImporterState(db);
        db.prepare('INSERT INTO api_cache (cache_key, response_body) VALUES (?, ?)').run(
          targetCacheKey,
          'steam-cache',
        );
        db.exec(`
          CREATE TABLE cache_references (
            id INTEGER PRIMARY KEY,
            cache_key TEXT REFERENCES api_cache(cache_key) ON DELETE ${onDelete}
          );
        `);
        db.prepare('INSERT INTO cache_references (id, cache_key) VALUES (?, ?)').run(
          1,
          targetCacheKey,
        );
      });
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

      try {
        const before = new Database(temporary.dbPath);
        const stateBefore = protectedState(before);
        const referenceBefore = before.prepare('SELECT * FROM cache_references').all();
        before.close();

        const error = await runCacheClearCli(['--steam'], undefined, {
          ...liveEnv,
          STEAM_USER_ID: steamUserId,
          IGDB_CLIENT_ID: 'igdb-client-secret',
          DB_PATH: temporary.dbPath,
        }).catch((reason: unknown) => reason);

        expect(error).toBeInstanceOf(Error);
        const message = error instanceof Error ? error.message : String(error);
        expect(message).toContain('api_cache inbound foreign keys are unsupported');
        expect(message).not.toContain(steamUserId);
        expect(message).not.toContain(targetCacheKey);
        expect(message).not.toContain('igdb-client-secret');
        expect(log).not.toHaveBeenCalled();

        const after = new Database(temporary.dbPath);
        expect(getCacheKeys(after)).toEqual([targetCacheKey]);
        expect(after.prepare('SELECT * FROM cache_references').all()).toEqual(referenceBefore);
        expect(protectedState(after)).toEqual(stateBefore);
        after.close();
      } finally {
        log.mockRestore();
        temporary.remove();
      }
    },
  );

  it('rejects an inbound foreign key from a sqliteX user table before mutation', async () => {
    const steamUserId = 'steam-user-secret';
    const targetCacheKey = `steam:GetOwnedGames:${steamUserId}`;
    const temporary = createTemporaryDatabase((db) => {
      db.pragma('foreign_keys = ON');
      seedProtectedImporterState(db);
      db.prepare('INSERT INTO api_cache (cache_key, response_body) VALUES (?, ?)').run(
        targetCacheKey,
        'steam-cache',
      );
      db.exec(`
        CREATE TABLE sqliteX (
          id INTEGER PRIMARY KEY,
          cache_key TEXT REFERENCES api_cache(cache_key) ON DELETE CASCADE
        );
      `);
      db.prepare('INSERT INTO sqliteX (id, cache_key) VALUES (?, ?)').run(1, targetCacheKey);
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      const before = new Database(temporary.dbPath);
      const stateBefore = protectedState(before);
      const referenceBefore = before.prepare('SELECT * FROM sqliteX').all();
      before.close();

      const error = await runCacheClearCli(['--steam'], undefined, {
        ...liveEnv,
        STEAM_USER_ID: steamUserId,
        IGDB_CLIENT_ID: 'igdb-client-secret',
        DB_PATH: temporary.dbPath,
      }).catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(Error);
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain('api_cache inbound foreign keys are unsupported');
      expect(message).not.toContain(steamUserId);
      expect(message).not.toContain(targetCacheKey);
      expect(message).not.toContain('igdb-client-secret');
      expect(log).not.toHaveBeenCalled();

      const after = new Database(temporary.dbPath);
      expect(getCacheKeys(after)).toEqual([targetCacheKey]);
      expect(after.prepare('SELECT * FROM sqliteX').all()).toEqual(referenceBefore);
      expect(protectedState(after)).toEqual(stateBefore);
      after.close();
    } finally {
      log.mockRestore();
      temporary.remove();
    }
  });

  it.each(['NOCASE', 'RTRIM'])('rejects non-binary cache_key collation: %s', async (collation) => {
    const temporary = createTemporaryDatabase((db) => {
      db.exec(`
        CREATE TABLE api_cache (
          cache_key TEXT PRIMARY KEY COLLATE ${collation},
          response_body TEXT NOT NULL,
          fetched_at TEXT NOT NULL DEFAULT 'test',
          expires_at TEXT
        );
      `);
      db.prepare('INSERT INTO api_cache (cache_key, response_body) VALUES (?, ?)').run(
        'steam:GetOwnedGames:steam-user',
        'steam-cache',
      );
    });

    try {
      await expect(
        runCacheClearCli(['--steam'], undefined, { ...liveEnv, DB_PATH: temporary.dbPath }),
      ).rejects.toThrow('api_cache schema is unusable');

      const after = new Database(temporary.dbPath);
      expect(getCacheKeys(after)).toEqual(['steam:GetOwnedGames:steam-user']);
      after.close();
    } finally {
      temporary.remove();
    }
  });

  it('rejects a composite primary key involving cache_key', async () => {
    const temporary = createTemporaryDatabase((db) => {
      db.exec(`
        CREATE TABLE api_cache (
          cache_key TEXT NOT NULL,
          namespace TEXT NOT NULL,
          response_body TEXT NOT NULL,
          fetched_at TEXT NOT NULL DEFAULT 'test',
          expires_at TEXT,
          PRIMARY KEY (cache_key, namespace)
        );
      `);
      db.prepare(
        'INSERT INTO api_cache (cache_key, namespace, response_body) VALUES (?, ?, ?)',
      ).run('steam:GetOwnedGames:steam-user', 'default', 'steam-cache');
    });

    try {
      await expect(
        runCacheClearCli(['--steam'], undefined, { ...liveEnv, DB_PATH: temporary.dbPath }),
      ).rejects.toThrow('api_cache schema is unusable');

      const after = new Database(temporary.dbPath);
      expect(after.prepare('SELECT cache_key, namespace FROM api_cache').all()).toEqual([
        { cache_key: 'steam:GetOwnedGames:steam-user', namespace: 'default' },
      ]);
      after.close();
    } finally {
      temporary.remove();
    }
  });

  it('clears a usable cache in an older database without migrating importer state', async () => {
    const temporary = createTemporaryDatabase((db) => {
      db.exec(`
        CREATE TABLE games (app_id INTEGER PRIMARY KEY, title TEXT NOT NULL);
        CREATE TABLE import_sessions (id TEXT PRIMARY KEY);
        CREATE TABLE proposals (
          id TEXT PRIMARY KEY,
          import_session_id TEXT NOT NULL,
          steam_app_id INTEGER NOT NULL,
          action TEXT NOT NULL
        );
        CREATE TABLE api_cache (
          cache_key TEXT PRIMARY KEY,
          response_body TEXT NOT NULL,
          fetched_at TEXT NOT NULL DEFAULT 'old',
          expires_at TEXT
        );
      `);
      db.prepare('INSERT INTO games (app_id, title) VALUES (?, ?)').run(1, 'Old game');
      db.prepare(
        'INSERT INTO proposals (id, import_session_id, steam_app_id, action) VALUES (?, ?, ?, ?)',
      ).run('old-proposal', 'old-session', 1, 'add-ownership');
      db.prepare('INSERT INTO api_cache (cache_key, response_body) VALUES (?, ?)').run(
        'steam:GetOwnedGames:steam-user',
        'steam-cache',
      );
      db.prepare('INSERT INTO api_cache (cache_key, response_body) VALUES (?, ?)').run(
        'unrelated:cache',
        'preserved-cache',
      );
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      await expect(
        runCacheClearCli(['--steam'], undefined, { ...liveEnv, DB_PATH: temporary.dbPath }),
      ).resolves.toBe(0);

      const after = new Database(temporary.dbPath);
      expect(getCacheKeys(after)).toEqual(['unrelated:cache']);
      expect(
        (after.pragma('table_info(games)') as { name: string }[]).map((row) => row.name),
      ).not.toContain('stale');
      expect(
        (after.pragma('table_info(proposals)') as { name: string }[]).map((row) => row.name),
      ).toContain('action');
      expect(
        after
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'import_items'")
          .get(),
      ).toBeUndefined();
      expect(after.prepare('SELECT * FROM proposals').all()).toEqual([
        {
          id: 'old-proposal',
          import_session_id: 'old-session',
          steam_app_id: 1,
          action: 'add-ownership',
        },
      ]);
      after.close();
    } finally {
      log.mockRestore();
      temporary.remove();
    }
  });

  it('fails without creating or migrating an unavailable cache table', async () => {
    const temporary = createTemporaryDatabase((db) => {
      db.exec('CREATE TABLE games (app_id INTEGER PRIMARY KEY, title TEXT NOT NULL)');
      db.prepare('INSERT INTO games (app_id, title) VALUES (?, ?)').run(1, 'Old game');
    });

    try {
      await expect(
        runCacheClearCli(['--steam'], undefined, { ...liveEnv, DB_PATH: temporary.dbPath }),
      ).rejects.toThrow('api_cache table is unavailable');

      const after = new Database(temporary.dbPath);
      expect(
        after.prepare("SELECT name FROM sqlite_master WHERE name = 'api_cache'").get(),
      ).toBeUndefined();
      expect(
        (after.pragma('table_info(games)') as { name: string }[]).map((row) => row.name),
      ).toEqual(['app_id', 'title']);
      after.close();
    } finally {
      temporary.remove();
    }
  });

  it('fails safely when the cache schema is unusable', async () => {
    const temporary = createTemporaryDatabase((db) => {
      db.exec(`
        CREATE TABLE games (app_id INTEGER PRIMARY KEY, title TEXT NOT NULL);
        CREATE TABLE api_cache (cache_key TEXT PRIMARY KEY);
      `);
      db.prepare('INSERT INTO games (app_id, title) VALUES (?, ?)').run(1, 'Old game');
    });

    try {
      await expect(
        runCacheClearCli(['--steam'], undefined, { ...liveEnv, DB_PATH: temporary.dbPath }),
      ).rejects.toThrow('api_cache schema is unusable');

      const after = new Database(temporary.dbPath);
      expect(after.prepare('SELECT COUNT(*) AS count FROM games').get()).toEqual({ count: 1 });
      expect(
        (after.pragma('table_info(api_cache)') as { name: string }[]).map((row) => row.name),
      ).toEqual(['cache_key']);
      after.close();
    } finally {
      temporary.remove();
    }
  });

  it('fails without creating a database when the selected path is unavailable', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'backloggd-cache-clear-missing-'));
    const dbPath = join(directory, 'missing.db');

    try {
      await expect(
        runCacheClearCli(['--steam'], undefined, { ...liveEnv, DB_PATH: dbPath }),
      ).rejects.toThrow();
      expect(existsSync(dbPath)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('propagates a deletion failure, closes the connection, and emits no success message', async () => {
    const db = createDb();
    const { deps, calls } = createDeps(db);
    const closeCacheDatabase = vi.fn((database: Database.Database) => database.close());
    deps.closeCacheDatabase = closeCacheDatabase;
    deps.clearSteamCache = vi.fn(() => {
      throw new Error('delete failed');
    });

    await expect(runCacheClearCli(['--steam'], deps, liveEnv)).rejects.toThrow('delete failed');

    expect(closeCacheDatabase).toHaveBeenCalledWith(db);
    expect(db.open).toBe(false);
    expect(calls.consoleLog).not.toHaveBeenCalled();
  });

  it('rolls back --all when the second deletion fails and emits no partial success', async () => {
    const db = createDb();
    const { deps, calls } = createDeps(db);
    deps.clearTokenCache = vi.fn(() => {
      throw new Error('token delete failed');
    });

    await expect(runCacheClearCli(['--all'], deps, liveEnv)).rejects.toThrow('token delete failed');

    expect(getCacheKeys(db)).toEqual([
      'igdb:oauth:access_token:igdb-client',
      'steam:GetOwnedGames:other-user',
      'steam:GetOwnedGames:steam-user',
      'unrelated:cache',
    ]);
    expect(calls.closeCacheDatabase).toHaveBeenCalledWith(db);
    expect(calls.consoleLog).not.toHaveBeenCalled();
    db.close();
  });
});

describe('cache:clear CLI static safety', () => {
  const importLines = source
    .split('\n')
    .filter((line) => line.trimStart().startsWith('import'))
    .join('\n');

  it('has an unchained package script', () => {
    expect(scripts['cache:clear']).toBe('node --import dotenv/config dist/cli/cache-clear.js');
    expect(scripts['cache:clear']).not.toMatch(/&&|;|\|\||\|/);
  });

  it('does not import browser, Backloggd, ownership, or import-item modules', () => {
    expect(importLines).not.toContain('../backloggd/');
    expect(importLines).not.toContain('../importer/');
    expect(importLines).not.toContain('ownership-');
    expect(importLines).not.toContain('playwright');
  });

  it('uses only the two cache clear helpers for cache mutation', () => {
    expect(importLines).toContain('../steam/client.js');
    expect(importLines).toContain('../igdb/auth.js');
    expect(source).not.toContain('resetFailedForRetry');
  });

  it('uses the non-migrating cache-only database opener', () => {
    expect(importLines).toContain('openCacheDatabase');
    expect(importLines).not.toContain('openDatabase');
  });
});
