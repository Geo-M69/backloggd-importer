import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadManifest, ManifestValidationError } from '../../src/backloggd/manifest-loader.js';
import type { ImportManifest } from '../../src/review/manifest.js';

function makeValidManifest(): ImportManifest {
  return {
    manifestVersion: '1.0.0',
    generatedAt: new Date().toISOString(),
    sessionId: 'test-session-123',
    policy: null,
    summary: {
      totalApproved: 1,
      ownershipProposals: 1,
      statusProposals: 0,
      playlogProposals: 0,
    },
    items: [
      {
        steamAppId: 730,
        steamTitle: 'CS2',
        igdbId: 12345,
        igdbName: 'Counter-Strike 2',
        backloggdSlug: 'counter-strike-2',
        backloggdUrl: 'https://www.backloggd.com/games/counter-strike-2/',
        matchConfidence: 'exact',
        approvedProposals: [
          {
            kind: 'ownership',
            payload: { platform: 'steam', ownershipType: 'digital' },
          },
        ],
      },
    ],
  };
}

describe('manifest-loader', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'backloggd-manifest-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('loads a valid manifest', async () => {
    const manifest = makeValidManifest();
    const path = join(tempDir, 'manifest.json');
    await writeFile(path, JSON.stringify(manifest), 'utf-8');

    const result = await loadManifest(path);
    expect(result.sessionId).toBe('test-session-123');
    expect(result.items).toHaveLength(1);
    expect(result.items[0].steamAppId).toBe(730);
  });

  it('throws ManifestValidationError for missing file', async () => {
    await expect(loadManifest(join(tempDir, 'missing.json'))).rejects.toThrow(
      ManifestValidationError,
    );
  });

  it('throws ManifestValidationError for invalid JSON', async () => {
    const path = join(tempDir, 'bad.json');
    await writeFile(path, 'not json', 'utf-8');
    await expect(loadManifest(path)).rejects.toThrow(ManifestValidationError);
  });

  it('throws ManifestValidationError for missing required fields', async () => {
    const path = join(tempDir, 'incomplete.json');
    await writeFile(path, JSON.stringify({ manifestVersion: '1.0.0' }), 'utf-8');
    await expect(loadManifest(path)).rejects.toThrow(ManifestValidationError);
  });

  it('throws ManifestValidationError for invalid item structure', async () => {
    const manifest = makeValidManifest();
    manifest.items[0].approvedProposals = [
      { kind: 'ownership', payload: 'not-an-object' as unknown as Record<string, unknown> },
    ];
    const path = join(tempDir, 'bad-payload.json');
    await writeFile(path, JSON.stringify(manifest), 'utf-8');
    await expect(loadManifest(path)).rejects.toThrow(ManifestValidationError);
  });
});
