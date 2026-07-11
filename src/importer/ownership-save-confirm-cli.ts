/**
 * Ownership save confirmation CLI integration — Phase 5D Slice 2.
 *
 * Minimal explicit operator path to build the ownership save plan,
 * display/report eligible candidates deterministically, and record durable
 * confirmation rows from an explicit selection.
 *
 * ## Safety guarantees
 *
 * - No browser/page argument accepted.
 * - Playwright is not imported.
 * - No navigation, no Backloggd reads.
 * - No calls to `runConfirmedOwnershipSave`, `stageOwnershipInBrowser`,
 *   `runConfirmedOwnershipStaging`.
 * - No calls to `processItem`, `transitionItem`, or `reconcileItem`.
 * - No mutation of `import_items` status.
 * - No mutation of proposal rows.
 * - Confirmation rows are created only through the audited
 *   `applyOwnershipConfirmationSelection` function.
 * - `--show-plan` is read-only: no confirmation rows created, no items
 *   mutated.
 * - `--confirm-proposals` and `--confirm-all-eligible` require explicit
 *   non-empty selection.
 * - No default mode creates confirmation rows.
 * - Unknown, duplicate, or stale selections are rejected with nonzero exit.
 */

import type Database from 'better-sqlite3';
import { buildOwnershipSavePlan } from './ownership-save-plan.js';
import { applyOwnershipConfirmationSelection } from './ownership-save-confirmation.js';
import type {
  OwnershipSavePlan,
  SavePlanCounts,
  SavePlanCandidate,
} from './ownership-save-plan.js';
import type { ApplyResult, ConfirmedRecord } from './ownership-save-confirmation.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Options for {@link buildAndShowPlan}.
 */
export interface BuildAndShowPlanOptions {
  /** Database instance. */
  db: Database.Database;
  /** Import session ID — must be non-empty after trim. */
  sessionId: string;
}

/**
 * Read-only result from showing the ownership save plan.
 */
export interface ShowPlanResult {
  /** The full ownership save plan (candidates + counts). */
  plan: OwnershipSavePlan;
}

/**
 * Options for {@link confirmExactProposals}.
 */
export interface ConfirmExactProposalsOptions {
  /** Database instance. */
  db: Database.Database;
  /** Import session ID — must be non-empty after trim. */
  sessionId: string;
  /** Array of proposal IDs to confirm. Each is trimmed of whitespace. */
  proposalIds: string[];
}

/**
 * Options for {@link confirmAllEligibleProposals}.
 */
export interface ConfirmAllEligibleOptions {
  /** Database instance. */
  db: Database.Database;
  /** Import session ID — must be non-empty after trim. */
  sessionId: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assertNonEmptySession(sessionId: string): string {
  const trimmed = (sessionId ?? '').trim();
  if (trimmed.length === 0) {
    throw new Error('sessionId is required and must be non-empty.');
  }
  return trimmed;
}

// ---------------------------------------------------------------------------
// Plan builder (shared)
// ---------------------------------------------------------------------------

/**
 * Build the ownership save plan for a session.
 *
 * Pure DB read — no browser interaction, no mutations, no confirmation rows.
 *
 * @throws {Error} If sessionId is empty or whitespace-only.
 */
export function buildPlan(db: Database.Database, sessionId: string): OwnershipSavePlan {
  const id = assertNonEmptySession(sessionId);
  return buildOwnershipSavePlan({ db, sessionId: id });
}

// ---------------------------------------------------------------------------
// Show plan (read-only)
// ---------------------------------------------------------------------------

/**
 * Build and return the ownership save plan for display purposes.
 *
 * This is a pure read-only operation:
 * - No confirmation rows are created.
 * - No import items are mutated.
 * - No proposals are mutated.
 * - No browser is launched.
 */
export function buildAndShowPlan(options: BuildAndShowPlanOptions): ShowPlanResult {
  const plan = buildPlan(options.db, options.sessionId);
  return { plan };
}

// ---------------------------------------------------------------------------
// Confirm exact proposals
// ---------------------------------------------------------------------------

/**
 * Confirm exact proposal IDs from the ownership save plan.
 *
 * Each proposal ID is trimmed of leading/trailing whitespace before
 * processing.  Empty or whitespace-only tokens are rejected explicitly
 * (no silent filtering).  Unknown, duplicate, or stale selections are
 * rejected.
 *
 * Confirmation rows are created only through the audited
 * `applyOwnershipConfirmationSelection` function.
 *
 * @throws {Error} If proposalIds is empty.
 * @throws {Error} If any token trims to an empty string.
 * @throws {Error} If unknown or duplicate proposal IDs are present (bubbled
 *         from the confirmation-selection function).
 */
export function confirmExactProposals(options: ConfirmExactProposalsOptions): ApplyResult {
  const id = assertNonEmptySession(options.sessionId);

  // Trim each proposal ID.  Reject the whole call if ANY provided token
  // trims to an empty string — do not silently filter empty tokens.
  if (!Array.isArray(options.proposalIds) || options.proposalIds.length === 0) {
    throw new Error('Empty selection: at least one non-empty proposal ID is required.');
  }

  const trimmedIds: string[] = [];
  for (const raw of options.proposalIds) {
    const trimmed = (raw ?? '').trim();
    if (trimmed.length === 0) {
      throw new Error('Empty proposal ID in selection: every token must be non-empty after trim.');
    }
    trimmedIds.push(trimmed);
  }

  const plan = buildPlan(options.db, id);
  return applyOwnershipConfirmationSelection(options.db, plan, { byProposalIds: trimmedIds });
}

// ---------------------------------------------------------------------------
// Confirm all eligible
// ---------------------------------------------------------------------------

/**
 * Confirm all eligible candidates in the ownership save plan.
 *
 * Confirmation rows are created only through the audited
 * `applyOwnershipConfirmationSelection` function with `selectAll`.
 */
export function confirmAllEligibleProposals(options: ConfirmAllEligibleOptions): ApplyResult {
  const id = assertNonEmptySession(options.sessionId);
  const plan = buildPlan(options.db, id);
  return applyOwnershipConfirmationSelection(options.db, plan, { selectAll: true });
}

// ---------------------------------------------------------------------------
// Format helpers (deterministic plain-text output)
// ---------------------------------------------------------------------------

/**
 * Format a SavePlanCandidate to a single-line string for display.
 */
export function formatCandidateLine(c: SavePlanCandidate, index: number): string {
  const title = c.gameTitle ?? '<unknown title>';
  const slug = c.backloggdSlug ?? '<no-slug>';
  return [
    `[#${index}]`,
    `proposal=${c.proposalId}`,
    `appid=${c.steamAppId}`,
    `title=${title}`,
    `slug=${slug}`,
    `platform=${c.desiredPlatform}`,
    `ownership=${c.desiredOwnershipType}`,
    `checked-at=${c.proofCheckedAt}`,
    `eligibility=${c.eligibility}`,
  ].join(' | ');
}

/**
 * Format counts for display.
 */
export function formatCountsLines(counts: SavePlanCounts): string[] {
  return [
    `  Eligible candidates: ${counts.eligibleCandidates}`,
    `  Excluded terminal: ${counts.excludedTerminal}`,
    `  Excluded unsupported kind: ${counts.excludedUnsupportedKind}`,
    `  Excluded malformed metadata: ${counts.excludedMalformedMetadata}`,
    `  Excluded missing or invalid absent proof: ${counts.excludedMissingOrInvalidAbsentProof}`,
    `  Excluded stale canonical: ${counts.excludedStaleCanonical}`,
  ];
}

/**
 * Format the plan output for display.
 */
export function formatPlanOutput(plan: OwnershipSavePlan): string {
  const lines: string[] = [];
  lines.push(`Ownership save plan for session ${plan.sessionId}`);
  lines.push(`Built at: ${plan.builtAt}`);
  lines.push('');

  if (plan.candidates.length === 0) {
    lines.push('No eligible candidates.');
  } else {
    lines.push(`Candidates (${plan.candidates.length}):`);
    plan.candidates.forEach((c, i) => {
      lines.push(`  ${formatCandidateLine(c, i + 1)}`);
    });
  }

  lines.push('');
  lines.push('Counts:');
  lines.push(...formatCountsLines(plan.counts));

  return lines.join('\n');
}

/**
 * Format a ConfirmedRecord for display.
 */
export function formatConfirmedLine(r: ConfirmedRecord): string {
  return [
    `[${r.proposalId}]`,
    `batch=${r.confirmationBatchId}`,
    `platform=${r.plannedPlatform ?? '<none>'}`,
    `ownership=${r.plannedOwnershipType ?? '<none>'}`,
    `slug=${r.plannedSlug ?? '<none>'}`,
    `checked-at=${r.plannedAbsentCheckedAt ?? '<none>'}`,
  ].join(' | ');
}

/**
 * Format the confirmation result for display.
 */
export function formatConfirmResult(result: ApplyResult): string {
  const lines: string[] = [];

  if (result.confirmed.length > 0) {
    lines.push('Confirmed:');
    for (const r of result.confirmed) {
      lines.push(`  ${formatConfirmedLine(r)}`);
    }
  }

  if (result.alreadyConfirmed.length > 0) {
    lines.push('Already confirmed (idempotent):');
    for (const pid of result.alreadyConfirmed) {
      lines.push(`  [${pid}]`);
    }
  }

  if (result.rejected.length > 0) {
    lines.push('Rejected:');
    for (const r of result.rejected) {
      lines.push(`  [${r.proposalId}] reason=${r.reason}`);
    }
  }

  if (
    result.confirmed.length === 0 &&
    result.alreadyConfirmed.length === 0 &&
    result.rejected.length === 0
  ) {
    lines.push('No proposals processed.');
  }

  return lines.join('\n');
}

export default null;
