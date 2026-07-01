/**
 * Review module — proposal generation, approval, manifest export, and
 * canonical payload builders.
 */

export { generateProposals } from './generator.js';
export type { GenerateResult, GenerateOptions } from './generator.js';

export { approveExactMatches } from './approver.js';
export type { ApproveResult } from './approver.js';

export { buildManifest } from './manifest.js';
export type {
  ImportManifest,
  ManifestSummary,
  ManifestItem,
  ManifestApprovedProposal,
} from './manifest.js';

export {
  ownershipDefaults,
  statusPayload,
  playlogPayload,
  canonicalMigrationPayload,
} from './payloads.js';
export type { OwnershipDefaults } from './payloads.js';
