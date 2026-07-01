import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { getCreateTableSQL } from '../../src/storage/schema.js';
import {
  fetchOwnedGames,
  clearSteamCache,
  steamCacheKey,
  getSteamCacheExpiry,
  validateSteamResponse,
} from '../../src/steam/client.js';

describe('Steam client', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(getCreateTableSQL());
  });

  afterEach(() => {
    db.close();
  });

  describe('steamCacheKey', () => {
    it('generates a deterministic key for a user ID', () => {
      const key = steamCacheKey('76561197960287930');
      expect(key).toBe('steam:GetOwnedGames:76561197960287930');
    });
  });

  describe('validateSteamResponse', () => {
    it('passes through a valid response unchanged', () => {
      const input = {
        response: {
          game_count: 2,
          games: [
            {
              appid: 730,
              name: 'CS2',
              playtime_forever: 100,
              playtime_windows_forever: 0,
              playtime_mac_forever: 0,
              playtime_linux_forever: 0,
              playtime_2weeks: 0,
              rtime_last_played: 0,
              has_community_visible_stats: false,
              img_icon_url: null,
            },
            {
              appid: 440,
              name: 'TF2',
              playtime_forever: 50,
              playtime_windows_forever: 0,
              playtime_mac_forever: 0,
              playtime_linux_forever: 0,
              playtime_2weeks: 0,
              rtime_last_played: 0,
              has_community_visible_stats: false,
              img_icon_url: null,
            },
          ],
        },
      };
      const result = validateSteamResponse(input);
      expect(result.response.game_count).toBe(2);
      expect(result.response.games).toHaveLength(2);
    });

    it('throws for a missing response object', () => {
      expect(() => validateSteamResponse({} as never)).toThrow('library may be private');
    });

    it('throws for a null response', () => {
      expect(() => validateSteamResponse({ response: null } as never)).toThrow(
        'library may be private',
      );
    });

    it('throws when game_count is missing', () => {
      expect(() => validateSteamResponse({ response: { games: [] } } as never)).toThrow(
        'library may be private',
      );
    });

    it('normalises a missing games array when game_count is 0', () => {
      const result = validateSteamResponse({ response: { game_count: 0 } } as never);
      expect(result.response.games).toEqual([]);
      expect(result.response.game_count).toBe(0);
    });

    it('normalises a null games field when game_count is 0', () => {
      const result = validateSteamResponse({
        response: { game_count: 0, games: null },
      } as never);
      expect(result.response.games).toEqual([]);
      expect(result.response.game_count).toBe(0);
    });

    it('throws when game_count > 0 but games array is missing', () => {
      expect(() => validateSteamResponse({ response: { game_count: 5 } } as never)).toThrow(
        'malformed',
      );
    });

    it('throws when game_count > 0 but games array is null', () => {
      expect(() =>
        validateSteamResponse({ response: { game_count: 5, games: null } } as never),
      ).toThrow('malformed');
    });

    it('throws when game_count does not match games array length', () => {
      expect(() =>
        validateSteamResponse({
          response: {
            game_count: 3,
            games: [
              {
                appid: 1,
                name: 'A',
                playtime_forever: 0,
                playtime_windows_forever: 0,
                playtime_mac_forever: 0,
                playtime_linux_forever: 0,
                playtime_2weeks: 0,
                rtime_last_played: 0,
                has_community_visible_stats: false,
                img_icon_url: null,
              },
            ],
          },
        } as never),
      ).toThrow('inconsistent');
    });
  });

  describe('fetchOwnedGames', () => {
    it('loads fixture data when no credentials are provided', async () => {
      const data = await fetchOwnedGames(null, db);
      expect(data.response).toBeDefined();
      expect(data.response.game_count).toBeGreaterThan(0);
      expect(data.response.games.length).toBeGreaterThan(0);
    });

    it('loads fixture data when useFixture is true', async () => {
      const data = await fetchOwnedGames(
        { STEAM_API_KEY: 'test-key', STEAM_USER_ID: 'test-id' },
        db,
        true,
      );
      expect(data.response.game_count).toBeGreaterThan(0);
    });

    it('caches and returns the same fixture data on second call', async () => {
      const data1 = await fetchOwnedGames(null, db);
      const data2 = await fetchOwnedGames(null, db);
      expect(data1.response.games).toEqual(data2.response.games);
    });

    it('rejects a live response with out-of-range rtime_last_played and does not cache it', async () => {
      const originalFetch = globalThis.fetch;

      const badResponse = {
        response: {
          game_count: 1,
          games: [
            {
              appid: 730,
              name: 'CS2',
              playtime_forever: 100,
              playtime_windows_forever: 0,
              playtime_mac_forever: 0,
              playtime_linux_forever: 0,
              playtime_2weeks: 0,
              rtime_last_played: 8640000000001,
              has_community_visible_stats: false,
              img_icon_url: null,
            },
          ],
        },
      };

      globalThis.fetch = async () => new Response(JSON.stringify(badResponse), { status: 200 });

      await expect(
        fetchOwnedGames({ STEAM_API_KEY: 'test-key', STEAM_USER_ID: 'test-id' }, db),
      ).rejects.toThrow();

      // Assert the malformed response was not cached
      const cacheCount = db.prepare('SELECT COUNT(*) as count FROM api_cache').get() as {
        count: number;
      };
      expect(cacheCount.count).toBe(0);

      // Assert no games were inserted as a result of the failed response
      const gameCount = db.prepare('SELECT COUNT(*) as count FROM games').get() as {
        count: number;
      };
      expect(gameCount.count).toBe(0);

      globalThis.fetch = originalFetch;
    });
  });

  describe('getSteamCacheExpiry', () => {
    it('returns null when no cache entry exists', () => {
      const expiry = getSteamCacheExpiry('nonexistent-user', db);
      expect(expiry).toBeNull();
    });

    it('returns the expiry timestamp from a cached entry', () => {
      const future = new Date(Date.now() + 86_400_000).toISOString();
      db.prepare(
        'INSERT INTO api_cache (cache_key, response_body, expires_at) VALUES (?, ?, ?)',
      ).run('steam:GetOwnedGames:test-user', '{}', future);

      const expiry = getSteamCacheExpiry('test-user', db);
      expect(expiry).toBe(future);
    });
  });

  describe('clearSteamCache', () => {
    it('removes the cached entry', () => {
      // Seed a cache entry directly (fixture fetches don't cache)
      db.prepare('INSERT INTO api_cache (cache_key, response_body) VALUES (?, ?)').run(
        'steam:GetOwnedGames:test-user',
        '{"response":{"game_count":0,"games":[]}}',
      );

      const before = db.prepare('SELECT COUNT(*) as count FROM api_cache').get() as {
        count: number;
      };
      expect(before.count).toBe(1);

      clearSteamCache('test-user', db);

      const after = db.prepare('SELECT COUNT(*) as count FROM api_cache').get() as {
        count: number;
      };
      expect(after.count).toBe(0);
    });
  });
});
