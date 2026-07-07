/**
 * Read-only visible ownership state model and reader for Backloggd game pages.
 *
 * Phase 5B Slice 1 — safe, fixture-tested, independent of database/import
 * state mutation.  This module NEVER mutates the page.  It only reads:
 *   - visible text (via `innerText`, which excludes hidden descendants);
 *   - visible selected labels/options for native `<select>`;
 *   - accessibility state such as aria-selected / aria-pressed / aria-checked;
 *   - existing safe page-verification helpers.
 *
 * It must not click any control.  See comparison.ts for the pure comparator.
 *
 * Hardening rules (see Phase 5B Slice 1 findings):
 *   1. Hidden text never becomes ownership evidence.
 *   2. Missing/unrecognized entry structure never becomes an empty library.
 *   3. Nested ownership structures require uniqueness.
 *   4. Delayed login/challenge/rate-limit UI is rechecked before returning.
 *   5. A unique additive control must be a visible, enabled, actionable
 *      button or link whose computed accessible name exactly matches a
 *      supported equivalent.
 *   6. A recognized ownership list with visible unrecognized child content
 *      must NOT be treated as empty.  Only a list proven to have no
 *      rendered visible child content is a valid empty representation.
 *   7. The additive-control accessible name uses the Playwright-computed
 *      accessible name (excludes hidden descendants); `<a>` without `href`,
 *      buttons disabled by ancestor `<fieldset disabled>`, and hidden text
 *      never satisfy the requirement.
 */

import type { Locator, Page } from 'playwright';
import {
  trySelectors,
  trySelectorsInLocator,
  gameTitleStrategies,
  type SelectorStrategy,
} from './selectors.js';

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/**
 * A read-only snapshot of the visible ownership-related state of a Backloggd
 * game page.  Separate from the Milestone 4 POC {@link PageState}.
 *
 * For Phase 5B Slice 1, status is intentionally left `unknown` unless the
 * visible active-status semantics are already fixture-proven.
 */
export interface VisibleBackloggdState {
  game: {
    visibleTitle: string;
    slug: string;
    verified: boolean;
  };
  library: {
    membership: 'present' | 'absent' | 'unknown';
    completeness: 'complete' | 'partial' | 'ambiguous' | 'unsupported';
    ownershipEntries: {
      platform: string | null;
      ownershipType: string | null;
    }[];
    addControl: 'unique' | 'absent' | 'ambiguous';
  };
  status: {
    value: string | null;
    evidence: 'explicit-value' | 'explicit-none' | 'unknown' | 'ambiguous';
  };
  /** Sanitized diagnostic only — never raw HTML, cookies, or session data. */
  diagnostics: {
    pageType: 'game' | 'login' | 'challenge' | 'rate-limit' | 'unknown';
    regionCount: number;
    entryCount: number;
    addControlCount: number;
    notes: string[];
  };
}

// ---------------------------------------------------------------------------
// Selector strategies for the visible ownership region
// ---------------------------------------------------------------------------

const libraryRegionStrategies: SelectorStrategy[] = [
  { name: 'testid-library', selector: '[data-testid="library"]' },
  { name: 'aria-library', selector: '[aria-label="Library"]' },
  { name: 'id-library', selector: '#library' },
  {
    name: 'section-with-ownership-entries',
    selector: 'section:has([data-testid="ownership-entries"])',
  },
];

const ownershipEntriesListStrategies: SelectorStrategy[] = [
  { name: 'testid-ownership-entries', selector: '[data-testid="ownership-entries"]' },
  { name: 'aria-ownership-entries', selector: '[aria-label="Ownership entries"]' },
  { name: 'role-list-in-library', selector: '[role="list"]' },
];

const ownershipEntryStrategies: SelectorStrategy[] = [
  { name: 'testid-ownership-entry', selector: '[data-testid="ownership-entry"]' },
  { name: 'role-listitem', selector: '[role="listitem"]' },
  { name: 'class-ownership-entry', selector: '.ownership-entry' },
];

const platformFieldStrategies: SelectorStrategy[] = [
  { name: 'data-field-platform', selector: '[data-field="platform"]' },
  { name: 'class-platform', selector: '.platform' },
];

const ownershipFieldStrategies: SelectorStrategy[] = [
  { name: 'data-field-ownership', selector: '[data-field="ownership"]' },
  { name: 'class-ownership-type', selector: '.ownership-type' },
];

/**
 * Supported accessible names for an additive control (normalized lowercase,
 * single-spaced).  Compared via Playwright role locators (see
 * {@link countActionableAddControls}) so hidden descendants, ancestor
 * `<fieldset disabled>`, and `<a>` without `href` are all excluded by the
 * Playwright accessibility tree itself.
 */
const SUPPORTED_ADD_CONTROL_NAMES: readonly string[] = ['add ownership', 'add to library'];

/**
 * Generic library membership cues — visible text that indicates the game is
 * in the user's library but without any per-entry platform/ownership detail.
 * Treated as `unknown` by the comparator.
 */
const genericMembershipCueStrategies: SelectorStrategy[] = [
  { name: 'testid-library-membership', selector: '[data-testid="library-membership"]' },
  { name: 'class-library-membership', selector: '.library-membership' },
  { name: 'text-in-your-library', selector: ':text-is("In your library")' },
];

// ---------------------------------------------------------------------------
// Login / challenge / rate-limit cue strategies
// ---------------------------------------------------------------------------

const challengeCueStrategies: SelectorStrategy[] = [
  { name: 'testid-captcha-form', selector: '[data-testid="captcha-form"]' },
  { name: 'aria-challenge', selector: '[aria-label="Challenge"]' },
  { name: 'captcha-input', selector: 'input[name="captcha"]' },
  { name: 'challenge-heading', selector: 'h1:has-text("challenge")' },
];

const rateLimitCueStrategies: SelectorStrategy[] = [
  { name: 'testid-rate-limit', selector: '[data-testid="rate-limit-status"]' },
  { name: 'rate-limit-heading', selector: 'h1:has-text("Slow down")' },
  { name: 'rate-limit-text', selector: 'p:has-text("rate limited")' },
  { name: 'http-429-text', selector: 'p:has-text("429")' },
];

/**
 * CSS-only login cue union (cannot mix role= with CSS in a comma selector).
 * Used for a single fast visible-presence check.
 */
const loginCueCssUnion = 'a:has-text("Sign In"), a:has-text("Log In"), button:has-text("Sign In")';

/**
 * Combined blocker-cue union (challenge + rate-limit + login).  Used by the
 * post-read recheck so a delayed blocker overlay is caught with a single wait.
 */
const blockerCueCssUnion = [
  ...challengeCueStrategies,
  ...rateLimitCueStrategies,
  { name: 'login-union', selector: loginCueCssUnion },
]
  .map((s) => s.selector)
  .join(', ');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeVisibleText(text: string | null): string | null {
  if (text === null) return null;
  const trimmed = text.trim().replace(/\s+/g, ' ');
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Read the visible text of a single ownership field within a row.
 *
 * Finding 1: hidden text never becomes ownership evidence.
 *   - For a native `<select>`, read only the selected option's text (a DOM
 *     property read, not HTML scraping).  A placeholder option (empty value)
 *     is treated as no selection → null.
 *   - For `<input>`/`<textarea>` field elements, return null (unsupported
 *     field element type — do not guess from the value attribute).
 *   - For other containers (span/div/etc.), use `innerText`, which excludes
 *     hidden descendants and unselected `<option>` text.
 *
 * The caller must have already verified field uniqueness (Finding 3) before
 * relying on this value.
 */
async function readFieldText(
  scope: Locator,
  strategies: SelectorStrategy[],
): Promise<string | null> {
  const result = await trySelectorsInLocator(scope, strategies, { visible: true, timeout: 250 });
  if (!result) return null;
  const loc = result.locator;

  const tag = await loc.evaluate((el: Element) => el.tagName).catch(() => '');
  if (tag === 'SELECT') {
    return normalizeVisibleText(
      await loc
        .evaluate((el: Element) => {
          if (el.tagName !== 'SELECT') return null;
          const sel = el as HTMLSelectElement;
          const idx = sel.selectedIndex;
          if (idx < 0) return null;
          const opt = sel.options[idx];
          if (!opt) return null;
          if (opt.value === '') return null; // placeholder option
          return opt.text;
        })
        .catch(() => null),
    );
  }
  if (tag === 'INPUT' || tag === 'TEXTAREA') {
    // Unsupported field element type for ownership evidence.
    return null;
  }
  // Visible container: innerText excludes hidden descendants and unselected
  // <option> text, unlike textContent.
  return normalizeVisibleText(await loc.innerText().catch(() => null));
}

/**
 * Count visible elements matching any of the given strategies via a single
 * comma-unioned selector.  No waitFor — the caller has already ensured the
 * scope is loaded.  Deduped by element identity.
 */
async function countVisible(
  scope: Page | Locator,
  strategies: SelectorStrategy[],
): Promise<number> {
  const selector = strategies.map((s) => s.selector).join(', ');
  const locator = scope.locator(selector);
  let count = 0;
  try {
    const total = await locator.count();
    for (let i = 0; i < total; i += 1) {
      if (
        await locator
          .nth(i)
          .isVisible()
          .catch(() => false)
      )
        count += 1;
    }
  } catch {
    // ignore
  }
  return count;
}

/**
 * Whether an element is rendered (not display:none / visibility:hidden /
 * hidden).  Unlike Playwright's `isVisible()`, this returns true for empty
 * containers that have no rendered box (e.g. an empty `<ul>`), which is
 * required to prove a recognized empty ownership list (Finding 2).
 *
 * Uses `Element.checkVisibility({visibilityProperty:true})` where available,
 * with a computed-style fallback.
 */
async function isRendered(loc: Locator): Promise<boolean> {
  return loc
    .evaluate((el: Element) => {
      const anyEl = el as Element & {
        checkVisibility?: (opts?: { visibilityProperty?: boolean }) => boolean;
      };
      if (typeof anyEl.checkVisibility === 'function') {
        return anyEl.checkVisibility({ visibilityProperty: true }) === true;
      }
      const cs = window.getComputedStyle(el);
      return cs.display !== 'none' && cs.visibility !== 'hidden' && !el.hasAttribute('hidden');
    })
    .catch(() => false);
}

/**
 * Collect Locators matching any of the given strategies that are rendered
 * (not hidden), deduped by element identity.  Accepts empty containers.
 */
async function collectRenderedLocators(
  scope: Locator,
  strategies: SelectorStrategy[],
): Promise<Locator[]> {
  const selector = strategies.map((s) => s.selector).join(', ');
  const locator = scope.locator(selector);
  const matches: Locator[] = [];
  try {
    const total = await locator.count();
    for (let i = 0; i < total; i += 1) {
      const loc = locator.nth(i);
      if (await isRendered(loc)) matches.push(loc);
    }
  } catch {
    // ignore
  }
  return matches;
}

/**
 * Collect visible Locators matching any of the given strategies, deduped by
 * element identity (not by text) so legitimate duplicate rows are preserved
 * for the comparator to flag as a conflict.
 */
async function collectVisibleLocators(
  scope: Locator,
  strategies: SelectorStrategy[],
): Promise<Locator[]> {
  const selector = strategies.map((s) => s.selector).join(', ');
  const locator = scope.locator(selector);
  const matches: Locator[] = [];
  try {
    const total = await locator.count();
    for (let i = 0; i < total; i += 1) {
      const loc = locator.nth(i);
      if (await loc.isVisible().catch(() => false)) matches.push(loc);
    }
  } catch {
    // ignore
  }
  return matches;
}

/**
 * Count actionable additive controls within a scope (Finding 5 / Phase 5B
 * Slice 1 hardening).
 *
 * An additive control is satisfied only by a visible, enabled, actionable
 * button or link whose computed accessible name exactly matches a supported
 * equivalent ("Add Ownership" / "Add to Library").  The check uses
 * Playwright role locators, so:
 *
 *   - `<a>` without `href` is excluded (no implicit `link` role);
 *   - buttons inside a `<fieldset disabled>` are excluded (`disabled: false`
 *     walks the ancestor tree per the HTML spec);
 *   - hidden text never contributes to the accepted accessible name (the role
 *     locator uses the computed accessible name, which excludes hidden
 *     descendants per the Accessible Name and Description Computation spec);
 *   - non-button, non-link, disabled, hidden, or wrong-name candidates are
 *     excluded.
 *
 * The control is never clicked.
 */
async function countActionableAddControls(region: Locator): Promise<number> {
  let count = 0;
  for (const supportedName of SUPPORTED_ADD_CONTROL_NAMES) {
    const pattern = supportedNameToPattern(supportedName);
    // Buttons: getByRole('button') requires the implicit or explicit button
    // role.  The default visibility filter excludes hidden elements.
    // disabled: false filters out disabled buttons AND buttons disabled
    // by an ancestor <fieldset disabled>.
    const buttonLocator = region.getByRole('button', {
      name: pattern,
      disabled: false,
    });
    count += await buttonLocator.count().catch(() => 0);
    // Links: getByRole('link') requires the implicit link role, which the
    // spec only assigns to <a> elements with an href.  An <a> without href
    // is excluded.  disabled: false is a no-op for links (they have no
    // disabled state) but is included for symmetry.
    const linkLocator = region.getByRole('link', {
      name: pattern,
      disabled: false,
    });
    count += await linkLocator.count().catch(() => 0);
  }
  return count;
}

/**
 * Convert a supported additive-control name into a RegExp that matches the
 * full computed accessible name (case-insensitive, with whitespace
 * flexibility).  Used by Playwright's `getByRole({ name })`.
 */
function supportedNameToPattern(supportedName: string): RegExp {
  const escaped = supportedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+');
  return new RegExp(`^\\s*${escaped}\\s*$`, 'i');
}

/**
 * Determine the page type from visible cues.  Never mutates the page.
 *
 * Honors the supplied timeout (capped) so a blocker present at load is found.
 * Uses a single CSS-union locator per page type so the negative case is one
 * short wait, not one wait per strategy.
 */
async function detectPageType(
  page: Page,
  timeout: number,
): Promise<'game' | 'login' | 'challenge' | 'rate-limit' | 'unknown'> {
  const cueTimeout = Math.min(timeout, 200);

  async function hasVisible(cssUnion: string): Promise<boolean> {
    const loc = page.locator(cssUnion);
    try {
      await loc.first().waitFor({ state: 'visible', timeout: cueTimeout });
      return (await loc.count()) > 0;
    } catch {
      return false;
    }
  }

  const challengeCss = challengeCueStrategies.map((s) => s.selector).join(', ');
  if (await hasVisible(challengeCss)) return 'challenge';

  const rateLimitCss = rateLimitCueStrategies.map((s) => s.selector).join(', ');
  if (await hasVisible(rateLimitCss)) return 'rate-limit';

  if (await hasVisible(loginCueCssUnion)) return 'login';

  return 'game';
}

/**
 * Post-read blocker recheck (Finding 4).  Returns true if any blocker cue
 * (challenge / rate-limit / login) is visible now or becomes visible within
 * the recheck window.  Never mutates the page.
 */
async function hasVisibleBlocker(page: Page, timeout: number): Promise<boolean> {
  const recheckTimeout = Math.min(timeout, 500);
  const loc = page.locator(blockerCueCssUnion);
  try {
    await loc.first().waitFor({ state: 'visible', timeout: recheckTimeout });
    return (await loc.count()) > 0;
  } catch {
    return false;
  }
}

function emptyState(
  visibleTitle: string,
  slug: string,
  verified: boolean,
  pageType: 'game' | 'login' | 'challenge' | 'rate-limit' | 'unknown',
  notes: string[],
): VisibleBackloggdState {
  return {
    game: { visibleTitle, slug, verified },
    library: {
      membership: 'unknown',
      completeness: 'unsupported',
      ownershipEntries: [],
      addControl: 'absent',
    },
    status: { value: null, evidence: 'unknown' },
    diagnostics: {
      pageType,
      regionCount: 0,
      entryCount: 0,
      addControlCount: 0,
      notes,
    },
  };
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

/**
 * Read the visible ownership state of a Backloggd game page.
 *
 * This function is read-only: it never clicks, types, or otherwise mutates
 * the page.  It uses only visible text, visible selected labels/options, and
 * accessibility state.
 */
export async function readVisibleBackloggdState(
  page: Page,
  expectedTitle: string,
  expectedSlug: string,
  options: { timeout?: number } = {},
): Promise<VisibleBackloggdState> {
  const timeout = options.timeout ?? 3000;
  const notes: string[] = [];

  // -----------------------------------------------------------------------
  // Finding 4 — check blocker cues before reading ownership.
  // -----------------------------------------------------------------------
  const pageType = await detectPageType(page, timeout);
  if (pageType !== 'game') {
    notes.push(`unsupported-page-type:${pageType}`);
    return emptyState('', expectedSlug, false, pageType, notes);
  }

  // Verify the expected game title + slug using existing safe page-verification
  // logic.  The reader does not duplicate URL/heading parsing.
  const { verifyGamePage } = await import('./page-reader.js');
  const verified = await verifyGamePage(page, expectedTitle, expectedSlug, { timeout });

  // Capture the visible title for diagnostics (separate from verification).
  const titleResult = await trySelectors(page, gameTitleStrategies, { visible: true, timeout });
  const visibleTitle = titleResult
    ? (normalizeVisibleText(await titleResult.locator.innerText().catch(() => null)) ?? '')
    : '';

  if (!verified) {
    notes.push('game-verification-failed');
    return emptyState(visibleTitle, expectedSlug, false, 'unknown', notes);
  }

  // Locate visible library regions.  More than one visible region is ambiguous.
  const regionCount = await countVisible(page, libraryRegionStrategies);
  if (regionCount === 0) {
    // Finding 2 — missing ownership region returns unknown/unsupported.
    notes.push('no-visible-library-region');
    return {
      game: { visibleTitle, slug: expectedSlug, verified },
      library: {
        membership: 'unknown',
        completeness: 'unsupported',
        ownershipEntries: [],
        addControl: 'absent',
      },
      status: { value: null, evidence: 'unknown' },
      diagnostics: {
        pageType: 'game',
        regionCount: 0,
        entryCount: 0,
        addControlCount: 0,
        notes,
      },
    };
  }

  if (regionCount > 1) {
    notes.push(`ambiguous-regions:${regionCount}`);
    return {
      game: { visibleTitle, slug: expectedSlug, verified },
      library: {
        membership: 'unknown',
        completeness: 'ambiguous',
        ownershipEntries: [],
        addControl: 'ambiguous',
      },
      status: { value: null, evidence: 'unknown' },
      diagnostics: {
        pageType: 'game',
        regionCount,
        entryCount: 0,
        addControlCount: 0,
        notes,
      },
    };
  }

  // Exactly one visible library region.  Scope all further reads to it.
  const regionResult = await trySelectors(page, libraryRegionStrategies, {
    visible: true,
    timeout,
  });
  if (!regionResult) {
    notes.push('region-result-unavailable');
    return emptyState(visibleTitle, expectedSlug, verified, 'game', notes);
  }
  const region = regionResult.locator;

  // -----------------------------------------------------------------------
  // Finding 3 — require exactly one visible ownership list within the region.
  // Finding 2 — absence of a recognized list is NOT a valid empty library;
  // only a recognized list with zero rows is a proven empty state.  Use
  // isRendered (not isVisible) so an empty <ul> still counts as a list.
  // -----------------------------------------------------------------------
  const lists = await collectRenderedLocators(region, ownershipEntriesListStrategies);
  const listCount = lists.length;
  if (listCount === 0) {
    // No recognized ownership list.  This is not a proven empty state — it is
    // an unrecognized structure (or generic membership).  Surface as
    // unsupported so the comparator returns `unknown`, never `change-needed`.
    notes.push('no-recognized-ownership-list');
    const genericMembershipCue = await trySelectorsInLocator(
      region,
      genericMembershipCueStrategies,
      { visible: true, timeout: 250 },
    );
    const membership: 'present' | 'unknown' = genericMembershipCue ? 'present' : 'unknown';
    if (genericMembershipCue) notes.push('generic-membership-without-detail');
    const addControlCount = await countActionableAddControls(region);
    return {
      game: { visibleTitle, slug: expectedSlug, verified },
      library: {
        membership,
        completeness: 'unsupported',
        ownershipEntries: [],
        addControl:
          addControlCount === 1 ? 'unique' : addControlCount === 0 ? 'absent' : 'ambiguous',
      },
      status: { value: null, evidence: 'unknown' },
      diagnostics: {
        pageType: 'game',
        regionCount,
        entryCount: 0,
        addControlCount,
        notes,
      },
    };
  }
  if (listCount > 1) {
    // Multiple visible ownership lists inside one region — ambiguous read.
    notes.push(`ambiguous-ownership-lists:${listCount}`);
    return {
      game: { visibleTitle, slug: expectedSlug, verified },
      library: {
        membership: 'unknown',
        completeness: 'ambiguous',
        ownershipEntries: [],
        addControl: 'ambiguous',
      },
      status: { value: null, evidence: 'unknown' },
      diagnostics: {
        pageType: 'game',
        regionCount,
        entryCount: 0,
        addControlCount: 0,
        notes,
      },
    };
  }

  // Exactly one recognized rendered ownership list.
  const list = lists[0];

  // Read every visible ownership row within the (single) list.
  const rows = await collectVisibleLocators(list, ownershipEntryStrategies);
  const ownershipEntries: { platform: string | null; ownershipType: string | null }[] = [];
  let rowAmbiguous = false;
  for (const row of rows) {
    // Finding 3 — require exactly one visible platform field and one visible
    // ownership-type field per row.  Multiple visible fields make the read
    // ambiguous (do not discard contradictory evidence).  Zero fields is a
    // partial row (missing field), not ambiguity.  Hidden duplicate fields
    // do not count (countVisible only counts visible elements).
    const platformFieldCount = await countVisible(row, platformFieldStrategies);
    const ownershipFieldCount = await countVisible(row, ownershipFieldStrategies);
    if (platformFieldCount > 1 || ownershipFieldCount > 1) {
      rowAmbiguous = true;
      ownershipEntries.push({ platform: null, ownershipType: null });
      continue;
    }
    // Finding 1 — read visible text only (innerText / selected option).  A
    // missing field (count 0) is recorded as null so the row is partial.
    const platformText =
      platformFieldCount === 1 ? await readFieldText(row, platformFieldStrategies) : null;
    const ownershipText =
      ownershipFieldCount === 1 ? await readFieldText(row, ownershipFieldStrategies) : null;
    ownershipEntries.push({ platform: platformText, ownershipType: ownershipText });
  }

  // Detect a generic library membership cue (no per-entry detail).
  const genericMembershipCue = await trySelectorsInLocator(region, genericMembershipCueStrategies, {
    visible: true,
    timeout: 250,
  });

  // Finding 1 (Phase 5B Slice 1) — before declaring a recognized ownership
  // list empty (which would lead to completeness='complete' and a potential
  // change-needed classification), prove the list has no rendered visible
  // child content.  A recognized list may contain visible ownership-like
  // content that is NOT a recognized row marker (e.g. `<li>Steam /
  // Digital</li>`).  innerText excludes hidden descendants and unselected
  // option text, so hidden <li>s (display:none) and similar are not counted
  // as visible child content.  If the list IS rendered and HAS visible text
  // but no recognized rows, the read is unsupported — the comparator must
  // return `unknown` (never `change-needed`).
  let hasUnrecognizedVisibleContent = false;
  if (!rowAmbiguous && ownershipEntries.length === 0) {
    const listVisibleText = await list.innerText().catch(() => '');
    if (listVisibleText.trim().length > 0) {
      hasUnrecognizedVisibleContent = true;
    }
  }

  // Classify completeness.
  let completeness: 'complete' | 'partial' | 'ambiguous' | 'unsupported';
  if (rowAmbiguous) {
    completeness = 'ambiguous';
    notes.push('ambiguous-row-fields');
  } else if (hasUnrecognizedVisibleContent) {
    // Recognized list with visible unrecognized child content.
    completeness = 'unsupported';
    notes.push('unrecognized-visible-list-content');
  } else if (ownershipEntries.length === 0 && genericMembershipCue) {
    completeness = 'unsupported';
    notes.push('generic-membership-without-detail');
  } else if (ownershipEntries.length === 0) {
    // Proven empty list (exactly one recognized list with zero rows AND no
    // visible unrecognized child content).  This is the only valid "empty
    // library" representation.
    completeness = 'complete';
  } else {
    const anyPartial = ownershipEntries.some(
      (e) => e.platform === null || e.ownershipType === null,
    );
    const anyDuplicate = hasDuplicateExact(ownershipEntries);
    if (anyDuplicate) {
      completeness = 'ambiguous';
      notes.push('duplicate-exact-entries');
    } else if (anyPartial) {
      completeness = 'partial';
      notes.push('partial-row');
    } else {
      completeness = 'complete';
    }
  }

  // Finding 5 — additive control must be an actionable button/link with the
  // expected accessible name.  Never clicked.
  const addControlCount = await countActionableAddControls(region);
  let addControl: 'unique' | 'absent' | 'ambiguous';
  if (addControlCount === 1) {
    addControl = 'unique';
  } else if (addControlCount === 0) {
    addControl = 'absent';
  } else {
    addControl = 'ambiguous';
    notes.push(`ambiguous-add-control:${addControlCount}`);
  }

  // Membership: present if any entries exist or a generic-membership cue is
  // visible; absent only for a proven empty list; unknown otherwise.
  let membership: 'present' | 'absent' | 'unknown';
  if (ownershipEntries.length > 0 || genericMembershipCue) {
    membership = 'present';
  } else if (completeness === 'complete') {
    membership = 'absent';
  } else {
    membership = 'unknown';
  }

  // -----------------------------------------------------------------------
  // Finding 4 — recheck blocker cues after ownership capture and immediately
  // before returning a supported state.  A delayed blocker overlay must not
  // allow a stale `change-needed` classification.
  // -----------------------------------------------------------------------
  if (await hasVisibleBlocker(page, timeout)) {
    notes.push('blocker-appeared-after-read');
    return emptyState(visibleTitle, expectedSlug, verified, 'unknown', notes);
  }

  return {
    game: { visibleTitle, slug: expectedSlug, verified },
    library: {
      membership,
      completeness,
      ownershipEntries,
      addControl,
    },
    status: { value: null, evidence: 'unknown' },
    diagnostics: {
      pageType: 'game',
      regionCount,
      entryCount: ownershipEntries.length,
      addControlCount,
      notes,
    },
  };
}

function hasDuplicateExact(
  entries: { platform: string | null; ownershipType: string | null }[],
): boolean {
  const seen = new Set<string>();
  for (const e of entries) {
    const key = `${e.platform ?? ''}|${e.ownershipType ?? ''}`;
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}
