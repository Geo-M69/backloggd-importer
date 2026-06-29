/**
 * Confidence level assigned to a Steam→IGDB/Backloggd match.
 */
export type MatchConfidence = 'exact' | 'probable' | 'ambiguous' | 'unmatched';

/**
 * Method used to produce the match.
 */
export type MatchMethod = 'steam-appid' | 'title-fuzzy' | 'title-year' | 'manual' | null;

/**
 * A resolved match between a Steam game and an IGDB/Backloggd record.
 */
export interface GameMatch {
  /** The Steam AppID being matched */
  steamAppId: number;
  /** The matched IGDB game ID, or null if unmatched */
  igdbId: number | null;
  /** The matched IGDB game name, or null */
  igdbName: string | null;
  /** Backloggd slug derived from the IGDB record, or null */
  backloggdSlug: string | null;
  /** Confidence in the match */
  confidence: MatchConfidence;
  /** Method used to produce this match */
  matchMethod: MatchMethod;
  /** ISO timestamp when the match was created */
  matchedAt: string;
}

/**
 * Create a new GameMatch record.
 */
export function createGameMatch(data: {
  steamAppId: number;
  igdbId: number | null;
  igdbName: string | null;
  backloggdSlug: string | null;
  confidence: MatchConfidence;
  matchMethod: MatchMethod;
}): GameMatch {
  return {
    ...data,
    matchedAt: new Date().toISOString(),
  };
}
