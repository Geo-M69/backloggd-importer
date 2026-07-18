/**
 * CLI entry point for local-only ownership compare retry reset.
 *
 * Usage:
 *   npm run ownership:retry-failed -- --session <id> --reason-prefix <prefix>
 *
 * Options:
 *   --session <id>            Required. Import session ID.
 *   --reason-prefix <prefix>  Required. Literal outcome_reason prefix.
 *   --dry-run                 Optional. Count matches without mutation.
 *
 * Safety:
 *   This command only updates local import_items retry state. It does not
 *   import browser, compare, confirm, save, final-save, or Backloggd modules.
 *   It does not touch proposals or import_item_confirmations.
 */

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type Database from 'better-sqlite3';
import { openDatabase, closeDatabase } from '../storage/database.js';
import { resolveImportDbPath } from './import-db.js';
import type { ImportDbResolution } from './import-db.js';
import { hasHelpFlag } from './cli-help.js';
import {
  countOwnershipCompareFailuresForRetryByReasonPrefix,
  resetOwnershipCompareFailuresForRetryByReasonPrefix,
} from '../importer/import-items.js';

function getFlagValue(args: readonly string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

function hasFlag(args: readonly string[], flag: string): boolean {
  return args.includes(flag);
}

export interface OwnershipRetryFailedCliDeps {
  openDatabase: (dbPath: string) => Database.Database;
  closeDatabase: () => void;
  resolveImportDbPath: (env: NodeJS.ProcessEnv) => ImportDbResolution;
  countFailures: (db: Database.Database, sessionId: string, reasonPrefix: string) => number;
  resetFailures: (db: Database.Database, sessionId: string, reasonPrefix: string) => number;
  consoleLog: (message: string) => void;
  consoleError: (message: string) => void;
}

const productionDeps: OwnershipRetryFailedCliDeps = {
  openDatabase,
  closeDatabase,
  resolveImportDbPath,
  countFailures: countOwnershipCompareFailuresForRetryByReasonPrefix,
  resetFailures: resetOwnershipCompareFailuresForRetryByReasonPrefix,
  consoleLog: (message: string) => console.log(message),
  consoleError: (message: string) => console.error(message),
};

export async function runOwnershipRetryFailedCli(
  argv: string[],
  deps: OwnershipRetryFailedCliDeps = productionDeps,
): Promise<number> {
  if (hasHelpFlag(argv)) {
    deps.consoleLog(
      'Usage: npm run ownership:retry-failed -- --session <id> --reason-prefix <prefix> [--dry-run]',
    );
    deps.consoleLog('');
    deps.consoleLog('Reset local ownership compare failures for retry.');
    deps.consoleLog('Options:');
    deps.consoleLog('  --session <id>            Required. Import session ID.');
    deps.consoleLog('  --reason-prefix <prefix>  Required. Literal outcome_reason prefix.');
    deps.consoleLog('  --dry-run                 Optional. Count matches without mutation.');
    return 0;
  }

  const sessionId = (getFlagValue(argv, '--session') ?? '').trim();
  if (!sessionId) {
    deps.consoleError('Error: --session <id> is required and must be non-empty.');
    deps.consoleError(
      'Usage: npm run ownership:retry-failed -- --session <id> --reason-prefix <prefix>',
    );
    return 1;
  }

  const reasonPrefix = (getFlagValue(argv, '--reason-prefix') ?? '').trim();
  if (!reasonPrefix) {
    deps.consoleError('Error: --reason-prefix <prefix> is required and must be non-empty.');
    deps.consoleError('Refusing broad retry reset without a narrow reason selector.');
    deps.consoleError(
      'Usage: npm run ownership:retry-failed -- --session <id> --reason-prefix <prefix>',
    );
    return 1;
  }

  const dryRun = hasFlag(argv, '--dry-run');
  const { dbPath } = deps.resolveImportDbPath(process.env);
  deps.consoleLog(`Database: ${dbPath}`);
  deps.consoleLog(`Session: ${sessionId}`);
  deps.consoleLog(`Reason prefix: ${reasonPrefix}`);

  const db = deps.openDatabase(dbPath);
  try {
    const matched = deps.countFailures(db, sessionId, reasonPrefix);
    const reset = dryRun ? 0 : deps.resetFailures(db, sessionId, reasonPrefix);
    deps.consoleLog(`Matched rows: ${matched}`);
    deps.consoleLog(`Reset rows: ${reset}`);
    if (dryRun) {
      deps.consoleLog('Dry run: no rows were reset.');
    }
    return 0;
  } finally {
    deps.closeDatabase();
  }
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  : false;

if (isMain) {
  runOwnershipRetryFailedCli(process.argv.slice(2)).then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    (error: unknown) => {
      console.error(
        'Ownership retry reset failed:',
        error instanceof Error ? error.message : String(error),
      );
      process.exitCode = 1;
    },
  );
}
