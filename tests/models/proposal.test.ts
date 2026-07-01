import { describe, it, expect } from 'vitest';
import { createProposal } from '../../src/models/proposal.js';

describe('createProposal', () => {
  it('creates a pending ownership proposal', () => {
    const proposal = createProposal({
      id: '123e4567-e89b-12d3-a456-426614174000',
      importSessionId: 'session-1',
      steamAppId: 730,
      igdbId: 12345,
      backloggdSlug: 'counter-strike-2',
      proposalKind: 'ownership',
      matchConfidence: 'exact',
    });

    expect(proposal.id).toBe('123e4567-e89b-12d3-a456-426614174000');
    expect(proposal.status).toBe('pending');
    expect(proposal.proposalKind).toBe('ownership');
    expect(proposal.requiresManualReview).toBe(false);
    expect(proposal.suggestedPayload).toBeNull();
    expect(proposal.notes).toBeNull();
    expect(proposal.decisionNotes).toBeNull();
    expect(proposal.createdAt).toBeTruthy();
    expect(proposal.updatedAt).toBe(proposal.createdAt);
  });

  it('accepts optional fields', () => {
    const proposal = createProposal({
      id: 'id-2',
      importSessionId: 'session-1',
      steamAppId: 730,
      igdbId: null,
      backloggdSlug: null,
      proposalKind: 'status',
      matchConfidence: 'unmatched',
      requiresManualReview: true,
      suggestedPayload: JSON.stringify({ suggestion: 'none' }),
      notes: 'Unmatched game',
      decisionNotes: 'User skipped',
    });

    expect(proposal.igdbId).toBeNull();
    expect(proposal.backloggdSlug).toBeNull();
    expect(proposal.proposalKind).toBe('status');
    expect(proposal.requiresManualReview).toBe(true);
    expect(proposal.suggestedPayload).toBe('{"suggestion":"none"}');
    expect(proposal.notes).toBe('Unmatched game');
    expect(proposal.decisionNotes).toBe('User skipped');
  });

  it('allows null igdbId and backloggdSlug for unmatched games', () => {
    const proposal = createProposal({
      id: 'id-3',
      importSessionId: 'session-1',
      steamAppId: 999999,
      igdbId: null,
      backloggdSlug: null,
      proposalKind: 'ownership',
      matchConfidence: 'unmatched',
    });

    expect(proposal.igdbId).toBeNull();
    expect(proposal.backloggdSlug).toBeNull();
  });
});
