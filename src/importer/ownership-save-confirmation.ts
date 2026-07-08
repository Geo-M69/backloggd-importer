import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { OwnershipSavePlan, SavePlanCandidate } from './ownership-save-plan.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConfirmationPromptItem {
  index: number; // 1-based stable index
  proposalId: string;
  steamAppId: number;
  gameTitle: string | null;
  backloggdSlug: string | null;
  backloggdUrl: string | null;
  desiredPlatform: string;
  desiredOwnershipType: string;
  proofSummary: string;
  proofCheckedAt: string;
}

export interface ConfirmationPrompt {
  sessionId: string;
  builtAt: string;
  items: ConfirmationPromptItem[];
  // Human-reviewable text: deterministic summary. Pure function output.
  text: string;
}

export type SelectionInput =
  { byProposalIds: string[] } | { byIndexes: number[] } | { selectAll: true };

export interface ApplyOptions {
  allowEmptySelection?: boolean;
}

export interface ConfirmedRecord {
  proposalId: string;
  importSessionId: string;
  steamAppId: number;
  confirmationBatchId: string;
  confirmedAt: string;
  plannedPlatform: string | null;
  plannedOwnershipType: string | null;
  plannedSlug: string | null;
  plannedAbsentCheckedAt: string | null;
}

export interface ApplyResult {
  confirmed: ConfirmedRecord[];
  alreadyConfirmed: string[];
  rejected: { proposalId: string; reason: string }[];
}

// ---------------------------------------------------------------------------
// Helpers (pure / duplicated parsing from planner to avoid cross-module
// coupling and to keep revalidation deterministic)
// ---------------------------------------------------------------------------

const RECONCILED_ABSENT_RE = /^reconciled:absent:(?<reason>.+):checkedAt=(?<checkedAt>.+)$/;
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

function parseAbsentProof(
  outcomeReason: string | null,
): { reason: string; checkedAt: string } | null {
  if (!outcomeReason) return null;
  const match = RECONCILED_ABSENT_RE.exec(outcomeReason);
  if (!match?.groups) return null;
  const reason = match.groups.reason.trim();
  const checkedAt = match.groups.checkedAt.trim();
  if (reason.length === 0) return null;
  if (reason.includes(':checkedAt=')) return null;
  if (!ISO_TIMESTAMP_RE.test(checkedAt)) return null;
  const parsed = new Date(checkedAt);
  if (Number.isNaN(parsed.getTime())) return null;
  if (parsed.toISOString() !== checkedAt) return null;
  return { reason, checkedAt };
}

function parseOwnershipPayload(
  frozenPayload: string | null,
): { platform: string; ownershipType: string } | null {
  if (!frozenPayload) return null;
  try {
    const parsed = JSON.parse(frozenPayload);
    if (typeof parsed.platform !== 'string' || typeof parsed.ownershipType !== 'string')
      return null;
    const platform = parsed.platform.trim();
    const ownershipType = parsed.ownershipType.trim();
    if (platform.length === 0 || ownershipType.length === 0) return null;
    return { platform, ownershipType };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

export function buildOwnershipConfirmationPrompt(plan: OwnershipSavePlan): ConfirmationPrompt {
  const builtAt = plan.builtAt;

  const items: ConfirmationPromptItem[] = plan.candidates.map((c, idx) => ({
    index: idx + 1,
    proposalId: c.proposalId,
    steamAppId: c.steamAppId,
    gameTitle: c.gameTitle,
    backloggdSlug: c.backloggdSlug,
    backloggdUrl: c.backloggdUrl,
    desiredPlatform: c.desiredPlatform,
    desiredOwnershipType: c.desiredOwnershipType,
    proofSummary: c.proofSummary,
    proofCheckedAt: c.proofCheckedAt,
  }));

  // Deterministic text summary: one line per item with stable index.
  const lines = items.map((it) => {
    const title = it.gameTitle ?? '<unknown title>';
    const slug = it.backloggdSlug ?? '<no-slug>';
    return [
      `[#${it.index}] proposal=${it.proposalId}`,
      `appid=${it.steamAppId}`,
      `title=${title}`,
      `url=${it.backloggdUrl ?? `https://backloggd.com/games/${slug}/`}`,
      `platform=${it.desiredPlatform}`,
      `ownership=${it.desiredOwnershipType}`,
      `absent-proof=${it.proofSummary}`,
      `checked-at=${it.proofCheckedAt}`,
    ].join(' | ');
  });

  // Add an explicit warning that no browser write has happened yet.
  const header = `Ownership save confirmation prompt for session ${plan.sessionId} — NO WRITES PERFORMED YET`;
  const text = [header, ...lines].join('\n');

  return { sessionId: plan.sessionId, builtAt, items, text };
}

// ---------------------------------------------------------------------------
// Apply selection (records confirmations in import_item_confirmations)
// ---------------------------------------------------------------------------

export function applyOwnershipConfirmationSelection(
  db: Database.Database,
  plan: OwnershipSavePlan,
  selection: SelectionInput,
  options?: ApplyOptions,
): ApplyResult {
  const allowEmpty = options?.allowEmptySelection ?? false;

  // Build lookup maps from plan
  const byProposal = new Map<string, SavePlanCandidate>();
  const byIndex = new Map<number, SavePlanCandidate>();
  plan.candidates.forEach((c, i) => {
    byProposal.set(c.proposalId, c);
    byIndex.set(i + 1, c);
  });

  let selectedProposalIds: string[] = [];

  if ('selectAll' in selection && selection.selectAll === true) {
    selectedProposalIds = plan.candidates.map((c) => c.proposalId);
  } else if ('byProposalIds' in selection) {
    const ids = selection.byProposalIds;
    if (!Array.isArray(ids)) throw new Error('byProposalIds must be an array');
    if (ids.length === 0 && !allowEmpty) throw new Error('empty selection not allowed');
    // Reject duplicates
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) throw new Error('duplicate proposal id in selection');
      seen.add(id);
      if (!byProposal.has(id)) throw new Error(`unknown proposal id: ${id}`);
    }
    selectedProposalIds = Array.from(ids);
  } else if ('byIndexes' in selection) {
    const idxs = selection.byIndexes;
    if (!Array.isArray(idxs)) throw new Error('byIndexes must be an array');
    if (idxs.length === 0 && !allowEmpty) throw new Error('empty selection not allowed');
    const seen = new Set<number>();
    for (const idx of idxs) {
      if (!Number.isInteger(idx)) throw new Error('index must be integer');
      if (seen.has(idx)) throw new Error('duplicate index in selection');
      seen.add(idx);
      const cand = byIndex.get(idx);
      if (!cand) throw new Error(`index out of range: ${idx}`);
      selectedProposalIds.push(cand.proposalId);
    }
  } else {
    throw new Error('invalid selection shape');
  }

  if (selectedProposalIds.length === 0 && !allowEmpty) {
    throw new Error('empty selection not allowed');
  }

  const confirmed: ConfirmedRecord[] = [];
  const alreadyConfirmed: string[] = [];
  const rejected: { proposalId: string; reason: string }[] = [];

  const batchId = randomUUID();
  const now = new Date().toISOString();

  const selectItemStmt = db.prepare(
    `SELECT proposal_id, import_session_id, steam_app_id, proposal_kind, frozen_payload, status, outcome_reason
     FROM import_items WHERE proposal_id = ?`,
  );
  const selectProposalStmt = db.prepare(
    `SELECT import_session_id, steam_app_id, proposal_kind, status, backloggd_slug
     FROM proposals WHERE id = ?`,
  );
  const selectConfirmationStmt = db.prepare(
    `SELECT id FROM import_item_confirmations WHERE proposal_id = ?`,
  );
  const insertConfirmationStmt = db.prepare(
    `INSERT INTO import_item_confirmations (
       proposal_id, import_session_id, confirmation_batch_id, confirmed_at,
       planned_platform, planned_ownership_type, planned_slug,
       planned_absent_checked_at, planned_payload, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed')`,
  );

  const insertTx = db.transaction((rows: { proposalId: string; rec: ConfirmedRecord }[]) => {
    for (const r of rows) {
      insertConfirmationStmt.run(
        r.proposalId,
        r.rec.importSessionId,
        r.rec.confirmationBatchId,
        r.rec.confirmedAt,
        r.rec.plannedPlatform,
        r.rec.plannedOwnershipType,
        r.rec.plannedSlug,
        r.rec.plannedAbsentCheckedAt,
        null,
      );
    }
  });

  const toInsert: { proposalId: string; rec: ConfirmedRecord }[] = [];

  for (const pid of selectedProposalIds) {
    const candidate = byProposal.get(pid);
    if (!candidate) {
      // Candidate was not part of the supplied plan — treat as invalid selection
      rejected.push({ proposalId: pid, reason: 'not_in_plan' });
      continue;
    }

    // Revalidation: import item exists
    const itemRow = selectItemStmt.get(pid) as
      | {
          proposal_id: string;
          import_session_id: string;
          steam_app_id: number;
          proposal_kind: string;
          frozen_payload: string | null;
          status: string;
          outcome_reason: string | null;
        }
      | undefined;

    if (!itemRow) {
      rejected.push({ proposalId: pid, reason: 'import_item_missing' });
      continue;
    }

    if (itemRow.status !== 'approved') {
      rejected.push({ proposalId: pid, reason: `import_item_status_${itemRow.status}` });
      continue;
    }

    if (itemRow.proposal_kind !== 'ownership') {
      rejected.push({ proposalId: pid, reason: 'import_item_not_ownership' });
      continue;
    }

    // Canonical proposal checks
    const canonical = selectProposalStmt.get(pid) as
      | {
          import_session_id: string;
          steam_app_id: number;
          proposal_kind: string;
          status: string;
          backloggd_slug: string | null;
        }
      | undefined;

    if (!canonical) {
      rejected.push({ proposalId: pid, reason: 'missing_canonical_proposal' });
      continue;
    }

    if (canonical.import_session_id !== plan.sessionId) {
      rejected.push({ proposalId: pid, reason: 'canonical_session_mismatch' });
      continue;
    }

    if (canonical.steam_app_id !== candidate.steamAppId) {
      rejected.push({ proposalId: pid, reason: 'canonical_steam_appid_mismatch' });
      continue;
    }

    if (itemRow.steam_app_id !== candidate.steamAppId) {
      rejected.push({ proposalId: pid, reason: 'canonical_steam_appid_mismatch' });
      continue;
    }

    if (canonical.proposal_kind !== 'ownership') {
      rejected.push({ proposalId: pid, reason: 'canonical_kind_mismatch' });
      continue;
    }

    if (canonical.status !== 'approved') {
      rejected.push({ proposalId: pid, reason: 'canonical_status_not_approved' });
      continue;
    }

    const canonicalSlug = (canonical.backloggd_slug ?? '').trim();
    if (canonicalSlug.length === 0 || canonicalSlug !== (candidate.backloggdSlug ?? '').trim()) {
      rejected.push({ proposalId: pid, reason: 'canonical_slug_mismatch' });
      continue;
    }

    // Frozen payload check
    const parsedPayload = parseOwnershipPayload(itemRow.frozen_payload);
    if (!parsedPayload) {
      rejected.push({ proposalId: pid, reason: 'frozen_payload_malformed' });
      continue;
    }
    if (
      parsedPayload.platform !== candidate.desiredPlatform ||
      parsedPayload.ownershipType !== candidate.desiredOwnershipType
    ) {
      rejected.push({ proposalId: pid, reason: 'frozen_payload_mismatch' });
      continue;
    }

    // Absent proof check
    const parsedProof = parseAbsentProof(itemRow.outcome_reason);
    if (!parsedProof) {
      rejected.push({ proposalId: pid, reason: 'absent_proof_missing_or_invalid' });
      continue;
    }
    if (
      parsedProof.reason !== candidate.proofSummary ||
      parsedProof.checkedAt !== candidate.proofCheckedAt
    ) {
      rejected.push({ proposalId: pid, reason: 'absent_proof_reason_or_checked_at_mismatch' });
      continue;
    }

    // Ensure not already confirmed
    const exists = selectConfirmationStmt.get(pid) as { id: number } | undefined;
    if (exists) {
      alreadyConfirmed.push(pid);
      continue;
    }

    // Prepare record for insertion
    const rec: ConfirmedRecord = {
      proposalId: pid,
      importSessionId: itemRow.import_session_id,
      steamAppId: itemRow.steam_app_id,
      confirmationBatchId: batchId,
      confirmedAt: now,
      plannedPlatform: parsedPayload.platform,
      plannedOwnershipType: parsedPayload.ownershipType,
      plannedSlug: canonicalSlug,
      plannedAbsentCheckedAt: parsedProof.checkedAt,
    };

    toInsert.push({ proposalId: pid, rec });
    confirmed.push(rec);
  }

  if (toInsert.length > 0) {
    insertTx(toInsert);
  }

  return { confirmed, alreadyConfirmed, rejected };
}

export default null;
