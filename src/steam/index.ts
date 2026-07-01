/**
 * Steam module — fetch, normalise, filter, and export a user's Steam library.
 */

export {
  fetchOwnedGames,
  clearSteamCache,
  steamCacheKey,
  getSteamCacheExpiry,
  validateSteamResponse,
} from './client.js';
export type { RawSteamGame, RawSteamResponse } from './client.js';

export { isPlayableGame, normalizeGame, processAndStoreGames } from './normalize.js';

export { exportGames, exportGamesJson, exportGamesCsv } from './exporter.js';
export type { GameExportRow, ExportOptions } from './exporter.js';

export { readFixture } from './fixtures.js';
