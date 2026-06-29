import { describe, it, expect } from 'vitest';
import { createSteamGame } from '../../src/models/game.js';

describe('createSteamGame', () => {
  it('creates a SteamGame with derived playtimeHours', () => {
    const game = createSteamGame({
      appId: 730,
      title: 'Counter-Strike 2',
      iconUrl: 'icon_hash',
      playtimeMinutes: 45230,
      lastPlayedAt: '2024-01-15T10:00:00Z',
      isFree: true,
      hasDetails: true,
    });

    expect(game.appId).toBe(730);
    expect(game.title).toBe('Counter-Strike 2');
    expect(game.playtimeMinutes).toBe(45230);
    expect(game.playtimeHours).toBeCloseTo(753.8, 1);
    expect(game.lastPlayedAt).toBe('2024-01-15T10:00:00Z');
    expect(game.isFree).toBe(true);
    expect(game.hasDetails).toBe(true);
  });

  it('handles zero playtime', () => {
    const game = createSteamGame({
      appId: 999999,
      title: 'Never played',
      iconUrl: null,
      playtimeMinutes: 0,
      lastPlayedAt: null,
      isFree: false,
      hasDetails: false,
    });

    expect(game.playtimeMinutes).toBe(0);
    expect(game.playtimeHours).toBe(0);
    expect(game.iconUrl).toBeNull();
    expect(game.lastPlayedAt).toBeNull();
  });
});
