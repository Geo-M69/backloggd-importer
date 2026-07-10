/**
 * Static safety tests for the ownership-save CLI (Phase 5D Slice 1).
 *
 * These tests verify by source inspection that the CLI:
 *
 * - Uses the shared browser launcher (`launchSession`) instead of calling
 *   `chromium.launch` directly (Finding 3).
 * - Does not import `chromium` from `playwright` directly for browser
 *   creation.
 * - Trims session ID before validation (Finding 1).
 * - Has nonzero exit for failed results (Finding 2 via `process.exitCode`).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CLI_SOURCE_PATH = resolve('src/cli/ownership-save.ts');
const SOURCE = readFileSync(CLI_SOURCE_PATH, 'utf-8');

// ---------------------------------------------------------------------------
// Finding 1 — Whitespace session gate
// ---------------------------------------------------------------------------

describe('ownership-save CLI — session trimming (Finding 1)', () => {
  it('trims session ID after parsing', () => {
    // The line should do: const sessionId = (rawSessionId ?? '').trim();
    expect(SOURCE).toContain('.trim()');
  });

  it('rejects whitespace-only session with error message', () => {
    // Must mention "must be non-empty"
    expect(SOURCE).toContain('must be non-empty');
  });
});

// ---------------------------------------------------------------------------
// Finding 2 — Exit status
// ---------------------------------------------------------------------------

describe('ownership-save CLI — exit status (Finding 2)', () => {
  it('sets process.exitCode = 1 when results have failures', () => {
    expect(SOURCE).toContain('process.exitCode = 1');
  });

  it('computes hasFailures from printResults return value', () => {
    expect(SOURCE).toContain('const hasFailures = printResults(results)');
  });
});

// ---------------------------------------------------------------------------
// Finding 3 — Shared browser launcher
// ---------------------------------------------------------------------------

describe('ownership-save CLI — shared browser launcher (Finding 3)', () => {
  it('does not directly import chromium from playwright', () => {
    const importLines = SOURCE.split('\n').filter(
      (l) => l.includes('import') && l.includes('playwright'),
    );
    // No import should mention playwright at all now (launchSession is from backloggd/browser)
    expect(importLines).toHaveLength(0);
  });

  it('does not call chromium.launch directly', () => {
    expect(SOURCE).not.toContain('chromium.launch');
    expect(SOURCE).not.toContain('chromium');
  });

  it('imports launchSession from shared backloggd/browser module', () => {
    expect(SOURCE).toContain("import { launchSession } from '../backloggd/browser.js'");
  });

  it('calls launchSession for browser creation', () => {
    expect(SOURCE).toContain('launchSession({ profileDir, headless })');
  });
});
