/**
 * Load and validate an approved import manifest for Milestone 4.
 *
 * Reuses the existing ImportManifest type from the review module.
 */

import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { ImportManifest } from '../review/manifest.js';

const manifestApprovedProposalSchema = z.object({
  proposalId: z.string(),
  kind: z.string(),
  payload: z.record(z.unknown()).nullable(),
});

const manifestItemSchema = z.object({
  steamAppId: z.number(),
  steamTitle: z.string(),
  igdbId: z.number().nullable(),
  igdbName: z.string().nullable(),
  backloggdSlug: z.string().nullable(),
  backloggdUrl: z.string().nullable(),
  matchConfidence: z.string(),
  approvedProposals: z.array(manifestApprovedProposalSchema),
});

const manifestSummarySchema = z.object({
  totalApproved: z.number(),
  ownershipProposals: z.number(),
  statusProposals: z.number(),
  playlogProposals: z.number(),
});

const manifestSchema = z.object({
  manifestVersion: z.string(),
  generatedAt: z.string(),
  sessionId: z.string(),
  policy: z.record(z.unknown()).nullable(),
  summary: manifestSummarySchema,
  items: z.array(manifestItemSchema),
});

export class ManifestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManifestValidationError';
  }
}

/**
 * Load a manifest from a file path and validate its structure.
 */
export async function loadManifest(path: string): Promise<ImportManifest> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err) {
    throw new ManifestValidationError(
      `Cannot read manifest file: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ManifestValidationError('Manifest file is not valid JSON');
  }

  const result = manifestSchema.safeParse(parsed);
  if (!result.success) {
    throw new ManifestValidationError(
      `Manifest validation failed: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  }

  return result.data as ImportManifest;
}
