/**
 * Executable regression tests for the ownership-compare CLI (Phase 5D Slice 3).
 *
 * These tests use dependency injection to provide fake implementations and
 * verify real executable behaviour: opening the database, launching the
 * browser, invoking the comparison runner, and returning the correct exit
 * code — without source-string heuristics.
 *
 * Static safety tests are preserved in a separate block so both layers of
 * coverage exist.
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Database } from 'better-sqlite3';
import type { BrowserContext, Page } from 'playwright';
import type { PocSessionOptions } from '../../src/backloggd/browser.js';
import type {
  OwnershipCompareCommandOptions,
  OwnershipCompareResult,
} from '../../src/importer/ownership-compare-command.js';
import type { ImportDbResolution } from '../../src/cli/import-db.js';
import type { OwnershipCompareCliDeps } from '../../src/cli/ownership-compare.js';
import { runOwnershipCompareCli } from '../../src/cli/ownership-compare.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CLI_SOURCE_PATH = resolve('src/cli/ownership-compare.ts');
const SOURCE = readFileSync(CLI_SOURCE_PATH, 'utf-8');

// ---------------------------------------------------------------------------
// Helper — create fake dependencies
// ---------------------------------------------------------------------------

function createMockDb(): Database {
  return {} as Database;
}

function createMockPage(): Page {
  return {} as Page;
}

function createMockContext(page: Page): BrowserContext {
  return {
    newPage: vi.fn().mockResolvedValue(page),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as BrowserContext;
}

interface FakeDeps {
  deps: OwnershipCompareCliDeps;
  /** Mock call trackers — each mirrors the matching deps property. */
  calls: {
    openDatabase: ReturnType<typeof vi.fn>;
    closeDatabase: ReturnType<typeof vi.fn>;
    launchSession: ReturnType<typeof vi.fn>;
    runOwnershipCompareCommand: ReturnType<typeof vi.fn>;
    resolveImportDbPath: ReturnType<typeof vi.fn>;
    countApprovedOwnershipItems: ReturnType<typeof vi.fn>;
    hasUnsafeComparisonOutcomes: ReturnType<typeof vi.fn>;
    formatCompareResult: ReturnType<typeof vi.fn>;
    consoleLog: ReturnType<typeof vi.fn>;
    consoleError: ReturnType<typeof vi.fn>;
  };
  mockDb: Database;
  mockContext: BrowserContext;
  mockPage: Page;
}

function createFakeDeps(): FakeDeps {
  const mockPage = createMockPage();
  const mockContext = createMockContext(mockPage);
  const mockDb = createMockDb();

  const openDatabase = vi.fn<(dbPath: string) => Database>().mockReturnValue(mockDb);
  const closeDatabase = vi.fn<() => void>();
  const launchSession = vi
    .fn<(options: PocSessionOptions) => Promise<BrowserContext>>()
    .mockResolvedValue(mockContext);
  const runOwnershipCompareCommand = vi
    .fn<(options: OwnershipCompareCommandOptions) => Promise<OwnershipCompareResult>>()
    .mockResolvedValue({
      processed: 0,
      alreadyPresent: 0,
      changeNeeded: 0,
      conflict: 0,
      unknown: 0,
      leftImporting: 0,
      malformed: 0,
      unsupportedKind: 0,
    });
  const resolveImportDbPath = vi
    .fn<(env: NodeJS.ProcessEnv) => ImportDbResolution>()
    .mockReturnValue({ mode: 'fixture', dbPath: ':memory:' });
  const countApprovedOwnershipItems = vi
    .fn<(db: Database, sessionId: string) => number>()
    .mockReturnValue(0);
  const hasUnsafeComparisonOutcomes = vi
    .fn<(result: OwnershipCompareResult) => boolean>()
    .mockReturnValue(false);
  const formatCompareResult = vi
    .fn<(result: OwnershipCompareResult) => string>()
    .mockReturnValue('');
  const consoleLog = vi.fn<(message: string) => void>();
  const consoleError = vi.fn<(message: string) => void>();

  const deps: OwnershipCompareCliDeps = {
    openDatabase,
    closeDatabase,
    launchSession,
    runOwnershipCompareCommand,
    resolveImportDbPath,
    countApprovedOwnershipItems,
    hasUnsafeComparisonOutcomes,
    formatCompareResult,
    consoleLog,
    consoleError,
  };

  return {
    deps,
    calls: {
      openDatabase,
      closeDatabase,
      launchSession,
      runOwnershipCompareCommand,
      resolveImportDbPath,
      countApprovedOwnershipItems,
      hasUnsafeComparisonOutcomes,
      formatCompareResult,
      consoleLog,
      consoleError,
    },
    mockDb,
    mockContext,
    mockPage,
  };
}

// ---------------------------------------------------------------------------
// Executable CLI tests
// ---------------------------------------------------------------------------

describe('ownership-compare CLI — executable behaviour', () => {
  // ===================================================================
  //  1-4. Missing --session
  // ===================================================================

  it('returns nonzero when --session flag is missing', async () => {
    const { deps } = createFakeDeps();
    const exitCode = await runOwnershipCompareCli([], deps);
    expect(exitCode).toBe(1);
  });

  it('does not call openDatabase when --session is missing', async () => {
    const { deps, calls } = createFakeDeps();
    await runOwnershipCompareCli([], deps);
    expect(calls.openDatabase).not.toHaveBeenCalled();
  });

  it('does not call launchSession when --session is missing', async () => {
    const { deps, calls } = createFakeDeps();
    await runOwnershipCompareCli([], deps);
    expect(calls.launchSession).not.toHaveBeenCalled();
  });

  it('does not call runOwnershipCompareCommand when --session is missing', async () => {
    const { deps, calls } = createFakeDeps();
    await runOwnershipCompareCli([], deps);
    expect(calls.runOwnershipCompareCommand).not.toHaveBeenCalled();
  });

  // ===================================================================
  //  --help / -h returns 0 with no side effects
  // ===================================================================

  it('returns 0 when --help flag is passed', async () => {
    const { deps } = createFakeDeps();
    const exitCode = await runOwnershipCompareCli(['--help'], deps);
    expect(exitCode).toBe(0);
  });

  it('returns 0 when -h flag is passed', async () => {
    const { deps } = createFakeDeps();
    const exitCode = await runOwnershipCompareCli(['-h'], deps);
    expect(exitCode).toBe(0);
  });

  it('does not call resolveImportDbPath when --help is passed', async () => {
    const { deps, calls } = createFakeDeps();
    await runOwnershipCompareCli(['--help'], deps);
    expect(calls.resolveImportDbPath).not.toHaveBeenCalled();
  });

  it('does not call openDatabase when --help is passed', async () => {
    const { deps, calls } = createFakeDeps();
    await runOwnershipCompareCli(['--help'], deps);
    expect(calls.openDatabase).not.toHaveBeenCalled();
  });

  it('does not call launchSession when --help is passed', async () => {
    const { deps, calls } = createFakeDeps();
    await runOwnershipCompareCli(['--help'], deps);
    expect(calls.launchSession).not.toHaveBeenCalled();
  });

  it('does not call runOwnershipCompareCommand when --help is passed', async () => {
    const { deps, calls } = createFakeDeps();
    await runOwnershipCompareCli(['--help'], deps);
    expect(calls.runOwnershipCompareCommand).not.toHaveBeenCalled();
  });

  it('emits usage text via consoleLog when --help is passed', async () => {
    const { deps, calls } = createFakeDeps();
    await runOwnershipCompareCli(['--help'], deps);
    expect(calls.consoleLog).toHaveBeenCalledWith(
      expect.stringContaining('Usage: npm run ownership:compare'),
    );
  });

  // ===================================================================
  //  5-8. Whitespace-only --session
  // ===================================================================

  it('returns nonzero when --session value is whitespace only', async () => {
    const { deps } = createFakeDeps();
    const exitCode = await runOwnershipCompareCli(['--session', '   '], deps);
    expect(exitCode).toBe(1);
  });

  it('does not call openDatabase when --session is whitespace only', async () => {
    const { deps, calls } = createFakeDeps();
    await runOwnershipCompareCli(['--session', '   '], deps);
    expect(calls.openDatabase).not.toHaveBeenCalled();
  });

  it('does not call launchSession when --session is whitespace only', async () => {
    const { deps, calls } = createFakeDeps();
    await runOwnershipCompareCli(['--session', '   '], deps);
    expect(calls.launchSession).not.toHaveBeenCalled();
  });

  it('does not call runOwnershipCompareCommand when --session is whitespace only', async () => {
    const { deps, calls } = createFakeDeps();
    await runOwnershipCompareCli(['--session', '   '], deps);
    expect(calls.runOwnershipCompareCommand).not.toHaveBeenCalled();
  });

  // ===================================================================
  //  9-10. No-work result
  // ===================================================================

  it('returns 0 when approved ownership count is zero (no work)', async () => {
    const { deps } = createFakeDeps();
    // countApprovedOwnershipItems already returns 0 by default
    const exitCode = await runOwnershipCompareCli(['--session', 'test-session'], deps);
    expect(exitCode).toBe(0);
  });

  it('does not call launchSession when approved ownership count is zero', async () => {
    const { deps, calls } = createFakeDeps();
    await runOwnershipCompareCli(['--session', 'test-session'], deps);
    expect(calls.launchSession).not.toHaveBeenCalled();
  });

  // ===================================================================
  //  11. Conflict result returns nonzero
  // ===================================================================

  it('returns nonzero when comparison reports conflict', async () => {
    const { deps, calls } = createFakeDeps();
    calls.countApprovedOwnershipItems.mockReturnValue(1);
    calls.runOwnershipCompareCommand.mockResolvedValue({
      processed: 1,
      alreadyPresent: 0,
      changeNeeded: 0,
      conflict: 1,
      unknown: 0,
      leftImporting: 0,
      malformed: 0,
      unsupportedKind: 0,
    });
    const { hasUnsafeComparisonOutcomes: realHasUnsafe } =
      await import('../../src/importer/ownership-compare-command.js');
    deps.hasUnsafeComparisonOutcomes = realHasUnsafe;

    const exitCode = await runOwnershipCompareCli(['--session', 'test-session'], deps);
    expect(exitCode).toBe(1);
  });

  // ===================================================================
  //  12. Unknown result returns nonzero
  // ===================================================================

  it('returns nonzero when comparison reports unknown', async () => {
    const { deps, calls } = createFakeDeps();
    calls.countApprovedOwnershipItems.mockReturnValue(1);
    calls.runOwnershipCompareCommand.mockResolvedValue({
      processed: 1,
      alreadyPresent: 0,
      changeNeeded: 0,
      conflict: 0,
      unknown: 1,
      leftImporting: 0,
      malformed: 0,
      unsupportedKind: 0,
    });
    const { hasUnsafeComparisonOutcomes: realHasUnsafe } =
      await import('../../src/importer/ownership-compare-command.js');
    deps.hasUnsafeComparisonOutcomes = realHasUnsafe;

    const exitCode = await runOwnershipCompareCli(['--session', 'test-session'], deps);
    expect(exitCode).toBe(1);
  });

  // ===================================================================
  //  13. Left-importing / browser-failure result returns nonzero
  // ===================================================================

  it('returns nonzero when comparison reports leftImporting', async () => {
    const { deps, calls } = createFakeDeps();
    calls.countApprovedOwnershipItems.mockReturnValue(1);
    calls.runOwnershipCompareCommand.mockResolvedValue({
      processed: 0,
      alreadyPresent: 0,
      changeNeeded: 0,
      conflict: 0,
      unknown: 0,
      leftImporting: 1,
      malformed: 0,
      unsupportedKind: 0,
    });
    const { hasUnsafeComparisonOutcomes: realHasUnsafe } =
      await import('../../src/importer/ownership-compare-command.js');
    deps.hasUnsafeComparisonOutcomes = realHasUnsafe;

    const exitCode = await runOwnershipCompareCli(['--session', 'test-session'], deps);
    expect(exitCode).toBe(1);
  });

  // ===================================================================
  //  14. Malformed result returns nonzero
  // ===================================================================

  it('returns nonzero when comparison reports malformed', async () => {
    const { deps, calls } = createFakeDeps();
    calls.countApprovedOwnershipItems.mockReturnValue(1);
    calls.runOwnershipCompareCommand.mockResolvedValue({
      processed: 0,
      alreadyPresent: 0,
      changeNeeded: 0,
      conflict: 0,
      unknown: 0,
      leftImporting: 0,
      malformed: 1,
      unsupportedKind: 0,
    });
    const { hasUnsafeComparisonOutcomes: realHasUnsafe } =
      await import('../../src/importer/ownership-compare-command.js');
    deps.hasUnsafeComparisonOutcomes = realHasUnsafe;

    const exitCode = await runOwnershipCompareCli(['--session', 'test-session'], deps);
    expect(exitCode).toBe(1);
  });

  // ===================================================================
  //  15. Clean already-present result returns 0
  // ===================================================================

  it('returns 0 when all items are already present', async () => {
    const { deps, calls } = createFakeDeps();
    calls.countApprovedOwnershipItems.mockReturnValue(1);
    calls.runOwnershipCompareCommand.mockResolvedValue({
      processed: 1,
      alreadyPresent: 1,
      changeNeeded: 0,
      conflict: 0,
      unknown: 0,
      leftImporting: 0,
      malformed: 0,
      unsupportedKind: 0,
    });
    const { hasUnsafeComparisonOutcomes: realHasUnsafe } =
      await import('../../src/importer/ownership-compare-command.js');
    deps.hasUnsafeComparisonOutcomes = realHasUnsafe;

    const exitCode = await runOwnershipCompareCli(['--session', 'test-session'], deps);
    expect(exitCode).toBe(0);
  });

  // ===================================================================
  //  16. Clean change-needed result returns 0
  // ===================================================================

  it('returns 0 when all items report change-needed', async () => {
    const { deps, calls } = createFakeDeps();
    calls.countApprovedOwnershipItems.mockReturnValue(1);
    calls.runOwnershipCompareCommand.mockResolvedValue({
      processed: 1,
      alreadyPresent: 0,
      changeNeeded: 1,
      conflict: 0,
      unknown: 0,
      leftImporting: 0,
      malformed: 0,
      unsupportedKind: 0,
    });
    const { hasUnsafeComparisonOutcomes: realHasUnsafe } =
      await import('../../src/importer/ownership-compare-command.js');
    deps.hasUnsafeComparisonOutcomes = realHasUnsafe;

    const exitCode = await runOwnershipCompareCli(['--session', 'test-session'], deps);
    expect(exitCode).toBe(0);
  });

  // ===================================================================
  //  17. Unsupported-kind-only result returns 0
  // ===================================================================

  it('returns 0 when only unsupported-kind items are present', async () => {
    const { deps, calls } = createFakeDeps();
    calls.countApprovedOwnershipItems.mockReturnValue(1);
    calls.runOwnershipCompareCommand.mockResolvedValue({
      processed: 0,
      alreadyPresent: 0,
      changeNeeded: 0,
      conflict: 0,
      unknown: 0,
      leftImporting: 0,
      malformed: 0,
      unsupportedKind: 3,
    });
    const { hasUnsafeComparisonOutcomes: realHasUnsafe } =
      await import('../../src/importer/ownership-compare-command.js');
    deps.hasUnsafeComparisonOutcomes = realHasUnsafe;

    const exitCode = await runOwnershipCompareCli(['--session', 'test-session'], deps);
    expect(exitCode).toBe(0);
  });

  // ===================================================================
  //  21-23. --max-items validation
  // ===================================================================

  it('returns nonzero when --max-items value is not a number', async () => {
    const { deps } = createFakeDeps();
    const exitCode = await runOwnershipCompareCli(
      ['--session', 'test-session', '--max-items', 'abc'],
      deps,
    );
    expect(exitCode).toBe(1);
  });

  it('returns nonzero when --max-items value is zero', async () => {
    const { deps } = createFakeDeps();
    const exitCode = await runOwnershipCompareCli(
      ['--session', 'test-session', '--max-items', '0'],
      deps,
    );
    expect(exitCode).toBe(1);
  });

  it('returns nonzero when --max-items value is negative', async () => {
    const { deps } = createFakeDeps();
    const exitCode = await runOwnershipCompareCli(
      ['--session', 'test-session', '--max-items', '-5'],
      deps,
    );
    expect(exitCode).toBe(1);
  });

  it('does not call launchSession when --max-items is invalid', async () => {
    const { deps, calls } = createFakeDeps();
    await runOwnershipCompareCli(['--session', 'test-session', '--max-items', 'abc'], deps);
    expect(calls.launchSession).not.toHaveBeenCalled();
  });

  it('does not call runOwnershipCompareCommand when --max-items is invalid', async () => {
    const { deps, calls } = createFakeDeps();
    await runOwnershipCompareCli(['--session', 'test-session', '--max-items', 'abc'], deps);
    expect(calls.runOwnershipCompareCommand).not.toHaveBeenCalled();
  });

  // --- Additional --max-items strict-parsing rejections ---

  it('returns nonzero when --max-items value is 1abc', async () => {
    const { deps } = createFakeDeps();
    const exitCode = await runOwnershipCompareCli(
      ['--session', 'test-session', '--max-items', '1abc'],
      deps,
    );
    expect(exitCode).toBe(1);
  });

  it('returns nonzero when --max-items value is 1.5', async () => {
    const { deps } = createFakeDeps();
    const exitCode = await runOwnershipCompareCli(
      ['--session', 'test-session', '--max-items', '1.5'],
      deps,
    );
    expect(exitCode).toBe(1);
  });

  it('returns nonzero when --max-items value is +1', async () => {
    const { deps } = createFakeDeps();
    const exitCode = await runOwnershipCompareCli(
      ['--session', 'test-session', '--max-items', '+1'],
      deps,
    );
    expect(exitCode).toBe(1);
  });

  it('returns nonzero when --max-items value is -1', async () => {
    const { deps } = createFakeDeps();
    const exitCode = await runOwnershipCompareCli(
      ['--session', 'test-session', '--max-items', '-1'],
      deps,
    );
    expect(exitCode).toBe(1);
  });

  it('returns nonzero when --max-items value is blank', async () => {
    const { deps } = createFakeDeps();
    const exitCode = await runOwnershipCompareCli(
      ['--session', 'test-session', '--max-items', ''],
      deps,
    );
    expect(exitCode).toBe(1);
  });

  it('returns nonzero when --max-items flag has no value', async () => {
    const { deps } = createFakeDeps();
    const exitCode = await runOwnershipCompareCli(
      ['--session', 'test-session', '--max-items'],
      deps,
    );
    expect(exitCode).toBe(1);
  });

  it('does not call resolveImportDbPath when --max-items value is 1abc', async () => {
    const { deps, calls } = createFakeDeps();
    await runOwnershipCompareCli(['--session', 'test-session', '--max-items', '1abc'], deps);
    expect(calls.resolveImportDbPath).not.toHaveBeenCalled();
  });

  it('does not call openDatabase when --max-items value is 1abc', async () => {
    const { deps, calls } = createFakeDeps();
    await runOwnershipCompareCli(['--session', 'test-session', '--max-items', '1abc'], deps);
    expect(calls.openDatabase).not.toHaveBeenCalled();
  });

  // ===================================================================
  //  24-26. --delay-ms validation
  // ===================================================================

  it('returns nonzero when --delay-ms value is not a number', async () => {
    const { deps } = createFakeDeps();
    const exitCode = await runOwnershipCompareCli(
      ['--session', 'test-session', '--delay-ms', 'abc'],
      deps,
    );
    expect(exitCode).toBe(1);
  });

  it('returns nonzero when --delay-ms value is negative', async () => {
    const { deps } = createFakeDeps();
    const exitCode = await runOwnershipCompareCli(
      ['--session', 'test-session', '--delay-ms', '-1'],
      deps,
    );
    expect(exitCode).toBe(1);
  });

  it('does not call launchSession when --delay-ms is invalid', async () => {
    const { deps, calls } = createFakeDeps();
    await runOwnershipCompareCli(['--session', 'test-session', '--delay-ms', 'abc'], deps);
    expect(calls.launchSession).not.toHaveBeenCalled();
  });

  it('does not call runOwnershipCompareCommand when --delay-ms is invalid', async () => {
    const { deps, calls } = createFakeDeps();
    await runOwnershipCompareCli(['--session', 'test-session', '--delay-ms', 'abc'], deps);
    expect(calls.runOwnershipCompareCommand).not.toHaveBeenCalled();
  });

  // --- Additional --delay-ms strict-parsing rejections ---

  it('returns nonzero when --delay-ms value is 250ms', async () => {
    const { deps } = createFakeDeps();
    const exitCode = await runOwnershipCompareCli(
      ['--session', 'test-session', '--delay-ms', '250ms'],
      deps,
    );
    expect(exitCode).toBe(1);
  });

  it('returns nonzero when --delay-ms value is 1.5', async () => {
    const { deps } = createFakeDeps();
    const exitCode = await runOwnershipCompareCli(
      ['--session', 'test-session', '--delay-ms', '1.5'],
      deps,
    );
    expect(exitCode).toBe(1);
  });

  it('returns nonzero when --delay-ms value is +1', async () => {
    const { deps } = createFakeDeps();
    const exitCode = await runOwnershipCompareCli(
      ['--session', 'test-session', '--delay-ms', '+1'],
      deps,
    );
    expect(exitCode).toBe(1);
  });

  it('returns nonzero when --delay-ms value is blank', async () => {
    const { deps } = createFakeDeps();
    const exitCode = await runOwnershipCompareCli(
      ['--session', 'test-session', '--delay-ms', ''],
      deps,
    );
    expect(exitCode).toBe(1);
  });

  it('returns nonzero when --delay-ms flag has no value', async () => {
    const { deps } = createFakeDeps();
    const exitCode = await runOwnershipCompareCli(
      ['--session', 'test-session', '--delay-ms'],
      deps,
    );
    expect(exitCode).toBe(1);
  });

  it('does not call resolveImportDbPath when --delay-ms value is 250ms', async () => {
    const { deps, calls } = createFakeDeps();
    await runOwnershipCompareCli(['--session', 'test-session', '--delay-ms', '250ms'], deps);
    expect(calls.resolveImportDbPath).not.toHaveBeenCalled();
  });

  it('does not call openDatabase when --delay-ms value is 250ms', async () => {
    const { deps, calls } = createFakeDeps();
    await runOwnershipCompareCli(['--session', 'test-session', '--delay-ms', '250ms'], deps);
    expect(calls.openDatabase).not.toHaveBeenCalled();
  });

  // ===================================================================
  //  27-28. Valid batch/pacing flags passed to command
  // ===================================================================

  it('passes --max-items to runOwnershipCompareCommand', async () => {
    const { deps, calls } = createFakeDeps();
    calls.countApprovedOwnershipItems.mockReturnValue(1);

    await runOwnershipCompareCli(['--session', 'test-session', '--max-items', '10'], deps);

    expect(calls.runOwnershipCompareCommand).toHaveBeenCalledWith(
      expect.objectContaining({ maxItems: 10 }),
    );
  });

  it('passes --delay-ms to runOwnershipCompareCommand', async () => {
    const { deps, calls } = createFakeDeps();
    calls.countApprovedOwnershipItems.mockReturnValue(1);

    await runOwnershipCompareCli(['--session', 'test-session', '--delay-ms', '1500'], deps);

    expect(calls.runOwnershipCompareCommand).toHaveBeenCalledWith(
      expect.objectContaining({ delayMs: 1500 }),
    );
  });

  it('passes --delay-ms 0 to runOwnershipCompareCommand', async () => {
    const { deps, calls } = createFakeDeps();
    calls.countApprovedOwnershipItems.mockReturnValue(1);

    await runOwnershipCompareCli(['--session', 'test-session', '--delay-ms', '0'], deps);

    expect(calls.runOwnershipCompareCommand).toHaveBeenCalledWith(
      expect.objectContaining({ delayMs: 0 }),
    );
  });

  // ===================================================================
  //  29. Help text documents new flags
  // ===================================================================

  it('help text mentions --max-items', async () => {
    const { deps, calls } = createFakeDeps();
    await runOwnershipCompareCli(['--help'], deps);
    expect(calls.consoleLog).toHaveBeenCalledWith(expect.stringContaining('--max-items'));
  });

  it('help text mentions --delay-ms', async () => {
    const { deps, calls } = createFakeDeps();
    await runOwnershipCompareCli(['--help'], deps);
    expect(calls.consoleLog).toHaveBeenCalledWith(expect.stringContaining('--delay-ms'));
  });

  // ===================================================================
  //  18. Approved-work path calls shared launchSession
  // ===================================================================

  it('calls launchSession when approved ownership items exist', async () => {
    const { deps, calls } = createFakeDeps();
    calls.countApprovedOwnershipItems.mockReturnValue(2);

    await runOwnershipCompareCli(['--session', 'test-session'], deps);

    expect(calls.launchSession).toHaveBeenCalledTimes(1);
    expect(calls.launchSession).toHaveBeenCalledWith(
      expect.objectContaining({
        profileDir: expect.any(String),
        headless: false,
      }),
    );
  });

  // ===================================================================
  //  19. Approved-work path passes page to runOwnershipCompareCommand
  // ===================================================================

  it('passes the shared page dependency to runOwnershipCompareCommand', async () => {
    const { deps, calls, mockPage } = createFakeDeps();
    calls.countApprovedOwnershipItems.mockReturnValue(1);

    await runOwnershipCompareCli(['--session', 'test-session'], deps);

    expect(calls.runOwnershipCompareCommand).toHaveBeenCalledTimes(1);
    expect(calls.runOwnershipCompareCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'test-session',
        page: mockPage,
      }),
    );
  });

  // ===================================================================
  //  20. Trimmed session ID is passed to DB/count/runner path
  // ===================================================================

  it('passes trimmed session ID to countApprovedOwnershipItems', async () => {
    const { deps, calls } = createFakeDeps();
    // countApprovedOwnershipItems returns 0, so the runner is not called
    await runOwnershipCompareCli(['--session', '  my-session  '], deps);
    expect(calls.countApprovedOwnershipItems).toHaveBeenCalledWith(expect.anything(), 'my-session');
  });

  it('passes trimmed session ID to runOwnershipCompareCommand', async () => {
    const { deps, calls } = createFakeDeps();
    calls.countApprovedOwnershipItems.mockReturnValue(1);

    await runOwnershipCompareCli(['--session', '  my-session  '], deps);

    expect(calls.runOwnershipCompareCommand).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'my-session' }),
    );
  });

  it('uses trimmed session ID for DB resolve and count path', async () => {
    const { deps, calls } = createFakeDeps();

    await runOwnershipCompareCli(['--session', '  my-session  '], deps);

    // resolveImportDbPath is called regardless of session validation
    expect(calls.resolveImportDbPath).toHaveBeenCalledTimes(1);
    // openDatabase is called with the resolved dbPath
    expect(calls.openDatabase).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Static safety tests (preserved — not relied upon alone for behaviour)
// ---------------------------------------------------------------------------

describe('ownership-compare CLI — static safety', () => {
  // Session trimming
  it('trims session ID after parsing', () => {
    expect(SOURCE).toContain('.trim()');
  });

  it('rejects whitespace-only session with error message', () => {
    expect(SOURCE).toContain('must be non-empty');
  });

  // Exit status pattern
  it('sets process.exitCode from return value in main wrapper', () => {
    expect(SOURCE).toContain('process.exitCode = exitCode');
  });

  // Shared browser launcher
  it('does not directly import chromium from playwright', () => {
    const importLines = SOURCE.split('\n').filter(
      (l) => l.includes('import') && l.includes('playwright'),
    );
    // Type-only imports are acceptable (they are erased at runtime)
    const valueImports = importLines.filter((l) => !l.includes('import type'));
    expect(valueImports).toHaveLength(0);
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

  // Final-save / staging / confirmation imports
  it('does not import runConfirmedOwnershipSave', () => {
    const lines = SOURCE.split('\n').filter(
      (l) => l.includes('import') && l.includes('runConfirmedOwnershipSave'),
    );
    expect(lines).toHaveLength(0);
  });

  it('does not import executeConfirmedOwnershipSaves', () => {
    const lines = SOURCE.split('\n').filter(
      (l) => l.includes('import') && l.includes('executeConfirmedOwnershipSaves'),
    );
    expect(lines).toHaveLength(0);
  });

  it('does not import applyOwnershipConfirmationSelection', () => {
    const lines = SOURCE.split('\n').filter(
      (l) => l.includes('import') && l.includes('applyOwnershipConfirmationSelection'),
    );
    expect(lines).toHaveLength(0);
  });

  it('does not import confirmExactProposals or confirmAllEligibleProposals', () => {
    const forbidden = ['confirmExactProposals', 'confirmAllEligibleProposals'];
    for (const term of forbidden) {
      const lines = SOURCE.split('\n').filter((l) => l.includes('import') && l.includes(term));
      expect(lines).toHaveLength(0);
    }
  });

  it('does not import runConfirmedOwnershipStaging or stageOwnershipInBrowser', () => {
    const forbidden = ['runConfirmedOwnershipStaging', 'stageOwnershipInBrowser'];
    for (const term of forbidden) {
      const lines = SOURCE.split('\n').filter((l) => l.includes('import') && l.includes(term));
      expect(lines).toHaveLength(0);
    }
  });

  it('does not import processItem, transitionItem, or reconcileItem', () => {
    const forbidden = ['processItem', 'transitionItem', 'reconcileItem'];
    for (const term of forbidden) {
      const lines = SOURCE.split('\n').filter((l) => l.includes('import') && l.includes(term));
      expect(lines).toHaveLength(0);
    }
  });

  // Selector / write-guard safety
  it('does not define final-save selector strings', () => {
    const selectorPatterns: RegExp[] = [
      /role=dialog/i,
      /select\[name="platform"\]/,
      /select\[name="ownership_type"\]/,
      /role=button.*name=/i,
      /getByRole.*button.*save/i,
    ];

    for (const pattern of selectorPatterns) {
      const nonImportLines = SOURCE.split('\n').filter(
        (l) => !l.includes('import') && !l.includes('export.*from'),
      );
      const nonImportText = nonImportLines.join('\n');
      expect(nonImportText).not.toMatch(pattern);
    }
  });

  it('does not define write-guard allowance logic', () => {
    const allowancePatterns: RegExp[] = [
      /installWriteGuard/,
      /enableSaveAllowance/,
      /disableSaveAllowance/,
      /wasSavePostSeen/,
      /writeGuard/,
    ];

    for (const pattern of allowancePatterns) {
      const nonImportLines = SOURCE.split('\n').filter(
        (l) => !l.includes('import') && !l.includes('export.*from'),
      );
      const nonImportText = nonImportLines.join('\n');
      expect(nonImportText).not.toMatch(pattern);
    }
  });
});
