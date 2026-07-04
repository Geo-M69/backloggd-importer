/**
 * Backloggd interaction module — Milestone 4 proof of concept.
 */

export { loadManifest, ManifestValidationError } from './manifest-loader.js';
export { selectItems, type SelectedItem, type SelectionOptions } from './item-selector.js';
export {
  buildDiagnostic,
  writeDiagnostics,
  redactSensitive,
  sanitizeUrl,
  type DiagnosticEntry,
} from './diagnostics.js';
export {
  launchSession,
  promptForLogin,
  detectLoginState,
  processItem,
  runPocSession,
  installWriteGuard,
  enableRenderEditorAllowance,
  disableRenderEditorAllowance,
  revealEditor,
  revealLogOrReviewModal,
  checkLoginAfterPrompt,
  type PocResult,
  type PocSessionOptions,
  type PocSessionRunOptions,
} from './browser.js';
export { readPageState, verifyGamePage, getAttemptedSelectors } from './page-reader.js';
export {
  trySelectors,
  trySelectorsInLocator,
  strategyNames,
  gameTitleStrategies,
  addToLibraryStrategies,
  platformSelectStrategies,
  ownershipTypeStrategies,
  ownershipLabelStrategies,
  ownershipTriggerAccessibleStrategies,
  ownershipTriggerNearbyExactStrategies,
  ownershipTriggerNearbyUniqueStrategies,
  ownershipValueStrategies,
  ownershipOptionStrategies,
  ownershipOpenPopupStrategies,
  statusSelectStrategies,
  saveButtonStrategies,
  loginCueStrategies,
  loggedInCueStrategies,
  openerStrategies,
  logOrReviewOpenerStrategies,
  editorRegionStrategies,
  logModalExpectedCuesStrategies,
  modalTabStrategies,
  detailsPanelCueStrategies,
  createLogButtonStrategies,
  fullEditorStrategies,
  statusButtonStrategies,
  forbiddenControlStrategies,
  FORBIDDEN_OPENER_TERMS,
  textContainsForbiddenTerm,
  type SelectorStrategy,
} from './selectors.js';
