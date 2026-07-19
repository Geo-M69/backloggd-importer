/**
 * CLI entry point for read-only ownership comparison (Phase 5D Slice 3).
 *
 * Usage:
 *   npm run ownership:compare -- --session <id>
 *
 * Or directly:
 *   node --import dotenv/config dist/cli/ownership-compare.js \
 *     --session <session-id>
 *
 * Options:
 *   --session <id>          Required. Import session ID.
 *   --profile-dir <path>    Optional. Persistent browser profile directory.
 *                           Default: .playwright/backloggd-profile
 *   --headless              Optional. Run browser in headless mode.
 *   --max-items <n>         Optional. Maximum approved items to process per run.
 *   --delay-ms <n>          Optional. Delay in ms between page reads.
 *
 * Safety:
 *   This command is read-only with respect to Backloggd final actions.
 *   It uses the shared write-guarded browser path for read-only page
 *   inspection only.
 *   No final saves, staging, confirmations, or import item mutations
 *   are performed directly by this CLI.
 */

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Database } from 'better-sqlite3';
import type { BrowserContext } from 'playwright';
import { openDatabase, closeDatabase } from '../storage/database.js';
import { resolveImportDbPath } from './import-db.js';
import type { ImportDbResolution } from './import-db.js';
import { launchSession } from '../backloggd/browser.js';
import type { PocSessionOptions } from '../backloggd/browser.js';
import { hasHelpFlag } from './cli-help.js';
import {
  runOwnershipCompareCommand,
  countApprovedOwnershipItems,
  hasUnsafeComparisonOutcomes,
  formatCompareResult,
} from '../importer/ownership-compare-command.js';
import type {
  OwnershipCompareCommandOptions,
  OwnershipCompareResult,
} from '../importer/ownership-compare-command.js';

// ---------------------------------------------------------------------------
// Flag helpers
// ---------------------------------------------------------------------------

function getFlagValue(args: readonly string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

function hasFlag(args: readonly string[], flag: string): boolean {
  return args.includes(flag);
}

function parseStrictIntegerFlag(value: string, _flagName: string): number | null {
  if (!/^[0-9]+$/.test(value)) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return null;
  return parsed;
}

// ---------------------------------------------------------------------------
// Dependency-injection container type
// ---------------------------------------------------------------------------

/**
 * Dependencies for {@link runOwnershipCompareCli}.
 *
 * All functions are injected so tests can provide fakes without
 * touching real databases, browsers, or the comparison runner.
 */
export interface OwnershipCompareCliDeps {
  openDatabase: (dbPath: string) => Database;
  closeDatabase: () => void;
  launchSession: (options: PocSessionOptions) => Promise<BrowserContext>;
  runOwnershipCompareCommand: (
    options: OwnershipCompareCommandOptions,
  ) => Promise<OwnershipCompareResult>;
  resolveImportDbPath: (env: NodeJS.ProcessEnv) => ImportDbResolution;
  countApprovedOwnershipItems: (db: Database, sessionId: string) => number;
  hasUnsafeComparisonOutcomes: (result: OwnershipCompareResult) => boolean;
  formatCompareResult: (result: OwnershipCompareResult) => string;
  consoleLog: (message: string) => void;
  consoleError: (message: string) => void;
}

// ---------------------------------------------------------------------------
// Production dependency container
// ---------------------------------------------------------------------------

const productionDeps: OwnershipCompareCliDeps = {
  openDatabase,
  closeDatabase,
  launchSession,
  runOwnershipCompareCommand,
  resolveImportDbPath,
  countApprovedOwnershipItems,
  hasUnsafeComparisonOutcomes,
  formatCompareResult,
  consoleLog: (message: string) => console.log(message),
  consoleError: (message: string) => console.error(message),
};

// ---------------------------------------------------------------------------
// Testable CLI runner
// ---------------------------------------------------------------------------

/**
 * Run the ownership-compare CLI with explicit arguments and dependencies.
 *
 * Returns the intended process exit code (0 = success, 1 = failure) instead
 * of calling `process.exit()` directly, so callers can test behaviour
 * without terminating the process.
 *
 * The caller (e.g. the `isMain` wrapper) is responsible for setting
 * `process.exitCode` from the return value.
 */
export async function runOwnershipCompareCli(
  argv: string[],
  deps: OwnershipCompareCliDeps = productionDeps,
): Promise<number> {
  // --- Help check before any side effects ---
  if (hasHelpFlag(argv)) {
    deps.consoleLog('Usage: npm run ownership:compare -- --session <id> [options]');
    deps.consoleLog('');
    deps.consoleLog('Read-only ownership comparison against Backloggd.');
    deps.consoleLog('Options:');
    deps.consoleLog('  --session <id>          Required. Import session ID.');
    deps.consoleLog('  --profile-dir <path>    Optional. Persistent browser profile directory.');
    deps.consoleLog('                          Default: .playwright/backloggd-profile');
    deps.consoleLog('  --headless              Optional. Run browser in headless mode.');
    deps.consoleLog(
      '  --max-items <n>         Optional. Max approved items to process. Must be positive integer.',
    );
    deps.consoleLog(
      '  --delay-ms <n>          Optional. Delay (ms) between page reads. Must be nonnegative integer.',
    );
    return 0;
  }

  // --- Parse required flags ---
  const rawSessionId = getFlagValue(argv, '--session');

  // --- Trim session ID immediately after parsing ---
  const sessionId = (rawSessionId ?? '').trim();

  if (!sessionId) {
    deps.consoleError('Error: --session <id> is required and must be non-empty.');
    deps.consoleError('Usage: npm run ownership:compare -- --session <id>');
    return 1;
  }

  const profileDir = resolve(
    getFlagValue(argv, '--profile-dir') ?? '.playwright/backloggd-profile',
  );
  const headless = hasFlag(argv, '--headless');

  // --- Parse batch/pacing flags ---
  const rawMaxItems = getFlagValue(argv, '--max-items');
  let maxItems: number | undefined;
  if (hasFlag(argv, '--max-items')) {
    if (rawMaxItems === undefined) {
      deps.consoleError('Error: --max-items must be a positive integer.');
      return 1;
    }
    const parsed = parseStrictIntegerFlag(rawMaxItems, '--max-items');
    if (parsed === null || parsed < 1) {
      deps.consoleError('Error: --max-items must be a positive integer.');
      return 1;
    }
    maxItems = parsed;
  }

  const rawDelayMs = getFlagValue(argv, '--delay-ms');
  let delayMs: number | undefined;
  if (hasFlag(argv, '--delay-ms')) {
    if (rawDelayMs === undefined) {
      deps.consoleError('Error: --delay-ms must be a nonnegative integer.');
      return 1;
    }
    const parsed = parseStrictIntegerFlag(rawDelayMs, '--delay-ms');
    if (parsed === null || parsed < 0) {
      deps.consoleError('Error: --delay-ms must be a nonnegative integer.');
      return 1;
    }
    delayMs = parsed;
  }

  // --- Resolve database ---
  const { dbPath } = deps.resolveImportDbPath(process.env);
  deps.consoleLog(`Database: ${dbPath}`);

  const db = deps.openDatabase(dbPath);

  try {
    // --- Pre-check: approved ownership items exist before launching browser ---
    const approvedCount = deps.countApprovedOwnershipItems(db, sessionId);
    deps.consoleLog(`Session: ${sessionId}`);
    deps.consoleLog(`Approved ownership items: ${approvedCount}`);

    if (approvedCount === 0) {
      deps.consoleLog('No approved ownership items found. Nothing to compare.');
      return 0;
    }

    // --- Launch browser via shared automation path ---
    deps.consoleLog(`Launching browser (headless: ${headless})…`);
    const context = await deps.launchSession({ profileDir, headless });
    const page = await context.newPage();

    try {
      // --- Run read-only ownership comparison ---
      deps.consoleLog('Running read-only ownership comparison…');
      const result = await deps.runOwnershipCompareCommand({
        db,
        sessionId,
        page,
        maxItems,
        delayMs,
      });

      deps.consoleLog('\n--- Result ---');
      deps.consoleLog(deps.formatCompareResult(result));

      // --- Exit nonzero for unsafe outcomes ---
      if (deps.hasUnsafeComparisonOutcomes(result)) {
        return 1;
      }
      return 0;
    } finally {
      await context.close();
    }
  } finally {
    deps.closeDatabase();
  }
}

// ---------------------------------------------------------------------------
// Main (thin wrapper)
// ---------------------------------------------------------------------------

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  : false;

if (isMain) {
  runOwnershipCompareCli(process.argv.slice(2)).then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    (error: unknown) => {
      console.error(
        'Ownership compare failed:',
        error instanceof Error ? error.message : String(error),
      );
      process.exitCode = 1;
    },
  );
}
