/**
 * CLI entry point for ownership save-plan and confirmation (Phase 5D Slice 2).
 *
 * Usage:
 *   npm run ownership:confirm -- --session <id> --show-plan
 *   npm run ownership:confirm -- --session <id> --confirm-proposals <id1,id2,id3>
 *   npm run ownership:confirm -- --session <id> --confirm-all-eligible
 *
 * Or directly:
 *   node --import dotenv/config dist/cli/ownership-confirm.js \
 *     --session <session-id> --show-plan
 *
 * Options:
 *   --session <id>                  Required. Import session ID.
 *   --show-plan                     Show the ownership save plan (read-only). No confirmations created.
 *   --confirm-proposals <ids>       Confirm exact proposal IDs (comma-separated).
 *   --confirm-all-eligible          Confirm all eligible candidates.
 *
 * Safety:
 *   - No browser work.
 *   - No Playwright launch.
 *   - --show-plan is read-only: no confirmation rows created, no items mutated.
 *   - --confirm-proposals and --confirm-all-eligible require explicit selection.
 *   - No default mode creates confirmation rows.
 *   - Unknown, duplicate, or stale selections are rejected with nonzero exit.
 */

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openDatabase, closeDatabase } from '../storage/database.js';
import { resolveImportDbPath } from './import-db.js';
import {
  buildAndShowPlan,
  confirmExactProposals,
  confirmAllEligibleProposals,
  formatPlanOutput,
  formatConfirmResult,
} from '../importer/ownership-save-confirm-cli.js';
import type { ApplyResult } from '../importer/ownership-save-confirmation.js';

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

// ---------------------------------------------------------------------------
// Exit-code decision
// ---------------------------------------------------------------------------

/**
 * Decide whether the CLI should exit with a nonzero status given the
 * confirmation selection result.
 *
 * Returns `true` (fail) when:
 * - Any selection was rejected (`rejected.length > 0`).
 * - The result is empty (no confirmed, no already-confirmed, no rejected)
 *   — e.g. invalid plan or no candidates.
 *
 * Returns `false` (success) when:
 * - All selected proposals were confirmed.
 * - All selected proposals were already confirmed (idempotent
 *   reconfirmation is treated as success).
 * - Any mix of confirmed and already-confirmed (no rejections) is
 *   treated as success.
 */
export function computeConfirmExitCode(result: ApplyResult): boolean {
  if (result.rejected.length > 0) return true;
  if (result.confirmed.length === 0 && result.alreadyConfirmed.length === 0) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // --- Parse required flags ---
  const rawSessionId = getFlagValue(args, '--session');
  const showPlan = hasFlag(args, '--show-plan');
  // Action presence for --confirm-proposals is by FLAG presence, not by
  // non-empty value.  An empty value is still an explicit action and must
  // be rejected as a conflicting action (not silently ignored).
  const confirmProposalsPresent = hasFlag(args, '--confirm-proposals');
  const rawConfirmProposals = confirmProposalsPresent
    ? (getFlagValue(args, '--confirm-proposals') ?? '')
    : undefined;
  const confirmAllEligible = hasFlag(args, '--confirm-all-eligible');

  // Trim session ID immediately
  const sessionId = (rawSessionId ?? '').trim();

  // -----------------------------------------------------------------------
  // Safety gate 1: non-empty session ID
  // -----------------------------------------------------------------------
  if (!sessionId) {
    console.error('Error: --session <id> is required and must be non-empty.');
    console.error(
      'Usage: npm run ownership:confirm -- --session <id> --show-plan | --confirm-proposals <ids> | --confirm-all-eligible',
    );
    process.exit(1);
  }

  // -----------------------------------------------------------------------
  // Safety gate 2: exactly one explicit action
  //
  // Count action presence by flag presence.  An empty --confirm-proposals
  // value still counts as the user explicitly requesting that action.
  // -----------------------------------------------------------------------
  const actionCount = [showPlan, confirmProposalsPresent, confirmAllEligible].filter(
    Boolean,
  ).length;

  if (actionCount === 0) {
    console.error(
      'Error: No action specified. Use one of: --show-plan, --confirm-proposals, --confirm-all-eligible.',
    );
    console.error(
      'Usage: npm run ownership:confirm -- --session <id> --show-plan | --confirm-proposals <ids> | --confirm-all-eligible',
    );
    process.exit(1);
  }

  if (actionCount > 1) {
    console.error(
      'Error: Conflicting actions. Specify only one of: --show-plan, --confirm-proposals, --confirm-all-eligible.',
    );
    process.exit(1);
  }

  // --- Resolve database ---
  const dbPath = resolveImportDbPath(process.env).dbPath;
  console.error(`Database: ${dbPath}`); // stderr — stdout is for structured output
  console.error(`Session: ${sessionId}`);

  const db = openDatabase(dbPath);

  try {
    // -----------------------------------------------------------------------
    // Action 1: Show plan (read-only)
    // -----------------------------------------------------------------------
    if (showPlan) {
      const { plan } = buildAndShowPlan({ db, sessionId });
      console.log(formatPlanOutput(plan));
      return;
    }

    // -----------------------------------------------------------------------
    // Action 2: Confirm exact proposals
    //
    // The flag was present, so this branch is reached regardless of whether
    // the value is empty.  Validate the value here (after action exclusivity
    // was already confirmed).
    // -----------------------------------------------------------------------
    if (confirmProposalsPresent) {
      // Parse comma-separated proposal IDs
      const proposalIds = (rawConfirmProposals ?? '').split(',').map((id) => id.trim());

      if (proposalIds.length === 0 || proposalIds.every((id) => id.length === 0)) {
        console.error('Error: --confirm-proposals requires at least one non-empty proposal ID.');
        process.exit(1);
      }

      console.error(`Confirming ${proposalIds.length} proposal(s): ${proposalIds.join(', ')}`);
      const result = confirmExactProposals({ db, sessionId, proposalIds });
      console.log(formatConfirmResult(result));

      // Exit nonzero if any selection was rejected
      const hasFailures = computeConfirmExitCode(result);
      if (hasFailures) {
        process.exitCode = 1;
      }
      return;
    }

    // -----------------------------------------------------------------------
    // Action 3: Confirm all eligible
    // -----------------------------------------------------------------------
    if (confirmAllEligible) {
      console.error('Confirming all eligible proposals…');
      const result = confirmAllEligibleProposals({ db, sessionId });
      console.log(formatConfirmResult(result));

      const hasFailures = computeConfirmExitCode(result);
      if (hasFailures) {
        process.exitCode = 1;
      }
      return;
    }
  } finally {
    closeDatabase();
  }
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  : false;

if (isMain) {
  main().catch((error) => {
    console.error(
      'Ownership confirm failed:',
      error instanceof Error ? error.message : String(error),
    );
    process.exit(1);
  });
}
