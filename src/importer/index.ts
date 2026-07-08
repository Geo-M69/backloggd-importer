/**
 * Importer module — state machine for tracking approved proposals
 * through the import pipeline.
 *
 * Phase 5A covers schema, seeding, transitions, selection, reconciliation,
 * and counter recalculation.  Browser save and Backloggd comparison are
 * added in Phases 5B and 5C.
 */

export {
  getItem,
  getItemsBySession,
  seedApprovedManifest,
  selectNextItem,
  reconcileImportingItems,
  reconcileItem,
  transitionItem,
  recalculateSessionCounters,
  getItemCounts,
  resetFailedForRetry,
  resetFailedItemForRetry,
  validateManifestVersion,
  validateManifestAgainstDb,
} from './import-items.js';

export type {
  ImportItemStatus,
  ImportItem,
  SeedResult,
  SelectOptions,
  ItemCounts,
  ReconciliationProof,
} from './import-items.js';

export { IllegalTransitionError, ManifestDriftError } from './import-items.js';

export { runOwnershipComparison } from './ownership-comparison-runner.js';

export type {
  OwnershipComparisonRunnerResult,
  OwnershipComparisonRunnerOptions,
} from './ownership-comparison-runner.js';

export { buildOwnershipSavePlan } from './ownership-save-plan.js';

export type {
  OwnershipSavePlan,
  SavePlanCandidate,
  SavePlanCounts,
  BuildSavePlanOptions,
  ParsedOwnershipPayload,
  ParsedAbsentProof,
} from './ownership-save-plan.js';

export {
  buildOwnershipConfirmationPrompt,
  applyOwnershipConfirmationSelection,
} from './ownership-save-confirmation.js';

export type {
  ConfirmationPrompt,
  ConfirmationPromptItem,
  SelectionInput,
  ApplyOptions,
  ApplyResult,
  ConfirmedRecord,
} from './ownership-save-confirmation.js';

export {
  runConfirmedOwnershipStaging,
  revalidateConfirmation,
} from './ownership-staging-executor.js';

export type {
  OwnershipStagingExecutorOptions,
  StagingResult,
  StagingResultStatus,
  ConfirmationRow,
} from './ownership-staging-executor.js';
