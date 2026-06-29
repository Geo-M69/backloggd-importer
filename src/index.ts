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
  ProposalAction,
  ProposalStatus,
  ImportSession,
  SessionStatus,
} from './models/index.js';

export { openDatabase, closeDatabase, getDatabase } from './storage/database.js';
export { getCreateTableSQL } from './storage/schema.js';
