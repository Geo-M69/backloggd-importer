/**
 * Normalized representation of a Steam game for import processing.
 */
export interface SteamGame {
  /** Steam AppID */
  appId: number;
  /** Game title */
  title: string;
  /** URL for the game's library icon, or null if unavailable */
  iconUrl: string | null;
  /** Total lifetime playtime in minutes */
  playtimeMinutes: number;
  /** Total lifetime playtime in hours (derived, rounded to 1dp) */
  playtimeHours: number;
  /** ISO timestamp of last play, or null if never played */
  lastPlayedAt: string | null;
  /** Whether the game requires no purchase (free-to-play, demo, etc.) */
  isFree: boolean;
  /** Whether full game details were available from the API */
  hasDetails: boolean;
}

/**
 * Create a SteamGame from raw API data.
 */
export function createSteamGame(data: {
  appId: number;
  title: string;
  iconUrl: string | null;
  playtimeMinutes: number;
  lastPlayedAt: string | null;
  isFree: boolean;
  hasDetails: boolean;
}): SteamGame {
  return {
    ...data,
    playtimeHours: Math.round((data.playtimeMinutes / 60) * 10) / 10,
  };
}
