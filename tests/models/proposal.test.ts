import { describe, it, expect } from 'vitest';
import { createProposal } from '../../src/models/proposal.js';

describe('createProposal', () => {
  it('creates a pending proposal', () => {
    const proposal = createProposal({
      id: '123e4567-e89b-12d3-a456-426614174000',
      importSessionId: 'session-1',
      steamAppId: 730,
      igdbId: 12345,
      backloggdSlug: 'counter-strike-2',
      action: 'add-ownership',
      matchConfidence: 'exact',
    });

    expect(proposal.id).toBe('123e4567-e89b-12d3-a456-426614174000');
    expect(proposal.status).toBe('pending');
    expect(proposal.action).toBe('add-ownership');
    expect(proposal.notes).toBeNull();
    expect(proposal.createdAt).toBeTruthy();
    expect(proposal.updatedAt).toBe(proposal.createdAt);
  });

  it('accepts optional notes', () => {
    const proposal = createProposal({
      id: 'id-2',
      importSessionId: 'session-1',
      steamAppId: 730,
      igdbId: 12345,
      backloggdSlug: 'counter-strike-2',
      action: 'mark-played',
      matchConfidence: 'exact',
      notes: 'User confirmed',
    });

    expect(proposal.notes).toBe('User confirmed');
  });
});
