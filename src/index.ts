/**
 * backloggd-importer
 *
 * An assisted importer for matching a user's Steam library to Backloggd
 * and preparing ownership and status updates for review.
 */

export { loadConfig } from './config/index.js';
export type { Config } from './config/index.js';

export {
  createSteamGame,
  createGameMatch,
  createProposal,
  createImportSession,
} from './models/index.js';

export type {
  SteamGame,
  GameMatch,
  MatchConfidence,
  MatchMethod,
  Proposal,
  ProposalKind,
  ProposalStatus,
  ProposalPolicy,
  OwnershipSuggestion,
  StatusSuggestion,
  PlaylogSuggestion,
  SuggestionPayload,
  ImportSession,
  SessionStatus,
} from './models/index.js';

export { openDatabase, closeDatabase, getDatabase, runMigrations } from './storage/database.js';
export { getCreateTableSQL } from './storage/schema.js';

// -- Steam module ----------------------------------------------------------

export {
  fetchOwnedGames,
  clearSteamCache,
  steamCacheKey,
  getSteamCacheExpiry,
  validateSteamResponse,
  isPlayableGame,
  normalizeGame,
  processAndStoreGames,
  exportGames,
  exportGamesJson,
  exportGamesCsv,
  readFixture,
} from './steam/index.js';

export type {
  RawSteamGame,
  RawSteamResponse,
  GameExportRow,
  ExportOptions,
} from './steam/index.js';

// -- IGDB module -----------------------------------------------------------

export {
  getAccessToken,
  clearTokenCache,
  isTokenValid,
  RateLimiter,
  queryExternalGames,
  fetchExternalGames,
  globalRateLimiter,
  matchGames,
  getUnmatchedAppIds,
  getUnmatchedAppIdsNoRow,
  groupByAppId,
  classifyConfidence,
} from './igdb/index.js';

export type {
  TwitchTokenResponse,
  CachedToken,
  IgdbExternalGame,
  MatchResult,
  MatchRunStats,
} from './igdb/index.js';

// -- Review module --------------------------------------------------------

export { generateProposals, approveExactMatches, buildManifest } from './review/index.js';

export type {
  GenerateResult,
  GenerateOptions,
  ApproveResult,
  ImportManifest,
  ManifestSummary,
  ManifestItem,
  ManifestApprovedProposal,
  DriftCheckResult,
  MANIFEST_VERSION,
} from './review/index.js';

// -- Importer module ------------------------------------------------------

export {
  getItem,
  getItemsBySession,
  seedApprovedManifest,
  selectNextItem,
  reconcileImportingItems,
  transitionItem,
  recalculateSessionCounters,
  getItemCounts,
  resetFailedForRetry,
  countOwnershipCompareFailuresForRetryByReasonPrefix,
  resetOwnershipCompareFailuresForRetryByReasonPrefix,
  resetFailedItemForRetry,
  validateManifestVersion,
  validateManifestAgainstDb,
  IllegalTransitionError,
  ManifestDriftError,
} from './importer/index.js';

export type {
  ImportItemStatus,
  ImportItem,
  SeedResult,
  SelectOptions,
  ItemCounts,
} from './importer/index.js';

export { buildOwnershipSavePlan } from './importer/index.js';
export type {
  OwnershipSavePlan,
  SavePlanCandidate,
  SavePlanCounts,
  BuildSavePlanOptions,
} from './importer/index.js';

export {
  buildOwnershipConfirmationPrompt,
  applyOwnershipConfirmationSelection,
} from './importer/index.js';
export type {
  ConfirmationPrompt,
  ConfirmationPromptItem,
  SelectionInput,
  ApplyOptions,
  ApplyResult,
  ConfirmedRecord,
} from './importer/index.js';
