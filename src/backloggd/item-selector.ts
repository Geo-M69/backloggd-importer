/**
 * Deterministic selection of representative approved items for
 * Milestone 4 Backloggd interaction proof of concept.
 */

import type { ImportManifest, ManifestItem } from '../review/manifest.js';

export interface SelectionOptions {
  limit?: number;
  steamAppIds?: number[];
}

export interface SelectedItem {
  steamAppId: number;
  steamTitle: string;
  backloggdUrl: string;
  backloggdSlug: string;
  matchConfidence: string;
  ownershipPayload: Record<string, unknown>;
}

/**
 * Filter manifest items to those eligible for Milestone 4 POC:
 * - have a Backloggd URL
 * - have an approved ownership proposal with Steam platform and digital ownership
 */
function isEligible(item: ManifestItem): boolean {
  if (!item.backloggdUrl) return false;

  const ownership = item.approvedProposals.find((p) => p.kind === 'ownership');
  if (!ownership || !ownership.payload) return false;

  const payload = ownership.payload;
  if (typeof payload.platform !== 'string' || payload.platform !== 'steam') return false;
  if (typeof payload.ownershipType !== 'string' || payload.ownershipType !== 'digital')
    return false;

  return true;
}

/**
 * Select representative items deterministically.
 *
 * 1. Filter to eligible items
 * 2. Apply steamAppId filter when provided
 * 3. Prefer exact confidence
 * 4. Sort by steamAppId ascending
 * 5. Take limit
 */
export function selectItems(
  manifest: ImportManifest,
  options: SelectionOptions = {},
): SelectedItem[] {
  const limit = options.limit ?? 1;
  const appIdFilter = options.steamAppIds ?? [];

  let eligible = manifest.items.filter(isEligible);

  if (appIdFilter.length > 0) {
    const allowed = new Set(appIdFilter);
    eligible = eligible.filter((i) => allowed.has(i.steamAppId));
  }

  // Prefer exact confidence by sorting exact first, then by appId
  eligible.sort((a, b) => {
    const aExact = a.matchConfidence === 'exact' ? 0 : 1;
    const bExact = b.matchConfidence === 'exact' ? 0 : 1;
    if (aExact !== bExact) return aExact - bExact;
    return a.steamAppId - b.steamAppId;
  });

  const selected = eligible.slice(0, limit);

  return selected.map((item) => {
    const ownership = item.approvedProposals.find((p) => p.kind === 'ownership');
    // isEligible guarantees these are non-null; cast safely after guard
    return {
      steamAppId: item.steamAppId,
      steamTitle: item.steamTitle,
      backloggdUrl: item.backloggdUrl as string,
      backloggdSlug: item.backloggdSlug as string,
      matchConfidence: item.matchConfidence,
      ownershipPayload: (ownership?.payload ?? {}) as Record<string, unknown>,
    };
  });
}
