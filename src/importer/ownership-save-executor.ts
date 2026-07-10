/**
 * Ownership save executor — Phase 5C Slice 4.
 *
 * Takes confirmed and successfully staged ownership changes from Phase 5C
 * Slice 3 and executes the final Backloggd save action, then verifies the
 * result and updates local checkpoint state.
 *
 * ## Safety guarantees
 *
 * - Pre-browser revalidation against current DB state before any page work.
 * - Write guard is installed before any browser interaction.
 * - Staging (Phase 5C Slice 3) must return exactly `staged` before save.
 * - Save scope is tied to the verified/staged editor (Finding 3).
 * - Only one safe final save action is identified and clicked.
 * - Expected save request/response is observed before claiming success (Finding 2).
 * - No Delete, Remove, Full Editor, Create Log, Confirm, or unrelated Submit.
 * - No ambiguous or duplicate final actions.
 * - No save action outside the verified editor/dialog scope.
 * - Import item is marked `saved` only after post-save visible verification.
 * - Write-guard save allowance is narrowly scoped and closed after save.
 * - Local state transition is atomic (Finding 4).
 */

import type Database from 'better-sqlite3';
import type { Page, Locator } from 'playwright';
import {
  installWriteGuard,
  enableSaveAllowance,
  disableSaveAllowance,
  wasSavePostSeen,
} from '../backloggd/browser.js';
import { readVisibleBackloggdState } from '../backloggd/visible-state.js';
import { verifyGamePage } from '../backloggd/page-reader.js';
import { getItem, transitionItem } from './import-items.js';
import { revalidateConfirmation, stageOwnershipInBrowser } from './ownership-staging-executor.js';
import type { ConfirmationRow } from './ownership-staging-executor.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BACKLOGGD_GAME_BASE = 'https://backloggd.com/games/';

const NAV_TIMEOUT_MS = 5000;
const VERIFY_TIMEOUT_MS = 1000;
const POST_SAVE_VERIFY_TIMEOUT_MS = 1000;

/**
 * How long to wait for the save request/response to be observed after
 * clicking the save button.  For live Backloggd this covers the real
 * HTTP round-trip; for fixture tests the response may be synthetic.
 */
const SAVE_RESPONSE_TIMEOUT_MS = 5000;

/**
 * How long (ms from the Save click) to keep the observation window open and
 * the save allowance active so any late/additional matching POSTs scheduled
 * by the click handler chain (e.g. via setTimeout 75–250ms) are captured
 * by both the page-side fetch audit and Playwright request tracking.
 *
 * The executor MUST NOT declare success before this window has elapsed.
 * See Finding 1 (late extra matching request) and Finding 2 (cross-channel
 * request tracking).
 */
const LATE_DETECTION_WINDOW_MS = 1000;

/**
 * Allowlisted safe final-action accessible names (normalized lowercase,
 * single-spaced).  These are the ONLY save actions the executor may click.
 *
 * `Update` is intentionally NOT allowed for Phase 5C Slice 4: the workspace
 * has confirmed Save and Save changes as the verified final actions, and
 * any visible enabled Update control must be treated as forbidden for this
 * slice (Finding 1).
 */
const ALLOWED_SAVE_NAMES = new Set(['save', 'save changes']);

const ALLOWED_SAVE_NAME_PATTERNS = [/^save$/i, /^save changes$/i] as const;

/**
 * Forbidden terms that must NOT appear in the save action's text or
 * accessible name.  If any term matches, the action is rejected as unsafe.
 * `update` is also forbidden here as a defense-in-depth check, since the
 * allowlist no longer permits it as a Save name.
 */
const FORBIDDEN_SAVE_TERMS = [
  'delete',
  'remove',
  'full editor',
  'create log',
  'confirm',
  'submit',
  'update',
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Result status for a single confirmation save attempt.
 *
 * - `saved` — final save clicked, response/success observed, visible
 *   ownership verified, import item transitioned to saved.
 * - `stale` — DB revalidation failed before browser work.
 * - `stagingFailed` — staging did not return `staged`.
 * - `unsupported` — no unique safe final save action or unsupported editor.
 * - `blockedWrite` — unexpected write blocked by guard.
 * - `saveFailed` — click/response/save signal failed.
 * - `verificationFailed` — post-save visible read did not prove ownership.
 * - `browserFailed` — page disappeared/navigation failed.
 */
export type SaveResultStatus =
  | 'saved'
  | 'stale'
  | 'stagingFailed'
  | 'unsupported'
  | 'blockedWrite'
  | 'saveFailed'
  | 'verificationFailed'
  | 'browserFailed';

/**
 * Result for a single confirmation save attempt.
 */
export interface SaveResult {
  /** Proposal ID of the confirmation row. */
  proposalId: string;
  /** Outcome of the save attempt. */
  status: SaveResultStatus;
  /** Batch ID from the confirmation row. */
  confirmationBatchId: string;
  /** Human-readable detail about the outcome. */
  detail?: string;
}

/**
 * Options for {@link runConfirmedOwnershipSave}.
 */
export interface OwnershipSaveExecutorOptions {
  /** Database instance. */
  db: Database.Database;
  /** Import session ID. */
  sessionId: string;
  /** Playwright page, navigable by the executor. */
  page: Page;
  /** Timeout passed to page operations. */
  timeout?: number;
  /**
   * Custom URL resolver for navigation.
   *
   * Default constructs `https://backloggd.com/games/{slug}/`.
   * Tests override this to point at fixture files.
   */
  resolvePageUrl?: (slug: string) => string;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface SaveActionCandidate {
  locator: Locator;
  accessibleName: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Default URL resolver.
 */
function defaultResolvePageUrl(slug: string): string {
  const encoded = encodeURIComponent(slug);
  return `${BACKLOGGD_GAME_BASE}${encoded}/`;
}

/**
 * Look up the game title from the games table.
 */
function lookUpGameTitle(db: Database.Database, steamAppId: number): string | null {
  const row = db.prepare('SELECT title FROM games WHERE app_id = ?').get(steamAppId) as
    { title: string } | undefined;
  return row?.title ?? null;
}

/**
 * Normalize an accessible name for comparison: lowercase, trim, collapse
 * internal whitespace.
 */
function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Check whether a normalized accessible name contains any forbidden term.
 */
function nameContainsForbiddenTerm(name: string): boolean {
  const normalized = normalizeName(name);
  return FORBIDDEN_SAVE_TERMS.some((term) => {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${escaped}\\b`).test(normalized);
  });
}

function isAllowedFinalSaveName(name: string): boolean {
  return ALLOWED_SAVE_NAMES.has(normalizeName(name));
}

function extractRootAccessibleName(snapshot: string, role: 'button' | 'link'): string | null {
  const firstLine = snapshot.split('\n', 1)[0]?.trim() ?? '';
  const match = firstLine.match(new RegExp(`^- ${role}(?: "((?:[^"\\\\]|\\\\.)*)")?(?::|$)`));
  if (!match) return null;
  if (match[1] === undefined) return '';

  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return match[1];
  }
}

async function resolvedAccessibleName(
  locator: Locator,
  role: 'button' | 'link',
): Promise<string | null> {
  const snapshot = await locator.ariaSnapshot({ depth: 0 }).catch(() => null);
  return snapshot === null ? null : extractRootAccessibleName(snapshot, role);
}

// ---------------------------------------------------------------------------
// Verified editor scope identification (Finding 3)
// ---------------------------------------------------------------------------

/**
 * Re-identify the visible editor/dialog that was staged, by requiring that
 * it contains both the planned Platform and Ownership selects with the
 * expected values selected.
 *
 * Returns a Playwright Locator scoped to the verified editor, or null if:
 * - No visible dialog matches the expected values.
 * - More than one visible dialog matches (ambiguous).
 */
async function findStagedEditorScope(
  page: Page,
  plannedPlatform: string,
  plannedOwnershipType: string,
): Promise<Locator | null> {
  const plannedPlatformLower = plannedPlatform.trim().toLowerCase();
  const plannedOwnershipLower = plannedOwnershipType.trim().toLowerCase();

  // Find all visible dialogs on the page
  const dialogs = page.locator('role=dialog');
  const dialogCount = await dialogs.count().catch(() => 0);

  const matchingDialogs: Locator[] = [];

  for (let i = 0; i < dialogCount; i++) {
    const dialog = dialogs.nth(i);
    if (!(await dialog.isVisible().catch(() => false))) continue;

    // Check for platform select with the expected value
    const platformSelect = dialog.locator('select[name="platform"]').first();
    const platformVisible = await platformSelect.isVisible().catch(() => false);
    if (!platformVisible) continue;

    const platformValue = await platformSelect.inputValue().catch(() => '');
    if (platformValue.trim().toLowerCase() !== plannedPlatformLower) continue;

    // Check for ownership select with the expected value
    const ownershipSelect = dialog.locator('select[name="ownership_type"]').first();
    const ownershipVisible = await ownershipSelect.isVisible().catch(() => false);
    if (!ownershipVisible) continue;

    const ownershipValue = await ownershipSelect.inputValue().catch(() => '');
    if (ownershipValue.trim().toLowerCase() !== plannedOwnershipLower) continue;

    matchingDialogs.push(dialog);
  }

  if (matchingDialogs.length !== 1) return null;

  return matchingDialogs[0];
}

// ---------------------------------------------------------------------------
// Safe final save action identification (Finding 3)
// ---------------------------------------------------------------------------

/**
 * Find exactly one safe final save action inside the verified editor scope.
 *
 * Rules:
 * - The action must be visible and enabled.
 * - The accessible name (normalized) must be one of the ALLOWED_SAVE_NAMES
 *   (currently `save` and `save changes` only — `update` is NOT permitted).
 * - The accessible name must NOT contain any FORBIDDEN_SAVE_TERMS.
 * - Exactly one matching action must exist. Zero or multiple → `unsupported`.
 * - The action must be inside the provided editor scope.
 *
 * @param editorScope The verified editor locator from findStagedEditorScope.
 * @returns The locator of the safe action, or null if no unique safe action.
 */
async function findSafeSaveButton(editorScope: Locator): Promise<SaveActionCandidate | null> {
  const candidates: SaveActionCandidate[] = [];

  for (const allowedNamePattern of ALLOWED_SAVE_NAME_PATTERNS) {
    // Search only exact allowed accessible names; string role-name matching is fuzzy.
    const buttons = editorScope.getByRole('button', { name: allowedNamePattern, disabled: false });
    const btnCount = await buttons.count().catch(() => 0);
    for (let i = 0; i < btnCount; i++) {
      const btn = buttons.nth(i);
      if (await btn.isVisible().catch(() => false)) {
        const name = await resolvedAccessibleName(btn, 'button');
        if (name !== null && isAllowedFinalSaveName(name) && !nameContainsForbiddenTerm(name)) {
          candidates.push({ locator: btn, accessibleName: name });
        }
      }
    }

    // Search only exact allowed accessible names; string role-name matching is fuzzy.
    const links = editorScope.getByRole('link', { name: allowedNamePattern, disabled: false });
    const linkCount = await links.count().catch(() => 0);
    for (let i = 0; i < linkCount; i++) {
      const link = links.nth(i);
      if (await link.isVisible().catch(() => false)) {
        const name = await resolvedAccessibleName(link, 'link');
        if (name !== null && isAllowedFinalSaveName(name) && !nameContainsForbiddenTerm(name)) {
          candidates.push({ locator: link, accessibleName: name });
        }
      }
    }
  }

  // Reject if zero or multiple candidates
  if (candidates.length !== 1) return null;

  const candidate = candidates[0];

  // Reject if the accessible name contains forbidden terms
  if (nameContainsForbiddenTerm(candidate.accessibleName)) return null;

  return candidate;
}

// ---------------------------------------------------------------------------
// Final save click with response proof (Finding 2)
// ---------------------------------------------------------------------------

/**
 * Save API path regex used both for response correlation and request
 * tracking.  Matches Backloggd's library save endpoint exactly:
 *   POST /api/library/ or POST /api/library/[numeric-id]
 * MUST NOT match the bare /api/library (no trailing slash) or prefix
 * substrings such as /api/library-malicious.
 */
const SAVE_API_REGEX = /^\/api\/library\/(?:\d+)?$/;

/**
 * Maximum difference (ms) between the verified Save click marker
 * (`performance.now()`) and a matching POST request's `performance.now()`
 * for that request to count as click-driven.  Generous enough to cover
 * normal CDP/scheduling jitter for `fetch()` initiated synchronously in
 * the Save click handler, but tight enough to reject unrelated delayed
 * POSTs that fire from setTimeout or other side-channels.
 */
const CLICK_DRIVEN_WINDOW_PERF_MS = 200;

/**
 * Result of a final save click attempt.
 */
interface ClickSaveResult {
  kind:
    | 'success'
    | 'blockedWrite'
    | 'noSaveRequest'
    | 'extraSaveRequest'
    | 'badResponseStatus'
    | 'error';
  blockedWrites: string[];
  responseStatus: number | null;
  /** Number of click-driven matching requests observed. */
  clickDrivenRequestCount: number;
  /**
   * Total number of matching Playwright requests observed during the
   * save window (Finding 2).  Includes all request channels (fetch,
   * XHR, sendBeacon, etc.).
   */
  playwrightRequestCount: number;
  /**
   * Total number of matching entries in the page-side fetch audit
   * during the save window (Finding 2).  Only tracks window.fetch.
   */
  fetchAuditMatchCount: number;
  error?: string;
}

/**
 * Whether a Playwright Request object targets Backloggd's library save API
 * path exactly with a POST method.  Used as the predicate for both request
 * tracking and `waitForResponse`.
 */
function isMatchingSaveRequest(request: { method: () => string; url: () => string }): boolean {
  if (request.method().toUpperCase() !== 'POST') return false;
  try {
    const parsed = new URL(request.url());
    const hostname = parsed.hostname.toLowerCase();
    if (hostname !== 'backloggd.com' && !hostname.endsWith('.backloggd.com')) {
      return false;
    }
    return SAVE_API_REGEX.test(parsed.pathname);
  } catch {
    return false;
  }
}

/**
 * Marker the page-side script exposes for the executor:
 *   - `__saveFetchLog`: chronological array of `{ url, method, time }` for
 *     every call to `window.fetch` while the wrapper is installed.  `time`
 *     is `performance.now()` at the moment of the call — sub-microsecond
 *     resolution, monotonically increasing within the page.
 *   - `__saveClickMarkerAt`: browser `performance.now()` at the moment the
 *     capture-phase click listener fires on the verified Save control.
 *   - `__saveClickMarkerInstalled`: `true` while the capture-phase click
 *     listener is attached.
 *
 * All timestamps share the browser's `performance.now()` clock — that is the
 * key reason for maintaining them in browser-side memory and reading them
 * via `page.evaluate` after the click.  We deliberately do NOT use
 * `Date.now()` because Chromium rounds it to whole milliseconds (often
 * 1ms or 100ms depending on isolation mode), which causes mousedown and
 * click events fired in the same ms to be indistinguishable.
 */
interface PageSaveMarkerSnapshot {
  clickMarkerAt: number;
  fetchLog: { url: string; method: string; time: number }[];
  clickMarkerInstalled: boolean;
}

/**
 * Install a capture-phase click marker on the verified Save control AND a
 * `window.fetch` wrapper that records every fetch call's URL, method, and
 * browser `performance.now()` timestamp.  Mutation happens in the page;
 * reads happen later via `page.evaluate`.
 */
async function installSaveClickAudit(
  page: Page,
  saveCandidate: SaveActionCandidate,
): Promise<void> {
  // Install the fetch wrapper in the page first.  The wrapper is idempotent
  // — re-installing replaces the wrapper without losing the original fetch.
  await page.evaluate(() => {
    const w = window as unknown as {
      __saveFetchLog: { url: string; method: string; time: number }[];
      __saveOrigFetch: typeof fetch | undefined;
      __saveClickMarkerAt: number;
      __saveClickMarkerInstalled: boolean;
      __saveClickMarkerListeners: number;
    };
    if (!Array.isArray(w.__saveFetchLog)) {
      w.__saveFetchLog = [];
    }
    if (typeof w.__saveOrigFetch !== 'function') {
      w.__saveOrigFetch = window.fetch.bind(window);
    }
    const origFetch = w.__saveOrigFetch;
    window.fetch = function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      let url = '';
      try {
        if (typeof input === 'string') {
          url = input;
        } else if (input instanceof URL) {
          url = input.href;
        } else if (input && typeof input === 'object' && 'url' in input) {
          const candidate = (input as Request).url;
          if (typeof candidate === 'string') url = candidate;
        }
      } catch {
        // ignore URL extraction errors
      }
      let method = 'GET';
      try {
        if (init && typeof init.method === 'string') {
          method = init.method.toUpperCase();
        } else if (
          input &&
          typeof input === 'object' &&
          'method' in input &&
          typeof (input as Request).method === 'string'
        ) {
          method = (input as Request).method.toUpperCase();
        }
      } catch {
        // fall back to GET
      }
      // performance.now() resolution is sub-microsecond — gives us reliable
      // order and delta between mousedown, click capture, and click bubble.
      w.__saveFetchLog.push({ url, method, time: performance.now() });
      return origFetch(input as RequestInfo, init);
    };

    // Reset click-marker state so prior clicks (if any) cannot poison the
    // current correlation window.  Each capture-phase click event fires
    // synchronously and overwrites this value with the latest click time.
    w.__saveClickMarkerAt = 0;
    w.__saveClickMarkerInstalled = false;
    w.__saveClickMarkerListeners = 0;
  });

  // Install the capture-phase click listener on the verified Save control.
  // `evaluate` with a function runs the function in the page context with
  // the element passed as the first argument.
  try {
    await saveCandidate.locator.evaluate((el: Element) => {
      const w = window as unknown as {
        __saveClickMarkerAt: number;
        __saveClickMarkerInstalled: boolean;
        __saveClickMarkerListeners: number;
      };
      el.addEventListener(
        'click',
        () => {
          w.__saveClickMarkerAt = performance.now();
        },
        { capture: true },
      );
      w.__saveClickMarkerInstalled = true;
      w.__saveClickMarkerListeners = (w.__saveClickMarkerListeners ?? 0) + 1;
    });
  } catch {
    // Element is unavailable — fall through to fail-safe default.
  }
}

/**
 * Read the browser-side save audit state after the click has resolved.
 * Returns `{ clickMarkerAt, fetchLog, clickMarkerInstalled }`.  If evaluate
 * throws (e.g. navigation interrupted the page), returns null marker.
 */
async function readSaveClickAudit(page: Page): Promise<PageSaveMarkerSnapshot | null> {
  try {
    const result = await page.evaluate(() => {
      const w = window as unknown as {
        __saveFetchLog?: { url: string; method: string; time: number }[];
        __saveClickMarkerAt?: number;
        __saveClickMarkerInstalled?: boolean;
      };
      return {
        clickMarkerAt: typeof w.__saveClickMarkerAt === 'number' ? w.__saveClickMarkerAt : 0,
        fetchLog: Array.isArray(w.__saveFetchLog) ? w.__saveFetchLog.slice() : [],
        clickMarkerInstalled: w.__saveClickMarkerInstalled === true,
      };
    });
    return result;
  } catch {
    return null;
  }
}

/**
 * Click the final save action and observe the expected save request/response,
 * proving the observed save request was caused by the clicked Save action
 * (Finding 2).
 *
 * Safety contract — the observed save proof MUST be click-driven, and the
 * save allowance window MUST contain exactly one matching save request — the
 * one caused by the verified Save click:
 *
 *   1. Install a browser-side `window.fetch` wrapper that records every
 *      fetch call's URL, method, and the browser's `performance.now()`
 *      timestamp (sub-microsecond resolution; shared clock with the
 *      click marker).
 *   2. Install a capture-phase click listener on the verified Save
 *      control, recording `__saveClickMarkerAt` at the moment the click
 *      event reaches the control.
 *   3. Click the Save button and await response.
 *   4. Read `__saveClickMarkerAt` and `__saveFetchLog` back from the page.
 *   5. Filter `__saveFetchLog` to entries that:
 *        (a) match POST /api/library[/<id>] (exact);
 *        (b) classify them by `time - clickMarkerAt`:
 *            - `delta < 0`              → pre-click matching (HARD REJECT)
 *            - `0 ≤ delta ≤ window`      → click-driven (must be exactly 1)
 *            - `delta > window`         → late matching (HARD REJECT)
 *   6. Require:
 *        - preClickMatchingCount === 0
 *        - clickDrivenMatchingCount === 1
 *        - lateMatchingCount === 0
 *        - response status 2xx/3xx
 *   7. Any blocked write during the save window takes precedence and
 *      produces `blockedWrite`.
 *
 * Returns:
 *   - `success`           — exactly one 2xx/3xx click-driven save response,
 *                          no pre-click, no late matching save requests.
 *   - `noSaveRequest`     — no click-driven matching request was observed.
 *   - `extraSaveRequest`  — pre-click, multiple click-driven, or late
 *                          matching save requests were observed.
 *   - `badResponseStatus` — click-driven response was not 2xx/3xx.
 *   - `blockedWrite`      — write guard blocked a non-safe request.
 *   - `error`             — click/evaluate/setup failure.
 */
async function clickFinalSave(
  page: Page,
  saveCandidate: SaveActionCandidate,
  timeout: number,
): Promise<ClickSaveResult> {
  // Track blocked writes during the save window
  const blockedWrites: string[] = [];
  const SAFE_METHODS = new Set(['GET', 'HEAD']);

  const onRequestFailed = (request: { method: () => string; url: () => string }) => {
    const method = request.method().toUpperCase();
    if (SAFE_METHODS.has(method)) return;
    const url = request.url();
    try {
      const parsed = new URL(url);
      const hostname = parsed.hostname.toLowerCase();
      if (hostname === 'backloggd.com' || hostname.endsWith('.backloggd.com')) {
        const fullPath = `${method} ${parsed.origin}${parsed.pathname}`;
        blockedWrites.push(fullPath);
      }
    } catch {
      // ignore invalid URLs
    }
  };

  page.on('requestfailed', onRequestFailed);

  // =======================================================================
  // Finding 2: Track ALL matching Playwright requests/responses, not only
  // `window.fetch`.  This covers XHR, sendBeacon, form submit, and any
  // other channel the page might use to POST a save request.
  // =======================================================================
  const matchingPlaywrightRequests: {
    url: string;
    responseStatus: number | null;
    failed: boolean;
  }[] = [];

  const onPlaywrightRequest = (request: { method: () => string; url: () => string }) => {
    if (isMatchingSaveRequest(request)) {
      matchingPlaywrightRequests.push({
        url: request.url(),
        responseStatus: null,
        failed: false,
      });
    }
  };

  const onPlaywrightResponse = (response: {
    status: () => number;
    request: () => { method: () => string; url: () => string };
  }) => {
    if (isMatchingSaveRequest(response.request())) {
      // Find the first still-unresolved entry for this URL
      const resUrl = response.request().url();
      const entry = matchingPlaywrightRequests.find(
        (e) => e.url === resUrl && e.responseStatus === null && !e.failed,
      );
      if (entry) {
        entry.responseStatus = response.status();
      }
    }
  };

  page.on('request', onPlaywrightRequest);
  page.on('response', onPlaywrightResponse);

  // Install the page-side click marker and fetch wrapper BEFORE allowing
  // the save window.  These are used to correlate matching requests to the
  // click event.
  await installSaveClickAudit(page, saveCandidate);

  // Enable save allowance before clicking
  enableSaveAllowance(page);

  try {
    // Record the wall-clock time for the late-detection window (Finding 1).
    const clickNodeWallTimeMs = Date.now();

    await saveCandidate.locator.click({ timeout });

    // Read the browser-side audit state.  Both `__saveClickMarkerAt`
    // and the entries in `__saveFetchLog` use the browser's wall clock,
    // so direct subtraction is correct (no Node/browser skew).
    const audit = await readSaveClickAudit(page);

    // Wait for the expected save POST response.  `waitForResponse` resolves
    // on the FIRST matching response.  Final correlation uses our page-side
    // audit log and the click marker, not the response itself.
    const responseTimeout = Math.min(timeout, SAVE_RESPONSE_TIMEOUT_MS);

    let observedResponse: { status: number; url: string } | null = null;
    try {
      const response = await page.waitForResponse((res) => isMatchingSaveRequest(res.request()), {
        timeout: responseTimeout,
      });
      observedResponse = { status: response.status(), url: response.url() };
    } catch {
      // Timed out or no matching response.
      observedResponse = null;
    }

    // =====================================================================
    // Finding 1: Wait for the full late-detection window to elapse from
    // the Save click.  This ensures any late/additional matching POSTs
    // scheduled by the click handler chain (e.g. setTimeout 75–250ms) are
    // captured by both the page-side fetch audit and the Playwright request
    // tracking before we decide success or failure.
    //
    // The save allowance remains active during this window so late requests
    // are allowed to fire and be recorded.  Blocked writes are still
    // collected via the `requestfailed` listener.
    // =====================================================================
    const elapsedMs = Date.now() - clickNodeWallTimeMs;
    const remainingObservationMs = Math.max(0, LATE_DETECTION_WINDOW_MS - elapsedMs);
    if (remainingObservationMs > 0) {
      await page.waitForTimeout(remainingObservationMs);
    }

    // Re-read the audit after the full observation window so that any late
    // matching fetch calls are captured.
    const auditFinal = await readSaveClickAudit(page);
    const fetchLog = auditFinal?.fetchLog ?? audit?.fetchLog ?? [];
    const clickMarkerAt = auditFinal?.clickMarkerAt ?? audit?.clickMarkerAt ?? 0;

    // ---------------------------------------------------------------------
    // Correlate observed matching requests against the click marker.
    //
    // Both the click marker (`__saveClickMarkerAt`) and the entries in
    // `__saveFetchLog` use `performance.now()`, so they share a clock with
    // sub-microsecond resolution.  This avoids `Date.now()`'s ms-level
    // rounding that would otherwise let a mousedown-handler fetch fired
    // in the same ms as the click event be mis-classified as click-driven.
    // ---------------------------------------------------------------------

    let clickDrivenCount = 0;
    let preClickMatchingCount = 0;
    let lateMatchingCount = 0;
    const matchingFetchLogEntries: {
      url: string;
      method: string;
      time: number;
    }[] = [];

    if (clickMarkerAt > 0) {
      for (const entry of fetchLog) {
        let hostnameOk = false;
        let pathOk = false;
        try {
          const parsed = new URL(entry.url);
          const hostname = parsed.hostname.toLowerCase();
          hostnameOk = hostname === 'backloggd.com' || hostname.endsWith('.backloggd.com');
          pathOk = SAVE_API_REGEX.test(parsed.pathname);
        } catch {
          // ignore unparseable URLs
        }
        const matchesSaveApi = entry.method === 'POST' && hostnameOk && pathOk;
        if (!matchesSaveApi) continue;
        matchingFetchLogEntries.push(entry);
        const timeDelta = entry.time - clickMarkerAt;
        if (timeDelta >= 0 && timeDelta <= CLICK_DRIVEN_WINDOW_PERF_MS) {
          clickDrivenCount++;
        } else if (timeDelta < 0) {
          // Entry was logged BEFORE the click marker.  This is a
          // pre-click matching request and INVALIDATES the save proof
          // even if a click-driven valid request also exists.  The save
          // allowance window is meant to allow exactly one matching
          // request — the one caused by the verified Save click — so
          // any earlier matching request is a hard reject.
          preClickMatchingCount++;
        } else {
          // Entry was logged AFTER the click-driven window closed.  This
          // is a delayed/unrelated matching POST and must reject the save.
          lateMatchingCount++;
        }
      }
    }

    // If we couldn't read the audit (e.g. navigation shut the page), fail
    // safe: cannot prove click-driven correlation.
    if (!audit && !auditFinal) {
      return {
        kind: 'noSaveRequest',
        blockedWrites,
        responseStatus: observedResponse?.status ?? null,
        clickDrivenRequestCount: 0,
        playwrightRequestCount: matchingPlaywrightRequests.length,
        fetchAuditMatchCount: 0,
        error: 'audit_unavailable',
      };
    }

    if (clickMarkerAt <= 0) {
      return {
        kind: 'noSaveRequest',
        blockedWrites,
        responseStatus: observedResponse?.status ?? null,
        clickDrivenRequestCount: 0,
        playwrightRequestCount: matchingPlaywrightRequests.length,
        fetchAuditMatchCount: 0,
        error: 'click_marker_not_recorded',
      };
    }

    // -------------------------------------------------------------------
    // Finding 2: Compute the total fetch audit match count and compare
    // with the Playwright request count.  A mismatch indicates a request
    // was made via a channel not captured by the page-side fetch audit
    // (e.g. XHR, sendBeacon, form submit) — which must be rejected.
    // -------------------------------------------------------------------
    const fetchAuditMatchCount = matchingFetchLogEntries.length;

    // Blocked writes take precedence — unexpected provider writes are a
    // stronger signal than a clean observed save proof.
    if (blockedWrites.length > 0) {
      // Check whether any blocked write is a matching save request that
      // was blocked after allowance closed but within the observation
      // window (Finding 1).
      // blockedWrites entries are formatted as "METHOD origin+pathname"
      const blockedSaveWrites = blockedWrites.filter((bw) => {
        if (!bw.startsWith('POST ')) return false;
        try {
          const urlPart = bw.slice(5); // strip "POST "
          const parsed = new URL(urlPart);
          return SAVE_API_REGEX.test(parsed.pathname);
        } catch {
          return false;
        }
      });

      return {
        kind: 'blockedWrite',
        blockedWrites,
        responseStatus: observedResponse?.status ?? null,
        clickDrivenRequestCount: clickDrivenCount,
        playwrightRequestCount: matchingPlaywrightRequests.length,
        fetchAuditMatchCount,
        error:
          blockedSaveWrites.length > 0
            ? `blocked_save_write:${blockedSaveWrites.join(';')}`
            : undefined,
      };
    }

    if (clickDrivenCount === 0 && matchingFetchLogEntries.length > 0) {
      // All matching requests fired either BEFORE the click (pre-click
      // POSTs) or AFTER the click-driven window (delayed/injected POSTs)
      // — the click itself did not produce a counted save request.
      return {
        kind: 'noSaveRequest',
        blockedWrites,
        responseStatus: observedResponse?.status ?? null,
        clickDrivenRequestCount: 0,
        playwrightRequestCount: matchingPlaywrightRequests.length,
        fetchAuditMatchCount,
        error: 'no_click_driven_save_request_observed',
      };
    }

    if (clickDrivenCount > 1) {
      return {
        kind: 'extraSaveRequest',
        blockedWrites,
        responseStatus: observedResponse?.status ?? null,
        clickDrivenRequestCount: clickDrivenCount,
        playwrightRequestCount: matchingPlaywrightRequests.length,
        fetchAuditMatchCount,
        error: `multiple_click_driven_save_requests:${clickDrivenCount}`,
      };
    }

    if (preClickMatchingCount > 0) {
      return {
        kind: 'extraSaveRequest',
        blockedWrites,
        responseStatus: observedResponse?.status ?? null,
        clickDrivenRequestCount: clickDrivenCount,
        playwrightRequestCount: matchingPlaywrightRequests.length,
        fetchAuditMatchCount,
        error: `pre_click_matching_save_requests:${preClickMatchingCount}`,
      };
    }

    if (lateMatchingCount > 0) {
      return {
        kind: 'extraSaveRequest',
        blockedWrites,
        responseStatus: observedResponse?.status ?? null,
        clickDrivenRequestCount: clickDrivenCount,
        playwrightRequestCount: matchingPlaywrightRequests.length,
        fetchAuditMatchCount,
        error: `late_matching_save_requests:${lateMatchingCount}`,
      };
    }

    // -------------------------------------------------------------------
    // Finding 2: Require Playwright request count to match fetch audit
    // count.  If the page used a non-fetch channel (XHR, sendBeacon, form
    // submit), Playwright sees it but the fetch audit does not — mismatch.
    // -------------------------------------------------------------------
    if (matchingPlaywrightRequests.length !== fetchAuditMatchCount) {
      return {
        kind: 'extraSaveRequest',
        blockedWrites,
        responseStatus: observedResponse?.status ?? null,
        clickDrivenRequestCount: clickDrivenCount,
        playwrightRequestCount: matchingPlaywrightRequests.length,
        fetchAuditMatchCount,
        error: `mismatched_request_count:playwright=${matchingPlaywrightRequests.length}:fetchAudit=${fetchAuditMatchCount}`,
      };
    }

    // Require exactly one matching Playwright request total (Finding 2).
    if (matchingPlaywrightRequests.length > 1) {
      return {
        kind: 'extraSaveRequest',
        blockedWrites,
        responseStatus: observedResponse?.status ?? null,
        clickDrivenRequestCount: clickDrivenCount,
        playwrightRequestCount: matchingPlaywrightRequests.length,
        fetchAuditMatchCount,
        error: `multiple_playwright_save_requests:${matchingPlaywrightRequests.length}`,
      };
    }

    // Require zero matching Playwright requests if no click-driven request.
    // (clickDrivenCount === 0 case already handled above; this is defense.)
    if (clickDrivenCount === 0) {
      return {
        kind: 'noSaveRequest',
        blockedWrites,
        responseStatus: observedResponse?.status ?? null,
        clickDrivenRequestCount: 0,
        playwrightRequestCount: matchingPlaywrightRequests.length,
        fetchAuditMatchCount,
        error: 'no_click_driven_save_request_observed',
      };
    }

    // Exactly one click-driven request, no pre-click matching, no late
    // matching, Playwright count matches fetch audit count.
    // This is the only configuration that satisfies the save proof.

    // Finding 2: Verify the response belongs to the single matching
    // Playwright request and its status is 2xx/3xx.
    const pwRequest = matchingPlaywrightRequests[0];
    const pwResponseStatus = pwRequest?.responseStatus ?? null;

    // If we have a Playwright response status, it must be 2xx/3xx.
    if (pwResponseStatus !== null && (pwResponseStatus < 200 || pwResponseStatus >= 400)) {
      return {
        kind: 'badResponseStatus',
        blockedWrites,
        responseStatus: pwResponseStatus,
        clickDrivenRequestCount: clickDrivenCount,
        playwrightRequestCount: matchingPlaywrightRequests.length,
        fetchAuditMatchCount,
        error: `playwright_bad_response:${pwResponseStatus}`,
      };
    }

    // Verify the response was 2xx/3xx (fallback to waitForResponse).  If
    // the Playwright request didn't get a response (blocked/failed), but
    // waitForResponse saw one – that's a mismatch and must be rejected.
    if (!observedResponse) {
      if (wasSavePostSeen(page)) {
        return {
          kind: 'error',
          blockedWrites,
          responseStatus: null,
          clickDrivenRequestCount: clickDrivenCount,
          playwrightRequestCount: matchingPlaywrightRequests.length,
          fetchAuditMatchCount,
          error: 'no_save_response_received',
        };
      }
      return {
        kind: 'noSaveRequest',
        blockedWrites,
        responseStatus: null,
        clickDrivenRequestCount: clickDrivenCount,
        playwrightRequestCount: matchingPlaywrightRequests.length,
        fetchAuditMatchCount,
        error: 'no_save_response_observed',
      };
    }

    if (observedResponse.status < 200 || observedResponse.status >= 400) {
      return {
        kind: 'badResponseStatus',
        blockedWrites,
        responseStatus: observedResponse.status,
        clickDrivenRequestCount: clickDrivenCount,
        playwrightRequestCount: matchingPlaywrightRequests.length,
        fetchAuditMatchCount,
        error: `save_response_${observedResponse.status}`,
      };
    }

    return {
      kind: 'success',
      blockedWrites,
      responseStatus: observedResponse.status,
      clickDrivenRequestCount: clickDrivenCount,
      playwrightRequestCount: matchingPlaywrightRequests.length,
      fetchAuditMatchCount,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      kind: 'error',
      blockedWrites,
      responseStatus: null,
      clickDrivenRequestCount: 0,
      playwrightRequestCount: matchingPlaywrightRequests.length,
      fetchAuditMatchCount: 0,
      error: msg,
    };
  } finally {
    page.removeListener('requestfailed', onRequestFailed);
    page.removeListener('request', onPlaywrightRequest);
    page.removeListener('response', onPlaywrightResponse);
    disableSaveAllowance(page);
  }
}

// ---------------------------------------------------------------------------
// Post-save verification
// ---------------------------------------------------------------------------

/**
 * Re-read the visible ownership state after save and verify Steam/Digital
 * ownership is now present.
 *
 * Returns true only if ownership is confirmed present.
 */
async function verifyPostSaveOwnership(
  page: Page,
  expectedTitle: string,
  expectedSlug: string,
  plannedPlatform: string,
  plannedOwnershipType: string,
  timeout: number,
): Promise<boolean> {
  try {
    const visibleState = await readVisibleBackloggdState(page, expectedTitle, expectedSlug, {
      timeout,
    });

    if (visibleState.diagnostics.pageType !== 'game') return false;

    const plannedPlatformLower = plannedPlatform.trim().toLowerCase();
    const plannedOwnershipLower = plannedOwnershipType.trim().toLowerCase();

    return visibleState.library.ownershipEntries.some((entry) => {
      const entryPlatform = (entry.platform ?? '').trim().toLowerCase();
      const entryOwnership = (entry.ownershipType ?? '').trim().toLowerCase();
      return entryPlatform === plannedPlatformLower && entryOwnership === plannedOwnershipLower;
    });
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Run confirmed ownership save for a session.
 */
export async function runConfirmedOwnershipSave(
  options: OwnershipSaveExecutorOptions,
): Promise<SaveResult[]> {
  const { db, sessionId, page } = options;
  const timeout = options.timeout ?? 5000;
  const resolvePageUrl = options.resolvePageUrl ?? defaultResolvePageUrl;
  const results: SaveResult[] = [];

  // 1. Read all confirmed confirmation rows for this session
  const rows = db
    .prepare(
      `SELECT proposal_id, import_session_id, confirmation_batch_id,
              planned_platform, planned_ownership_type, planned_slug,
              planned_absent_checked_at, status
       FROM import_item_confirmations
       WHERE import_session_id = ?
         AND status = 'confirmed'
       ORDER BY id ASC`,
    )
    .all(sessionId) as ConfirmationRow[];

  if (rows.length === 0) {
    return results;
  }

  // 2. Process each confirmation
  let writeGuardInstalled = false;

  for (const confirmation of rows) {
    const pid = confirmation.proposal_id;
    const batchId = confirmation.confirmation_batch_id;
    const slug = (confirmation.planned_slug ?? '').trim();
    const plannedPlatform = (confirmation.planned_platform ?? '').trim();
    const plannedOwnershipType = (confirmation.planned_ownership_type ?? '').trim();

    // -----------------------------------------------------------------------
    // Pre-browser revalidation
    // -----------------------------------------------------------------------
    const revalidation = revalidateConfirmation(db, sessionId, confirmation);
    if (!revalidation.ok) {
      results.push({
        proposalId: pid,
        status: 'stale',
        confirmationBatchId: batchId,
        detail: revalidation.reason,
      });
      continue;
    }

    // -----------------------------------------------------------------------
    // Install write guard before any browser interaction
    // -----------------------------------------------------------------------
    if (!writeGuardInstalled) {
      await installWriteGuard(page);
      writeGuardInstalled = true;
    }

    // -----------------------------------------------------------------------
    // Browser staging via Slice 3 path
    // -----------------------------------------------------------------------
    const stagingResult = await stageOwnershipInBrowser(page, confirmation, {
      db,
      sessionId,
      page,
      timeout,
      resolvePageUrl,
    });

    const stagingStatus = stagingResult.status;

    if (stagingStatus !== 'staged') {
      const saveStatus: SaveResultStatus =
        stagingStatus === 'browserFailed' ? 'browserFailed' : 'stagingFailed';
      results.push({
        proposalId: pid,
        status: saveStatus,
        confirmationBatchId: batchId,
        detail: stagingResult.detail ?? stagingStatus,
      });
      continue;
    }

    // -----------------------------------------------------------------------
    // Verify editor scope (Finding 3)
    // -----------------------------------------------------------------------
    const editorScope = await findStagedEditorScope(page, plannedPlatform, plannedOwnershipType);
    if (!editorScope) {
      results.push({
        proposalId: pid,
        status: 'unsupported',
        confirmationBatchId: batchId,
        detail: 'no_unique_staged_editor_scope',
      });
      continue;
    }

    // -----------------------------------------------------------------------
    // Identify safe final save action (scoped to verified editor)
    // -----------------------------------------------------------------------
    const saveCandidate = await findSafeSaveButton(editorScope);
    if (!saveCandidate) {
      results.push({
        proposalId: pid,
        status: 'unsupported',
        confirmationBatchId: batchId,
        detail: 'no_unique_safe_save_action',
      });
      continue;
    }

    // -----------------------------------------------------------------------
    // Click final save and observe the expected save request/response
    // -----------------------------------------------------------------------
    const clickResult = await clickFinalSave(page, saveCandidate, timeout);

    switch (clickResult.kind) {
      case 'blockedWrite':
        results.push({
          proposalId: pid,
          status: 'blockedWrite',
          confirmationBatchId: batchId,
          detail: clickResult.blockedWrites.join('; '),
        });
        continue;
      case 'noSaveRequest':
        results.push({
          proposalId: pid,
          status: 'saveFailed',
          confirmationBatchId: batchId,
          detail: clickResult.error ?? 'no_click_driven_save_request_observed',
        });
        continue;
      case 'extraSaveRequest':
        results.push({
          proposalId: pid,
          status: 'saveFailed',
          confirmationBatchId: batchId,
          detail:
            clickResult.error ??
            `unexpected_save_request_count:${clickResult.clickDrivenRequestCount}`,
        });
        continue;
      case 'badResponseStatus':
        results.push({
          proposalId: pid,
          status: 'saveFailed',
          confirmationBatchId: batchId,
          detail: clickResult.error ?? `save_response_${clickResult.responseStatus}`,
        });
        continue;
      case 'error':
        results.push({
          proposalId: pid,
          status: 'saveFailed',
          confirmationBatchId: batchId,
          detail: clickResult.error ?? 'save_click_failed',
        });
        continue;
      case 'success':
        break;
    }

    // -----------------------------------------------------------------------
    // Re-read visible ownership state and verify
    // -----------------------------------------------------------------------
    const itemDb = getItem(db, pid);
    const gameTitle: string = itemDb ? (lookUpGameTitle(db, itemDb.steamAppId) ?? '') : '';
    const targetUrl = resolvePageUrl(slug);

    try {
      const currentUrl = page.url();
      const currentParsed = new URL(currentUrl);
      const targetParsed = new URL(targetUrl);
      if (currentParsed.href !== targetParsed.href) {
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
      }
    } catch {
      results.push({
        proposalId: pid,
        status: 'browserFailed',
        confirmationBatchId: batchId,
        detail: 'navigation_failed_after_save',
      });
      continue;
    }

    const pageVerified = await verifyGamePage(page, gameTitle, slug, {
      timeout: VERIFY_TIMEOUT_MS,
    });
    if (!pageVerified) {
      results.push({
        proposalId: pid,
        status: 'browserFailed',
        confirmationBatchId: batchId,
        detail: 'game_verification_failed_after_save',
      });
      continue;
    }

    const ownershipVerified = await verifyPostSaveOwnership(
      page,
      gameTitle,
      slug,
      plannedPlatform,
      plannedOwnershipType,
      POST_SAVE_VERIFY_TIMEOUT_MS,
    );

    if (!ownershipVerified) {
      results.push({
        proposalId: pid,
        status: 'verificationFailed',
        confirmationBatchId: batchId,
        detail: 'ownership_not_visible_after_save',
      });
      continue;
    }

    // -----------------------------------------------------------------------
    // Update local state — atomic transition (Finding 4)
    // -----------------------------------------------------------------------
    try {
      const atomicTransition = db.transaction(() => {
        transitionItem(db, pid, 'importing');
        transitionItem(db, pid, 'saved', {
          outcomeReason: `saved:ownership:platform=${plannedPlatform}:type=${plannedOwnershipType}`,
        });
      });
      atomicTransition();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({
        proposalId: pid,
        status: 'saveFailed',
        confirmationBatchId: batchId,
        detail: `state_transition_failed:${msg}`,
      });
      continue;
    }

    results.push({
      proposalId: pid,
      status: 'saved',
      confirmationBatchId: batchId,
      detail: `saved:ownership:${plannedPlatform}/${plannedOwnershipType}`,
    });
  }

  return results;
}
