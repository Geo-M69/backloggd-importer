import { describe, it, expect } from 'vitest';
import { exportGamesJson, exportGamesCsv } from '../../src/steam/exporter.js';
import type { GameExportRow } from '../../src/steam/exporter.js';

describe('exporter', () => {
  const sampleGames: GameExportRow[] = [
    {
      appId: 730,
      title: 'Counter-Strike 2',
      playtimeMinutes: 45230,
      playtimeHours: 753.8,
      lastPlayedAt: '2024-11-14T22:13:20.000Z',
      isFree: false,
      hasDetails: true,
      iconUrl: 'https://steamcdn-a.akamaihd.net/steamcommunity/public/images/apps/730/hash.jpg',
    },
    {
      appId: 440,
      title: 'Team Fortress 2',
      playtimeMinutes: 21150,
      playtimeHours: 352.5,
      lastPlayedAt: '2024-09-17T20:00:00.000Z',
      isFree: true,
      hasDetails: true,
      iconUrl: null,
    },
    {
      appId: 999999,
      title: 'Never Played',
      playtimeMinutes: 0,
      playtimeHours: 0,
      lastPlayedAt: null,
      isFree: false,
      hasDetails: false,
      iconUrl: null,
    },
  ];

  describe('exportGamesJson', () => {
    it('produces valid JSON with all fields', () => {
      const json = exportGamesJson(sampleGames);
      const parsed = JSON.parse(json) as GameExportRow[];

      expect(parsed).toHaveLength(3);
      expect(parsed[0].appId).toBe(730);
      expect(parsed[0].title).toBe('Counter-Strike 2');
      expect(parsed[2].lastPlayedAt).toBeNull();
    });

    it('pretty-prints with 2-space indent', () => {
      const json = exportGamesJson([sampleGames[0]]);
      expect(json).toContain('  "appId": 730,');
    });

    it('handles an empty array', () => {
      const json = exportGamesJson([]);
      expect(JSON.parse(json)).toEqual([]);
    });
  });

  describe('exportGamesCsv', () => {
    it('has a header row', () => {
      const csv = exportGamesCsv(sampleGames);
      const lines = csv.trim().split('\n');
      expect(lines[0]).toBe(
        'appId,title,playtimeMinutes,playtimeHours,lastPlayedAt,isFree,hasDetails,iconUrl',
      );
    });

    it('has the correct number of data rows', () => {
      const csv = exportGamesCsv(sampleGames);
      const lines = csv.trim().split('\n');
      // Header + 3 data rows
      expect(lines).toHaveLength(4);
    });

    it('escapes fields containing commas or quotes', () => {
      const gamesWithComma: GameExportRow[] = [
        {
          appId: 1,
          title: 'Game, The',
          playtimeMinutes: 10,
          playtimeHours: 0.2,
          lastPlayedAt: null,
          isFree: false,
          hasDetails: true,
          iconUrl: null,
        },
      ];

      const csv = exportGamesCsv(gamesWithComma);
      expect(csv).toContain('"Game, The"');
    });

    it('escapes fields containing double quotes', () => {
      const gamesWithQuote: GameExportRow[] = [
        {
          appId: 2,
          title: 'Game "Quoted"',
          playtimeMinutes: 0,
          playtimeHours: 0,
          lastPlayedAt: null,
          isFree: false,
          hasDetails: true,
          iconUrl: null,
        },
      ];

      const csv = exportGamesCsv(gamesWithQuote);
      expect(csv).toContain('"Game ""Quoted"""');
    });

    it('neutralises formula injection in titles starting with =', () => {
      const games: GameExportRow[] = [
        {
          appId: 1,
          title: '=SUM(A1:A10)',
          playtimeMinutes: 0,
          playtimeHours: 0,
          lastPlayedAt: null,
          isFree: false,
          hasDetails: true,
          iconUrl: null,
        },
      ];

      const csv = exportGamesCsv(games);
      expect(csv).toContain("'=SUM(A1:A10)");
    });

    it('neutralises formula injection in titles starting with +, -, @', () => {
      const games: GameExportRow[] = [
        {
          appId: 1,
          title: '+IMPORTANT',
          playtimeMinutes: 0,
          playtimeHours: 0,
          lastPlayedAt: null,
          isFree: false,
          hasDetails: true,
          iconUrl: null,
        },
        {
          appId: 2,
          title: '-DANGER',
          playtimeMinutes: 0,
          playtimeHours: 0,
          lastPlayedAt: null,
          isFree: false,
          hasDetails: true,
          iconUrl: null,
        },
        {
          appId: 3,
          title: '@SUM',
          playtimeMinutes: 0,
          playtimeHours: 0,
          lastPlayedAt: null,
          isFree: false,
          hasDetails: true,
          iconUrl: null,
        },
      ];

      const csv = exportGamesCsv(games);
      expect(csv).toContain("'+IMPORTANT");
      expect(csv).toContain("'-DANGER");
      expect(csv).toContain("'@SUM");
    });

    it('neutralises formula injection with tab, CR, LF prefixes', () => {
      const games: GameExportRow[] = [
        {
          appId: 1,
          title: '\t=SUM(A1)',
          playtimeMinutes: 0,
          playtimeHours: 0,
          lastPlayedAt: null,
          isFree: false,
          hasDetails: true,
          iconUrl: null,
        },
        {
          appId: 2,
          title: '\r=CMD',
          playtimeMinutes: 0,
          playtimeHours: 0,
          lastPlayedAt: null,
          isFree: false,
          hasDetails: true,
          iconUrl: null,
        },
        {
          appId: 3,
          title: '\n=EXEC',
          playtimeMinutes: 0,
          playtimeHours: 0,
          lastPlayedAt: null,
          isFree: false,
          hasDetails: true,
          iconUrl: null,
        },
      ];

      const csv = exportGamesCsv(games);
      expect(csv).toContain("'\t=SUM(A1)");
      expect(csv).toContain("'\r=CMD");
      expect(csv).toContain("'\n=EXEC");
    });

    it('neutralises formula injection with full-width characters', () => {
      const games: GameExportRow[] = [
        {
          appId: 1,
          title: '＝SUM',
          playtimeMinutes: 0,
          playtimeHours: 0,
          lastPlayedAt: null,
          isFree: false,
          hasDetails: true,
          iconUrl: null,
        },
        {
          appId: 2,
          title: '＠DANGER',
          playtimeMinutes: 0,
          playtimeHours: 0,
          lastPlayedAt: null,
          isFree: false,
          hasDetails: true,
          iconUrl: null,
        },
      ];

      const csv = exportGamesCsv(games);
      expect(csv).toContain("'＝SUM");
      expect(csv).toContain("'＠DANGER");
    });

    it('represents booleans as "true"/"false"', () => {
      const csv = exportGamesCsv(sampleGames);
      expect(csv).toContain('true');
      expect(csv).toContain('false');
    });

    it('handles empty array', () => {
      const csv = exportGamesCsv([]);
      expect(csv.trim().split('\n')).toHaveLength(1); // header only
    });
  });
});
