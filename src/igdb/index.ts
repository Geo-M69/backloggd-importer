/**
 * IGDB module — authenticate, query, and match Steam games against
 * IGDB external-game records.
 */

export { getAccessToken, clearTokenCache, isTokenValid } from './auth.js';
export type { TwitchTokenResponse, CachedToken } from './auth.js';

export {
  RateLimiter,
  queryExternalGames,
  fetchExternalGames,
  globalRateLimiter,
} from './client.js';
export type { IgdbExternalGame } from './client.js';

export {
  matchGames,
  getUnmatchedAppIds,
  getUnmatchedAppIdsNoRow,
  groupByAppId,
  classifyConfidence,
} from './matcher.js';
export type { MatchResult, MatchRunStats } from './matcher.js';
