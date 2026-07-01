import { describe, expect, it } from 'vitest';
import { resolveImportDbPath } from '../../src/cli/import-db.js';

describe('resolveImportDbPath', () => {
  it('returns fixture mode when no credentials are provided', () => {
    const result = resolveImportDbPath({});
    expect(result.mode).toBe('fixture');
    expect(result.dbPath).toBe('./import.fixture.db');
  });

  it('returns live mode when full Steam + IGDB credentials are provided', () => {
    const result = resolveImportDbPath({
      STEAM_API_KEY: 'steam-key',
      STEAM_USER_ID: 'steam-user',
      IGDB_CLIENT_ID: 'igdb-id',
      IGDB_CLIENT_SECRET: 'igdb-secret',
      DB_PATH: '/tmp/live.db',
    });
    expect(result.mode).toBe('live');
    expect(result.dbPath).toBe('/tmp/live.db');
  });

  it('throws on partial Steam credentials', () => {
    expect(() => resolveImportDbPath({ STEAM_API_KEY: 'steam-key' })).toThrow(
      'Partial Steam credentials detected',
    );
  });

  it('throws on partial IGDB credentials', () => {
    expect(() => resolveImportDbPath({ IGDB_CLIENT_ID: 'igdb-id' })).toThrow(
      'Partial IGDB credentials detected',
    );
  });

  it('throws when mode is ambiguous (only one credential pair is complete)', () => {
    expect(() =>
      resolveImportDbPath({
        STEAM_API_KEY: 'steam-key',
        STEAM_USER_ID: 'steam-user',
      }),
    ).toThrow('Cannot infer import mode safely');
  });
});
