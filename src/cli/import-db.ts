/**
 * Resolve whether import commands should use fixture or live database.
 *
 * Safety rule:
 * - No Steam/IGDB credentials at all => fixture mode (`import.fixture.db`)
 * - Full Steam + full IGDB credentials => live mode (DB_PATH or import.db)
 * - Any partial/mixed credential state => fail fast as ambiguous
 */

export interface ImportDbResolution {
  mode: 'fixture' | 'live';
  dbPath: string;
}

function hasValue(v: string | undefined): boolean {
  return typeof v === 'string' && v.length > 0;
}

/**
 * Resolve the database path for Milestone 3 import commands.
 */
export function resolveImportDbPath(
  env: NodeJS.ProcessEnv = process.env,
  liveDefault = './import.db',
  fixturePath = './import.fixture.db',
): ImportDbResolution {
  const hasSteamApiKey = hasValue(env.STEAM_API_KEY);
  const hasSteamUserId = hasValue(env.STEAM_USER_ID);
  const hasIgdbClientId = hasValue(env.IGDB_CLIENT_ID);
  const hasIgdbClientSecret = hasValue(env.IGDB_CLIENT_SECRET);

  const steamPartial = hasSteamApiKey !== hasSteamUserId;
  const igdbPartial = hasIgdbClientId !== hasIgdbClientSecret;

  if (steamPartial) {
    throw new Error(
      'Partial Steam credentials detected. Set both STEAM_API_KEY and STEAM_USER_ID for live mode, or unset both for fixture mode.',
    );
  }

  if (igdbPartial) {
    throw new Error(
      'Partial IGDB credentials detected. Set both IGDB_CLIENT_ID and IGDB_CLIENT_SECRET for live mode, or unset both for fixture mode.',
    );
  }

  const hasAnyCredentials =
    hasSteamApiKey || hasSteamUserId || hasIgdbClientId || hasIgdbClientSecret;
  if (!hasAnyCredentials) {
    // Fixture mode intentionally ignores DB_PATH to keep fixture/live isolated.
    return { mode: 'fixture', dbPath: fixturePath };
  }

  const hasFullSteam = hasSteamApiKey && hasSteamUserId;
  const hasFullIgdb = hasIgdbClientId && hasIgdbClientSecret;

  if (hasFullSteam && hasFullIgdb) {
    return { mode: 'live', dbPath: env.DB_PATH ?? liveDefault };
  }

  throw new Error(
    'Cannot infer import mode safely. Use full Steam+IGDB credentials for live mode, or unset all credentials for fixture mode.',
  );
}
