/**
 * Export normalized game data to JSON and CSV formats.
 *
 * Files are written to the project's `exports/` directory with a
 * timestamp-based filename to prevent overwriting previous exports.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Default export directory, relative to this source file. */
const DEFAULT_EXPORT_DIR = resolve(__dirname, '..', '..', 'exports');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A flattened row of game data suitable for CSV export.
 * Matches the columns written to the CSV file.
 */
export interface GameExportRow {
  appId: number;
  title: string;
  playtimeMinutes: number;
  playtimeHours: number;
  lastPlayedAt: string | null;
  isFree: boolean;
  hasDetails: boolean;
  iconUrl: string | null;
}

// ---------------------------------------------------------------------------
// Database queries
// ---------------------------------------------------------------------------

/**
 * Query all games from the database, ordered by title.
 */
function fetchAllGames(db: Database.Database): GameExportRow[] {
  const rows = db
    .prepare(
      `SELECT app_id, title, playtime_minutes, last_played_at, is_free, has_details, icon_url
       FROM games
       WHERE stale = 0
       ORDER BY title COLLATE NOCASE ASC`,
    )
    .all() as {
    app_id: number;
    title: string;
    playtime_minutes: number;
    last_played_at: string | null;
    is_free: number;
    has_details: number;
    icon_url: string | null;
  }[];

  return rows.map((r) => ({
    appId: r.app_id,
    title: r.title,
    playtimeMinutes: r.playtime_minutes,
    playtimeHours: Math.round((r.playtime_minutes / 60) * 10) / 10,
    lastPlayedAt: r.last_played_at,
    isFree: r.is_free === 1,
    hasDetails: r.has_details === 1,
    iconUrl: r.icon_url,
  }));
}

// ---------------------------------------------------------------------------
// Format writers
// ---------------------------------------------------------------------------

/**
 * Serialise games as a JSON array of GameExportRow objects.
 */
function toJson(games: GameExportRow[]): string {
  return JSON.stringify(games, null, 2) + '\n';
}

/**
 * Escape a CSV field value per OWASP CSV Injection recommendations.
 *
 * Neutralises formula injection by prefixing dangerous characters
 * ( = + - @ \t \r \n, space, full-width variants) with an apostrophe,
 * then wrapping the entire field in double quotes so the apostrophe
 * is preserved.
 *
 * Reference: https://owasp.org/www-community/attacks/CSV_Injection
 */
function csvEscape(value: string | null | undefined): string {
  if (value === null || value === undefined) return '';
  const str = String(value);

  // Check for formula-injection characters (ASCII and full-width)
  const dangerousFirstChar = /^[=+\-@\t\r\n ＠＝＋－]/.test(str);

  // Quote the field unconditionally when dangerous, or when it contains
  // special CSV characters.
  if (
    dangerousFirstChar ||
    str.includes(',') ||
    str.includes('"') ||
    str.includes('\n') ||
    str.includes('\r')
  ) {
    const escaped = str.replace(/"/g, '""');
    // Prefix with apostrophe to neutralise formula, then wrap in quotes
    return dangerousFirstChar ? `"'${escaped}"` : `"${escaped}"`;
  }

  return str;
}

/**
 * Serialise games as CSV with a header row.
 */
function toCsv(games: GameExportRow[]): string {
  const headers = [
    'appId',
    'title',
    'playtimeMinutes',
    'playtimeHours',
    'lastPlayedAt',
    'isFree',
    'hasDetails',
    'iconUrl',
  ];

  const rows = games.map((g) =>
    [
      g.appId,
      csvEscape(g.title),
      g.playtimeMinutes,
      g.playtimeHours,
      csvEscape(g.lastPlayedAt),
      g.isFree ? 'true' : 'false',
      g.hasDetails ? 'true' : 'false',
      csvEscape(g.iconUrl),
    ].join(','),
  );

  return headers.join(',') + '\n' + rows.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Options for the export function.
 */
export interface ExportOptions {
  /** Output directory (default: `exports/` at project root). */
  outputDir?: string;
  /** Optional filename stem (default: `games-<ISO timestamp>`). */
  stem?: string;
}

/**
 * Validate that a filename stem does not contain path separators or
 * parent-directory references, which could escape the output directory.
 */
function validateStem(stem: string): void {
  if (stem.length === 0) {
    throw new Error('Export stem must not be empty.');
  }
  // Block any path separator (/, \) or empty-component dot segments (. or ..)
  if (/[/\\]/.test(stem)) {
    throw new Error(
      `Export stem "${stem}" contains path separators. Use a simple filename stem without directories.`,
    );
  }
  // Also block bare "." and ".." which would resolve to empty/dot paths
  if (/^\.\.?$/.test(stem)) {
    throw new Error(
      `Export stem "${stem}" is a reserved path component. Provide a descriptive filename stem.`,
    );
  }
}

/**
 * Export all games from the database to JSON and CSV files.
 *
 * @returns The full paths of the written files.
 */
export async function exportGames(
  db: Database.Database,
  options: ExportOptions = {},
): Promise<{ jsonPath: string; csvPath: string }> {
  const games = fetchAllGames(db);
  const outputDir = options.outputDir ?? DEFAULT_EXPORT_DIR;
  const stem = options.stem ?? `games-${new Date().toISOString().replace(/[:.]/g, '-')}`;

  validateStem(stem);

  await mkdir(outputDir, { recursive: true });

  const jsonPath = resolve(outputDir, `${stem}.json`);
  const csvPath = resolve(outputDir, `${stem}.csv`);

  await Promise.all([writeFile(jsonPath, toJson(games)), writeFile(csvPath, toCsv(games))]);

  return { jsonPath, csvPath };
}

/**
 * Export games as an in-memory JSON string (useful for testing).
 */
export function exportGamesJson(games: GameExportRow[]): string {
  return toJson(games);
}

/**
 * Export games as an in-memory CSV string (useful for testing).
 */
export function exportGamesCsv(games: GameExportRow[]): string {
  return toCsv(games);
}
