import { describe, it, expect } from 'vitest';
import { createImportSession } from '../../src/models/import-session.js';

describe('createImportSession', () => {
  it('creates a new in-progress session', () => {
    const session = createImportSession({
      id: 'session-1',
      totalGames: 100,
    });

    expect(session.id).toBe('session-1');
    expect(session.status).toBe('in-progress');
    expect(session.totalGames).toBe(100);
    expect(session.completedAt).toBeNull();
    expect(session.matchedGames).toBe(0);
    expect(session.proposedChanges).toBe(0);
    expect(session.approvedChanges).toBe(0);
    expect(session.appliedChanges).toBe(0);
    expect(session.skippedGames).toBe(0);
    expect(session.failedGames).toBe(0);
    expect(session.startedAt).toBeTruthy();
  });

  it('handles zero total games', () => {
    const session = createImportSession({
      id: 'empty-session',
      totalGames: 0,
    });
    expect(session.totalGames).toBe(0);
  });

  it('accepts optional policyJson', () => {
    const session = createImportSession({
      id: 'session-policy',
      totalGames: 50,
      policyJson: JSON.stringify({ playtimeThresholdMinutes: 120 }),
    });
    expect(session.policyJson).toBe('{"playtimeThresholdMinutes":120}');
  });

  it('defaults policyJson to null when omitted', () => {
    const session = createImportSession({
      id: 'session-no-policy',
      totalGames: 10,
    });
    expect(session.policyJson).toBeNull();
  });
});
