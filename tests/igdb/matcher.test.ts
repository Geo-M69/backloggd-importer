import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { getCreateTableSQL } from '../../src/storage/schema.js';
import {
  getUnmatchedAppIds,
  getUnmatchedAppIdsNoRow,
  matchGames,
  groupByAppId,
  classifyConfidence,
} from '../../src/igdb/matcher.js';
import { processAndStoreGames } from '../../src/steam/normalize.js';
import type { RawSteamResponse } from '../../src/steam/client.js';

describe('IGDB matcher', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(getCreateTableSQL());
  });

  afterEach(() => {
    db.close();
  });

  describe('groupByAppId', () => {
    it('groups external-game records by uid', () => {
      const entries = [
        { uid: '730', external_game_source: 1, game: { id: 12345, name: 'CS2', slug: 'cs2' } },
        { uid: '440', external_game_source: 1, game: { id: 12346, name: 'TF2', slug: 'tf2' } },
        {
          uid: '730',
          external_game_source: 2,
          game: { id: 99999, name: 'CS2 Other', slug: 'cs2-other' },
        },
      ];

      const map = groupByAppId(entries);
      expect(map.size).toBe(2);
      expect(map.get(730)).toHaveLength(2);
      expect(map.get(440)).toHaveLength(1);
    });

    it('skips entries with non-numeric uid', () => {
      const entries = [
        { uid: 'invalid', external_game_source: 1, game: { id: 1, name: 'Nope', slug: 'nope' } },
      ];

      const map = groupByAppId(entries);
      expect(map.size).toBe(0);
    });
  });

  describe('classifyConfidence', () => {
    it('returns exact for a single matching entry', () => {
      const entries = [
        {
          uid: '730',
          external_game_source: 1,
          game: { id: 12345, name: 'CS2', slug: 'counter-strike-2' },
        },
      ];

      const result = classifyConfidence(entries, 730);
      expect(result.confidence).toBe('exact');
      expect(result.igdbId).toBe(12345);
      expect(result.igdbName).toBe('CS2');
      expect(result.backloggdSlug).toBe('counter-strike-2');
    });

    it('returns unmatched when no entries match the AppID', () => {
      const entries = [
        { uid: '440', external_game_source: 1, game: { id: 12346, name: 'TF2', slug: 'tf2' } },
      ];

      const result = classifyConfidence(entries, 730);
      expect(result.confidence).toBe('unmatched');
      expect(result.igdbId).toBeNull();
    });

    it('returns ambiguous when multiple entries share the same AppID', () => {
      const entries = [
        {
          uid: '730',
          external_game_source: 1,
          game: { id: 100, name: 'CS2 Standard', slug: 'cs2' },
        },
        {
          uid: '730',
          external_game_source: 1,
          game: { id: 101, name: 'CS2 Deluxe', slug: 'cs2-deluxe' },
        },
      ];

      const result = classifyConfidence(entries, 730);
      expect(result.confidence).toBe('ambiguous');
      // Should pick the first entry's details
      expect(result.igdbId).toBe(100);
    });
  });

  describe('getUnmatchedAppIds', () => {
    it('returns all app IDs when no matches exist', () => {
      db.prepare('INSERT INTO games (app_id, title, playtime_minutes) VALUES (?, ?, ?)').run(
        730,
        'CS2',
        100,
      );

      const ids = getUnmatchedAppIds(db);
      expect(ids).toEqual([730]);
    });

    it('excludes app IDs with exact matches', () => {
      db.prepare('INSERT INTO games (app_id, title) VALUES (?, ?)').run(730, 'CS2');
      db.prepare(
        'INSERT INTO matches (steam_app_id, igdb_id, igdb_name, confidence, match_method) VALUES (?, ?, ?, ?, ?)',
      ).run(730, 12345, 'CS2', 'exact', 'steam-appid');

      const ids = getUnmatchedAppIds(db);
      expect(ids).toEqual([]);
    });

    it('includes app IDs with unmatched rows', () => {
      db.prepare('INSERT INTO games (app_id, title) VALUES (?, ?)').run(440, 'TF2');
      db.prepare(
        'INSERT INTO matches (steam_app_id, igdb_id, igdb_name, confidence, match_method) VALUES (?, ?, ?, ?, ?)',
      ).run(440, null, null, 'unmatched', null);

      const ids = getUnmatchedAppIds(db);
      expect(ids).toEqual([440]);
    });
  });

  describe('getUnmatchedAppIdsNoRow', () => {
    it('returns app IDs that have no match row at all', () => {
      db.prepare('INSERT INTO games (app_id, title) VALUES (?, ?)').run(730, 'CS2');
      db.prepare('INSERT INTO games (app_id, title) VALUES (?, ?)').run(440, 'TF2');
      db.prepare(
        'INSERT INTO matches (steam_app_id, igdb_id, igdb_name, confidence) VALUES (?, ?, ?, ?)',
      ).run(730, 12345, 'CS2', 'exact');

      const ids = getUnmatchedAppIdsNoRow(db);
      expect(ids).toEqual([440]);
    });
  });

  describe('matchGames', () => {
    it('returns zero stats when there are no games to match', async () => {
      const stats = await matchGames(undefined, undefined, db);
      expect(stats.totalUnmatched).toBe(0);
      expect(stats.exactMatches).toBe(0);
    });

    it('matches fixture data correctly', async () => {
      // Seed games
      const rawResponse: RawSteamResponse = {
        response: {
          game_count: 5,
          games: [
            {
              appid: 730,
              name: 'Counter-Strike 2',
              playtime_forever: 45230,
              playtime_windows_forever: 0,
              playtime_mac_forever: 0,
              playtime_linux_forever: 45230,
              playtime_2weeks: 0,
              rtime_last_played: 1700000000,
              has_community_visible_stats: true,
              img_icon_url: 'hash',
            },
            {
              appid: 440,
              name: 'Team Fortress 2',
              playtime_forever: 21150,
              playtime_windows_forever: 21150,
              playtime_mac_forever: 0,
              playtime_linux_forever: 0,
              playtime_2weeks: 0,
              rtime_last_played: 1695000000,
              has_community_visible_stats: true,
              img_icon_url: 'hash2',
            },
            {
              appid: 570,
              name: 'Dota 2',
              playtime_forever: 18760,
              playtime_windows_forever: 18760,
              playtime_mac_forever: 0,
              playtime_linux_forever: 0,
              playtime_2weeks: 0,
              rtime_last_played: 1705000000,
              has_community_visible_stats: true,
              img_icon_url: 'hash3',
            },
            {
              appid: 4000,
              name: "Garry's Mod",
              playtime_forever: 8730,
              playtime_windows_forever: 8730,
              playtime_mac_forever: 0,
              playtime_linux_forever: 0,
              playtime_2weeks: 0,
              rtime_last_played: 1680000000,
              has_community_visible_stats: false,
              img_icon_url: 'hash4',
            },
            {
              appid: 999999,
              name: 'Unknown Test App',
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
      };

      processAndStoreGames(db, rawResponse);

      // Run matching (fixture mode)
      const stats = await matchGames(undefined, undefined, db);

      expect(stats.totalUnmatched).toBe(5);
      expect(stats.exactMatches).toBe(4);
      expect(stats.unmatched).toBe(1);
      expect(stats.ambiguousMatches).toBe(0);
      expect(stats.errors).toBe(0);

      // Verify matches in DB
      const matches = db
        .prepare('SELECT steam_app_id, igdb_id, confidence FROM matches ORDER BY steam_app_id')
        .all() as { steam_app_id: number; igdb_id: number | null; confidence: string }[];

      expect(matches).toHaveLength(5);

      // CS:2 should be matched
      const cs2 = matches.find((m) => m.steam_app_id === 730);
      expect(cs2?.igdb_id).toBe(12345);
      expect(cs2?.confidence).toBe('exact');

      // Unknown Test App should be unmatched
      const unknown = matches.find((m) => m.steam_app_id === 999999);
      expect(unknown?.igdb_id).toBeNull();
      expect(unknown?.confidence).toBe('unmatched');
    });

    it('is idempotent — running twice produces the same matches', async () => {
      // Seed one game
      db.prepare('INSERT INTO games (app_id, title, playtime_minutes) VALUES (?, ?, ?)').run(
        730,
        'Counter-Strike 2',
        100,
      );

      const stats1 = await matchGames(undefined, undefined, db);
      expect(stats1.exactMatches).toBe(1);

      const stats2 = await matchGames(undefined, undefined, db);
      expect(stats2.totalUnmatched).toBe(0); // no new unmatched after first pass
    });
  });
});
