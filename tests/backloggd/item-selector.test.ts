import { describe, it, expect } from 'vitest';
import { selectItems } from '../../src/backloggd/item-selector.js';
import type { ImportManifest } from '../../src/review/manifest.js';

function makeManifest(items: ImportManifest['items']): ImportManifest {
  return {
    manifestVersion: '1.0.0',
    generatedAt: new Date().toISOString(),
    sessionId: 'test-session',
    policy: null,
    summary: {
      totalApproved: items.length,
      ownershipProposals: items.filter((i) =>
        i.approvedProposals.some((p) => p.kind === 'ownership'),
      ).length,
      statusProposals: items.filter((i) => i.approvedProposals.some((p) => p.kind === 'status'))
        .length,
      playlogProposals: items.filter((i) => i.approvedProposals.some((p) => p.kind === 'playlog'))
        .length,
    },
    items,
  };
}

function makeItem(
  appId: number,
  confidence: string,
  overrides: Partial<ImportManifest['items'][number]> = {},
): ImportManifest['items'][number] {
  return {
    steamAppId: appId,
    steamTitle: `Game ${appId}`,
    igdbId: appId + 10000,
    igdbName: `Game ${appId} (IGDB)`,
    backloggdSlug: `game-${appId}`,
    backloggdUrl: `https://www.backloggd.com/games/game-${appId}/`,
    matchConfidence: confidence,
    approvedProposals: [
      {
        kind: 'ownership',
        payload: { platform: 'steam', ownershipType: 'digital' },
      },
    ],
    ...overrides,
  };
}

describe('item-selector', () => {
  it('selects only items with backloggdUrl and approved ownership', () => {
    const manifest = makeManifest([
      makeItem(730, 'exact'),
      { ...makeItem(440, 'exact'), backloggdUrl: null },
      {
        ...makeItem(570, 'exact'),
        approvedProposals: [{ kind: 'status', payload: { suggestion: 'played' } }],
      },
    ]);

    const selected = selectItems(manifest);
    expect(selected).toHaveLength(1);
    expect(selected[0].steamAppId).toBe(730);
  });

  it('filters by steam-app-id when provided', () => {
    const manifest = makeManifest([makeItem(730, 'exact'), makeItem(440, 'exact')]);
    const selected = selectItems(manifest, { steamAppIds: [440] });
    expect(selected).toHaveLength(1);
    expect(selected[0].steamAppId).toBe(440);
  });

  it('prefers exact confidence over probable', () => {
    const manifest = makeManifest([makeItem(440, 'probable'), makeItem(730, 'exact')]);
    const selected = selectItems(manifest, { limit: 1 });
    expect(selected[0].steamAppId).toBe(730);
  });

  it('sorts by steamAppId ascending after confidence', () => {
    const manifest = makeManifest([
      makeItem(730, 'exact'),
      makeItem(440, 'exact'),
      makeItem(570, 'exact'),
    ]);
    const selected = selectItems(manifest, { limit: 3 });
    expect(selected.map((s) => s.steamAppId)).toEqual([440, 570, 730]);
  });

  it('respects limit', () => {
    const manifest = makeManifest([makeItem(730, 'exact'), makeItem(440, 'exact')]);
    const selected = selectItems(manifest, { limit: 1 });
    expect(selected).toHaveLength(1);
  });

  it('returns empty array when no eligible items', () => {
    const manifest = makeManifest([{ ...makeItem(730, 'exact'), backloggdUrl: null }]);
    const selected = selectItems(manifest);
    expect(selected).toHaveLength(0);
  });

  it('requires digital ownership type', () => {
    const manifest = makeManifest([
      {
        ...makeItem(730, 'exact'),
        approvedProposals: [
          { kind: 'ownership', payload: { platform: 'steam', ownershipType: 'physical' } },
        ],
      },
    ]);
    const selected = selectItems(manifest);
    expect(selected).toHaveLength(0);
  });

  it('requires steam platform', () => {
    const manifest = makeManifest([
      {
        ...makeItem(730, 'exact'),
        approvedProposals: [
          { kind: 'ownership', payload: { platform: 'playstation', ownershipType: 'digital' } },
        ],
      },
    ]);
    const selected = selectItems(manifest);
    expect(selected).toHaveLength(0);
  });

  it('is deterministic for identical input', () => {
    const manifest = makeManifest([makeItem(730, 'exact'), makeItem(440, 'exact')]);
    const a = selectItems(manifest, { limit: 2 });
    const b = selectItems(manifest, { limit: 2 });
    expect(a).toEqual(b);
  });
});
