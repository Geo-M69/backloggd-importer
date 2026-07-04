import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  redactSensitive,
  sanitizeUrl,
  buildDiagnostic,
  writeDiagnostics,
} from '../../src/backloggd/diagnostics.js';

describe('diagnostics', () => {
  describe('redactSensitive', () => {
    it('redacts password values', () => {
      const input = 'Error: password=secret123 in request';
      expect(redactSensitive(input)).toBe('Error: [REDACTED] in request');
    });

    it('redacts token values', () => {
      const input = 'token:abc123.def456';
      expect(redactSensitive(input)).toBe('[REDACTED]');
    });

    it('redacts cookie values', () => {
      const input = 'cookie:session=xyz';
      expect(redactSensitive(input)).toBe('[REDACTED]');
    });

    it('redacts csrf values', () => {
      const input = 'csrf=token123';
      expect(redactSensitive(input)).toBe('[REDACTED]');
    });

    it('redacts bearer tokens', () => {
      const input = 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9';
      const result = redactSensitive(input);
      expect(result).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
      expect(result).toContain('[REDACTED]');
    });

    it('leaves safe messages unchanged', () => {
      const input = 'Selector not found: button:has-text("Save")';
      expect(redactSensitive(input)).toBe(input);
    });

    it('redacts Set-Cookie header values', () => {
      const input = 'Set-Cookie: sid=abc123; HttpOnly';
      expect(redactSensitive(input)).not.toContain('sid=abc123');
      expect(redactSensitive(input)).toContain('[REDACTED]');
    });

    it('redacts Authorization header values', () => {
      const input = 'Authorization: Bearer some-jwt-token-here';
      const result = redactSensitive(input);
      expect(result).not.toContain('some-jwt-token-here');
      expect(result).not.toContain('Bearer');
      expect(result).toContain('[REDACTED]');
    });

    it('redacts lowercase authorization: token with full secret value', () => {
      const input = 'authorization: token abc123';
      const result = redactSensitive(input);
      // The raw secret value must not remain in the output
      expect(result).not.toContain('abc123');
      expect(result).not.toContain('token');
      expect(result).toContain('[REDACTED]');
    });

    it('redacts Set-Cookie full value including Path and HttpOnly', () => {
      const input = 'Set-Cookie: sid=xyz; Path=/; HttpOnly';
      const result = redactSensitive(input);
      // The raw cookie value must not remain
      expect(result).not.toContain('sid=xyz');
      // Result should contain at least one [REDACTED]
      expect(result).toContain('[REDACTED]');
    });

    it('redacts JSON quoted token keys', () => {
      const input = 'Response contained "token":"secret_value_123"';
      expect(redactSensitive(input)).not.toContain('secret_value_123');
      expect(redactSensitive(input)).toContain('[REDACTED]');
    });

    it('redacts JSON quoted csrf keys', () => {
      const input = 'Body had "csrf":"abc-def-ghi"';
      expect(redactSensitive(input)).not.toContain('abc-def-ghi');
    });

    it('redacts JSON quoted cookie keys', () => {
      const input = 'Found "cookie":"session_token"';
      expect(redactSensitive(input)).not.toContain('session_token');
    });

    it('redacts JSON quoted password keys', () => {
      const input = 'Error: "password":"hunter2"';
      expect(redactSensitive(input)).not.toContain('hunter2');
    });

    it('redacts JSON quoted session keys', () => {
      const input = 'Session: "session":"abc123"';
      expect(redactSensitive(input)).not.toContain('abc123');
    });

    it('redacts single-quoted JSON-like keys', () => {
      const input = "Token: 'token':'xyz789'";
      expect(redactSensitive(input)).not.toContain('xyz789');
    });
  });

  describe('sanitizeUrl', () => {
    it('strips query and hash from URLs', () => {
      expect(sanitizeUrl('https://www.backloggd.com/games/cs2/?foo=bar#section')).toBe(
        'https://www.backloggd.com/games/cs2/',
      );
    });

    it('returns invalid-url marker for malformed input', () => {
      expect(sanitizeUrl('not-a-url')).toBe('[invalid-url]');
    });

    it('preserves origin and path only', () => {
      expect(sanitizeUrl('https://backloggd.com/games/game-123/')).toBe(
        'https://backloggd.com/games/game-123/',
      );
    });
  });

  describe('buildDiagnostic', () => {
    it('builds a sanitized diagnostic entry', () => {
      const entry = buildDiagnostic({
        step: 'verify-game-page',
        url: 'https://www.backloggd.com/games/cs2/?token=secret',
        sessionId: 'sess-123',
        steamAppId: 730,
        backloggdSlug: 'cs2',
        attemptedSelectors: ['heading-role'],
        error: new Error('Page title mismatch'),
      });

      expect(entry.step).toBe('verify-game-page');
      expect(entry.sanitizedUrl).toBe('https://www.backloggd.com/games/cs2/');
      expect(entry.sessionId).toBe('sess-123');
      expect(entry.steamAppId).toBe(730);
      expect(entry.backloggdSlug).toBe('cs2');
      expect(entry.attemptedSelectors).toEqual(['heading-role']);
      expect(entry.errorMessage).toBe('Page title mismatch');
      expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('redacts sensitive strings in error messages', () => {
      const entry = buildDiagnostic({
        step: 'process-item',
        url: 'https://backloggd.com/games/cs2/',
        attemptedSelectors: [],
        error: 'Network error: cookie=session-abc123',
      });

      expect(entry.errorMessage).toBe('Network error: [REDACTED]');
    });
  });

  describe('writeDiagnostics', () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await mkdtemp(join(tmpdir(), 'backloggd-diag-test-'));
    });

    afterEach(async () => {
      await rm(tempDir, { recursive: true, force: true });
    });

    it('writes diagnostics to a JSON file', async () => {
      const entries = [
        buildDiagnostic({
          step: 'test-step',
          url: 'https://backloggd.com/games/test/',
          attemptedSelectors: ['a', 'b'],
          error: 'Test error',
        }),
      ];

      const path = await writeDiagnostics(tempDir, entries);
      const content = await readFile(path, 'utf-8');
      const parsed = JSON.parse(content);

      expect(parsed.entryCount).toBe(1);
      expect(parsed.entries[0].step).toBe('test-step');
      expect(parsed.generatedAt).toBeDefined();
    });
  });
});
