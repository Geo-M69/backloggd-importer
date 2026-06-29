import { describe, it, expect } from 'vitest';
import { createGameMatch } from '../../src/models/match.js';

describe('createGameMatch', () => {
  it('creates an exact match via steam-appid', () => {
    const match = createGameMatch({
      steamAppId: 730,
      igdbId: 12345,
      igdbName: 'Counter-Strike 2',
      backloggdSlug: 'counter-strike-2',
      confidence: 'exact',
      matchMethod: 'steam-appid',
    });

    expect(match.steamAppId).toBe(730);
    expect(match.igdbId).toBe(12345);
    expect(match.confidence).toBe('exact');
    expect(match.matchMethod).toBe('steam-appid');
    expect(match.matchedAt).toBeTruthy();
  });

  it('creates an unmatched entry', () => {
    const match = createGameMatch({
      steamAppId: 999999,
      igdbId: null,
      igdbName: null,
      backloggdSlug: null,
      confidence: 'unmatched',
      matchMethod: null,
    });

    expect(match.igdbId).toBeNull();
    expect(match.confidence).toBe('unmatched');
    expect(match.matchMethod).toBeNull();
  });
});
