import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type Database from 'better-sqlite3';
import { clearTokenCache } from '../igdb/auth.js';
import { clearSteamCache } from '../steam/client.js';
import { closeCacheDatabase, openCacheDatabase } from '../storage/database.js';
import { hasHelpFlag } from './cli-help.js';
import { resolveImportDbPath } from './import-db.js';
import type { ImportDbResolution } from './import-db.js';

type CacheTarget = 'steam' | 'igdb' | 'all';

const supportedFlags = new Set(['--steam', '--igdb', '--all']);

function parseTarget(argv: readonly string[]): CacheTarget | null {
  if (argv.some((arg) => !supportedFlags.has(arg))) return null;
  if (argv.length !== 1) return null;

  switch (argv[0]) {
    case '--steam':
      return 'steam';
    case '--igdb':
      return 'igdb';
    case '--all':
      return 'all';
    default:
      return null;
  }
}

export interface CacheClearCliDeps {
  openCacheDatabase: (dbPath: string) => Database.Database;
  closeCacheDatabase: (db: Database.Database) => void;
  resolveImportDbPath: (env: NodeJS.ProcessEnv) => ImportDbResolution;
  clearSteamCache: (steamUserId: string, db: Database.Database) => void;
  clearTokenCache: (clientId: string, db: Database.Database) => void;
  consoleLog: (message: string) => void;
  consoleError: (message: string) => void;
}

const productionDeps: CacheClearCliDeps = {
  openCacheDatabase,
  closeCacheDatabase,
  resolveImportDbPath,
  clearSteamCache,
  clearTokenCache,
  consoleLog: (message: string) => console.log(message),
  consoleError: (message: string) => console.error(message),
};

function printHelp(consoleLog: (message: string) => void): void {
  consoleLog('Usage: npm run cache:clear -- --steam | --igdb | --all');
  consoleLog('');
  consoleLog('Clear one explicitly selected persistent API cache entry.');
  consoleLog('Options (exactly one required):');
  consoleLog('  --steam    Clear the cached Steam GetOwnedGames response for STEAM_USER_ID.');
  consoleLog('  --igdb     Clear the cached IGDB OAuth token for IGDB_CLIENT_ID.');
  consoleLog('  --all      Clear both selected cache entries atomically.');
}

function requiredValue(env: NodeJS.ProcessEnv, name: string): string | null {
  const value = env[name];
  return value?.trim() ? value : null;
}

export async function runCacheClearCli(
  argv: string[],
  deps: CacheClearCliDeps = productionDeps,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  if (hasHelpFlag(argv)) {
    printHelp(deps.consoleLog);
    return 0;
  }

  const target = parseTarget(argv);
  if (!target) {
    deps.consoleError('Error: specify exactly one cache target: --steam, --igdb, or --all.');
    deps.consoleError('Usage: npm run cache:clear -- --steam | --igdb | --all');
    return 1;
  }

  const steamUserId = target === 'igdb' ? null : requiredValue(env, 'STEAM_USER_ID');
  if (target !== 'igdb' && !steamUserId) {
    deps.consoleError('Error: STEAM_USER_ID is required to clear the Steam cache entry.');
    return 1;
  }

  const igdbClientId = target === 'steam' ? null : requiredValue(env, 'IGDB_CLIENT_ID');
  if (target !== 'steam' && !igdbClientId) {
    deps.consoleError('Error: IGDB_CLIENT_ID is required to clear the IGDB cache entry.');
    return 1;
  }

  const { dbPath } = deps.resolveImportDbPath(env);
  const db = deps.openCacheDatabase(dbPath);
  try {
    if (target === 'steam') {
      deps.clearSteamCache(steamUserId as string, db);
      deps.consoleLog('Cleared Steam GetOwnedGames cache entry.');
    }
    if (target === 'igdb') {
      deps.clearTokenCache(igdbClientId as string, db);
      deps.consoleLog('Cleared IGDB OAuth token cache entry.');
    }
    if (target === 'all') {
      db.transaction(() => {
        deps.clearSteamCache(steamUserId as string, db);
        deps.clearTokenCache(igdbClientId as string, db);
      })();
      deps.consoleLog('Cleared Steam GetOwnedGames cache entry.');
      deps.consoleLog('Cleared IGDB OAuth token cache entry.');
    }
    return 0;
  } finally {
    deps.closeCacheDatabase(db);
  }
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  : false;

if (isMain) {
  runCacheClearCli(process.argv.slice(2)).then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    (error: unknown) => {
      console.error('Cache clear failed:', error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
