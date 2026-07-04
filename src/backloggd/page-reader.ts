/**
 * Read visible ownership and status information from a Backloggd game page.
 *
 * Uses only visible DOM text and form values — never cookies, localStorage,
 * hidden fields, or private endpoints.
 */

import type { Page } from 'playwright';
import {
  trySelectors,
  gameTitleStrategies,
  platformSelectStrategies,
  ownershipTypeStrategies,
  statusSelectStrategies,
  strategyNames,
} from './selectors.js';

export interface PageState {
  pageTitle: string;
  currentPlatform: string | null;
  currentOwnershipType: string | null;
  currentStatus: string | null;
  saveButtonVisible: boolean;
}

/**
 * Read the current visible state of a Backloggd game page.
 */
export async function readPageState(
  page: Page,
  options: { timeout?: number } = {},
): Promise<PageState> {
  const timeout = options.timeout;
  const pageTitle = await page.title();

  const platformResult = await trySelectors(page, platformSelectStrategies, {
    visible: true,
    timeout,
  });
  const currentPlatform = platformResult
    ? await platformResult.locator.inputValue().catch(() => null)
    : null;

  const ownershipResult = await trySelectors(page, ownershipTypeStrategies, {
    visible: true,
    timeout,
  });
  const currentOwnershipType = ownershipResult
    ? await ownershipResult.locator.inputValue().catch(() => null)
    : null;

  const statusResult = await trySelectors(page, statusSelectStrategies, { visible: true, timeout });
  const currentStatus = statusResult
    ? await statusResult.locator.inputValue().catch(() => null)
    : null;

  // Check if any save/submit/update button is visible (detect, never click)
  const saveLocator = page.locator(
    'button:has-text("Save"), button:has-text("Submit"), button:has-text("Update")',
  );
  const saveButtonVisible = await saveLocator.isVisible().catch(() => false);

  return {
    pageTitle,
    currentPlatform,
    currentOwnershipType,
    currentStatus,
    saveButtonVisible,
  };
}

/**
 * Verify the page appears to match the expected game.
 *
 * Checks:
 * 1. The current URL's path segments contain the expected slug as
 *    an exact normalized path segment.  For file:// fixture URLs only,
 *    the slug may also match the fixture filename `slug.html`.
 *    Query strings and hashes are ignored.
 * 2. Visible title (via centralized accessible heading strategies)
 *    is an exact (case-insensitive) match for the expected title.
 * Both conditions must pass.
 */
export async function verifyGamePage(
  page: Page,
  expectedTitle: string,
  expectedSlug: string,
  options: { timeout?: number } = {},
): Promise<boolean> {
  const currentUrl = page.url();

  const slugLower = expectedSlug.toLowerCase();
  let parsed: URL;
  try {
    parsed = new URL(currentUrl);
  } catch {
    return false;
  }

  const pathSegments: string[] = parsed.pathname.split('/').filter((s) => s.length > 0);
  const isLocalFixture = parsed.protocol === 'file:';
  const urlOk = pathSegments.some((seg) => {
    const segLower = seg.toLowerCase();
    if (isLocalFixture) {
      // file:// fixture URLs allow exact segment or slug.html only.
      // All other prefix forms (slug.json, slug.backup.html, etc.) are rejected.
      return segLower === slugLower || segLower === slugLower + '.html';
    }
    // HTTP(S) and all other URLs: require exact path segment match only.
    // Never accept slug.*, slug-extra, or other prefix/substring forms.
    return segLower === slugLower;
  });
  if (!urlOk) return false;

  // Visible heading via centralized accessible strategies
  const titleResult = await trySelectors(page, gameTitleStrategies, {
    visible: true,
    timeout: options.timeout ?? 3000,
  });
  const heading = titleResult ? ((await titleResult.locator.textContent()) ?? '') : '';
  const headingNormalized = heading.trim().toLowerCase();
  const expectedNormalized = expectedTitle.trim().toLowerCase();

  return headingNormalized === expectedNormalized;
}

/**
 * Get the list of selector names attempted for diagnostics.
 */
export function getAttemptedSelectors(): string[] {
  return [
    ...strategyNames(platformSelectStrategies),
    ...strategyNames(ownershipTypeStrategies),
    ...strategyNames(statusSelectStrategies),
  ];
}
