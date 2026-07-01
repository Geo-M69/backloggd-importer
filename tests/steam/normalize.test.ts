import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { getCreateTableSQL } from '../../src/storage/schema.js';
import { normalizeGame, isPlayableGame, processAndStoreGames } from '../../src/steam/normalize.js';
import type { RawSteamGame, RawSteamResponse } from '../../src/steam/client.js';

describe('normalize', () => {
  describe('isPlayableGame', () => {
    const makeRaw = (overrides: Partial<RawSteamGame> = {}): RawSteamGame => ({
      appid: 99999,
      name: 'Test Game',
      playtime_forever: 0,
      playtime_windows_forever: 0,
      playtime_mac_forever: 0,
      playtime_linux_forever: 0,
      playtime_2weeks: 0,
      rtime_last_played: 0,
      has_community_visible_stats: false,
      img_icon_url: null,
      ...overrides,
    });

    it('keeps a normal game', () => {
      expect(isPlayableGame(makeRaw({ appid: 730, name: 'Counter-Strike 2' }))).toBe(true);
    });

    it('filters known non-game AppIDs', () => {
      expect(isPlayableGame(makeRaw({ appid: 7, name: 'Steam Client' }))).toBe(false);
      expect(isPlayableGame(makeRaw({ appid: 480, name: 'Spacewar' }))).toBe(false);
    });

    it('filters entries with non-game title patterns', () => {
      expect(isPlayableGame(makeRaw({ name: 'Steam Link' }))).toBe(false);
      expect(isPlayableGame(makeRaw({ name: 'Proton Runtime' }))).toBe(false);
      expect(isPlayableGame(makeRaw({ name: 'Game Dedicated Server' }))).toBe(false);
      expect(isPlayableGame(makeRaw({ name: 'Redistributable Package' }))).toBe(false);
    });

    it('keeps games with "Runtime" in the title (broad pattern removed)', () => {
      // The broad /\bRuntime\b/i pattern was removed because it blocks
      // legitimate games like "RUNTIME". Only specific runtime names
      // (e.g. "Proton Runtime", "Linux Runtime") are filtered.
      expect(isPlayableGame(makeRaw({ name: 'Runtime Exception' }))).toBe(true);
    });

    it('filters specific Proton and Linux runtime titles', () => {
      expect(isPlayableGame(makeRaw({ name: 'Proton Runtime' }))).toBe(false);
      expect(isPlayableGame(makeRaw({ name: 'Linux Runtime' }))).toBe(false);
    });

    it('filters Workshop Tool titles', () => {
      expect(isPlayableGame(makeRaw({ name: 'My Game Workshop Tool' }))).toBe(false);
    });

    it('keeps legitimate games starting with "Steam" (e.g. Steam Marines)', () => {
      expect(isPlayableGame(makeRaw({ name: 'Steam Marines' }))).toBe(true);
    });

    it('keeps legitimate games starting with "SteamWorld"', () => {
      expect(isPlayableGame(makeRaw({ name: 'SteamWorld Dig' }))).toBe(true);
    });

    it('filters specific Steam utility names', () => {
      expect(isPlayableGame(makeRaw({ name: 'Steam Client' }))).toBe(false);
      expect(isPlayableGame(makeRaw({ name: 'Steam Link' }))).toBe(false);
      expect(isPlayableGame(makeRaw({ name: 'SteamVR' }))).toBe(false);
      expect(isPlayableGame(makeRaw({ name: 'Steam Audio' }))).toBe(false);
    });

    it('keeps games with "SDK" in the title (broad pattern removed)', () => {
      // The broad /\bSDK\b/i pattern was removed because it could block
      // legitimate games. Only specific SDK names are filtered.
      expect(isPlayableGame(makeRaw({ name: 'SDK Test' }))).toBe(true);
    });

    it('filters specific Source SDK titles', () => {
      expect(isPlayableGame(makeRaw({ name: 'Source SDK' }))).toBe(false);
      expect(isPlayableGame(makeRaw({ name: 'Source Filmmaker' }))).toBe(false);
    });
  });

  describe('normalizeGame', () => {
    it('converts a raw Steam game to a SteamGame model', () => {
      const raw: RawSteamGame = {
        appid: 730,
        name: 'Counter-Strike 2',
        playtime_forever: 45230,
        playtime_windows_forever: 0,
        playtime_mac_forever: 0,
        playtime_linux_forever: 45230,
        playtime_2weeks: 0,
        rtime_last_played: 1700000000,
        has_community_visible_stats: true,
        img_icon_url: 'some_icon_hash',
      };

      const game = normalizeGame(raw);

      expect(game.appId).toBe(730);
      expect(game.title).toBe('Counter-Strike 2');
      expect(game.playtimeMinutes).toBe(45230);
      expect(game.playtimeHours).toBeCloseTo(753.8, 1);
      expect(game.lastPlayedAt).toBe('2023-11-14T22:13:20.000Z');
      expect(game.isFree).toBe(false);
      expect(game.hasDetails).toBe(true);
      expect(game.iconUrl).toBe(
        'https://steamcdn-a.akamaihd.net/steamcommunity/public/images/apps/730/some_icon_hash.jpg',
      );
    });

    it('handles a game with no playtime or icon', () => {
      const raw: RawSteamGame = {
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
      };

      const game = normalizeGame(raw);

      expect(game.appId).toBe(999999);
      expect(game.playtimeMinutes).toBe(0);
      expect(game.playtimeHours).toBe(0);
      expect(game.lastPlayedAt).toBeNull();
      expect(game.iconUrl).toBeNull();
      expect(game.hasDetails).toBe(false);
    });

    it('converts rtime_last_played of 0 to null', () => {
      const raw: RawSteamGame = {
        appid: 1,
        name: 'Test',
        playtime_forever: 0,
        playtime_windows_forever: 0,
        playtime_mac_forever: 0,
        playtime_linux_forever: 0,
        playtime_2weeks: 0,
        rtime_last_played: 0,
        has_community_visible_stats: false,
        img_icon_url: null,
      };

      const game = normalizeGame(raw);
      expect(game.lastPlayedAt).toBeNull();
    });
  });

  describe('processAndStoreGames', () => {
    let db: Database.Database;

    beforeEach(() => {
      db = new Database(':memory:');
      db.exec(getCreateTableSQL());
    });

    afterEach(() => {
      db.close();
    });

    it('processes a full fixture response and stores games in the database', () => {
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
              img_icon_url: 'icon_hash',
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
              img_icon_url: 'icon_hash_2',
            },
            {
              appid: 7,
              name: 'Steam Client',
              playtime_forever: 0,
              playtime_windows_forever: 0,
              playtime_mac_forever: 0,
              playtime_linux_forever: 0,
              playtime_2weeks: 0,
              rtime_last_played: 0,
              has_community_visible_stats: false,
              img_icon_url: null,
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

      const games = processAndStoreGames(db, rawResponse);

      // Non-game (appid 7) should be filtered out
      expect(games).toHaveLength(3);

      // Check DB contents
      const rows = db.prepare('SELECT app_id, title FROM games ORDER BY title').all() as {
        app_id: number;
        title: string;
      }[];

      expect(rows).toHaveLength(3);
      expect(rows[0].title).toBe('Counter-Strike 2');
      expect(rows[1].title).toBe('Team Fortress 2');
      expect(rows[2].title).toBe('Unknown Test App');
    });

    it('is idempotent — re-processing the same data replaces rows', () => {
      const rawResponse: RawSteamResponse = {
        response: {
          game_count: 1,
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
              img_icon_url: 'icon_hash',
            },
          ],
        },
      };

      processAndStoreGames(db, rawResponse);
      processAndStoreGames(db, rawResponse);

      const count = db.prepare('SELECT COUNT(*) as count FROM games').get() as { count: number };
      expect(count.count).toBe(1);
    });

    it('handles an empty games array', () => {
      const rawResponse: RawSteamResponse = {
        response: { game_count: 0, games: [] },
      };

      const games = processAndStoreGames(db, rawResponse);
      expect(games).toHaveLength(0);
    });

    it('reconcile=true marks non-current games as stale', () => {
      // Seed an existing game that won't be in the new response
      db.prepare(
        'INSERT INTO games (app_id, title, playtime_minutes, stale) VALUES (?, ?, ?, ?)',
      ).run(999, 'Stale Game', 0, 0);

      const rawResponse: RawSteamResponse = {
        response: {
          game_count: 1,
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
          ],
        },
      };

      processAndStoreGames(db, rawResponse, true);

      // Both rows still exist
      const allRows = db.prepare('SELECT app_id, stale FROM games ORDER BY app_id').all() as {
        app_id: number;
        stale: number;
      }[];
      expect(allRows).toHaveLength(2);

      // New game is not stale; old game is stale
      expect(allRows.find((r) => r.app_id === 730)?.stale).toBe(0);
      expect(allRows.find((r) => r.app_id === 999)?.stale).toBe(1);
    });

    it('reconcile=false (default) keeps existing games not in the response', () => {
      db.prepare('INSERT INTO games (app_id, title, playtime_minutes) VALUES (?, ?, ?)').run(
        999,
        'Old Game',
        0,
      );

      const rawResponse: RawSteamResponse = {
        response: {
          game_count: 1,
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
          ],
        },
      };

      processAndStoreGames(db, rawResponse);

      const remaining = db.prepare('SELECT COUNT(*) as count FROM games').get() as {
        count: number;
      };
      expect(remaining.count).toBe(2); // old + new
    });

    it('reconcile=true handles responses containing non-game entries', () => {
      // Seed an existing game that won't be in the new response
      db.prepare(
        'INSERT INTO games (app_id, title, playtime_minutes, stale) VALUES (?, ?, ?, ?)',
      ).run(999, 'Stale Game', 0, 0);

      // Response has a non-game entry (AppID 7 = Steam Client) alongside a real game
      const rawResponse: RawSteamResponse = {
        response: {
          game_count: 2,
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
              appid: 7,
              name: 'Steam Client',
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

      processAndStoreGames(db, rawResponse, true);

      const allRows = db.prepare('SELECT app_id, stale FROM games ORDER BY app_id').all() as {
        app_id: number;
        stale: number;
      }[];
      expect(allRows).toHaveLength(2);
      expect(allRows.find((r) => r.app_id === 730)?.stale).toBe(0);
      expect(allRows.find((r) => r.app_id === 999)?.stale).toBe(1);
      // Non-game entry (AppID 7) must NOT have been inserted
      expect(allRows.find((r) => r.app_id === 7)).toBeUndefined();
    });

    it('reconcile=true handles an empty library (marks all existing rows stale)', () => {
      db.prepare(
        'INSERT INTO games (app_id, title, playtime_minutes, stale) VALUES (?, ?, ?, ?)',
      ).run(999, 'Previous Game', 100, 0);

      const rawResponse: RawSteamResponse = {
        response: { game_count: 0, games: [] },
      };

      processAndStoreGames(db, rawResponse, true);

      const allRows = db.prepare('SELECT app_id, stale FROM games').all() as {
        app_id: number;
        stale: number;
      }[];
      expect(allRows).toHaveLength(1);
      expect(allRows[0].stale).toBe(1);
    });
  });
});
