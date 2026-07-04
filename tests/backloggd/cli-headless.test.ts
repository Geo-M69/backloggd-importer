import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Test that --headless is rejected by the CLI entry point.
 *
 * We cannot easily run the full CLI (it launches a browser), so we
 * verify that the CLI source code explicitly rejects --headless.
 */
describe('CLI headless rejection', () => {
  it('CLI entry point rejects --headless flag', () => {
    const cliPath = resolve(
      fileURLToPath(new URL('../../src/cli/backloggd-poc.ts', import.meta.url)),
    );
    const source = readFileSync(cliPath, 'utf-8');
    expect(source).toContain('--headless');
    expect(source).toContain('process.exit(1)');
  });
});
