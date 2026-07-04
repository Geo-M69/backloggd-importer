/**
 * Sanitized diagnostics for Milestone 4 selector/page failures.
 *
 * Writes JSON diagnostics that never include passwords, cookies, tokens,
 * CSRF values, hidden auth fields, full HTML, screenshots, or raw bodies.
 */

import { writeFile } from 'node:fs/promises';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export interface DiagnosticEntry {
  timestamp: string;
  step: string;
  sanitizedUrl: string;
  sessionId?: string;
  steamAppId?: number;
  backloggdSlug?: string;
  attemptedSelectors: string[];
  errorMessage: string;
}

const SENSITIVE_PATTERNS = [
  // Key=value patterns (colon or equals separator)
  /password[=:]\S+/gi,
  /token[=:]\S+/gi,
  /cookie[=:]\S+/gi,
  /csrf[=:]\S+/gi,
  /auth[=:]\S+/gi,
  /bearer\s+\S+/gi,
  /session[_-]?id[=:]\S+/gi,

  // Header-style patterns — consume the full value after the colon
  /Set-Cookie\s*:\s*.+/gi,
  /Authorization\s*:\s*.+/gi,

  // JSON quoted-key patterns:  "key":"value"
  /"(?:token|csrf|cookie|password|session|auth)"\s*[:=]\s*"[^"]+"/gi,
  /'(?:token|csrf|cookie|password|session|auth)'\s*[:=]\s*'[^']+'/gi,
];

/**
 * Redact strings that look like credentials or tokens.
 */
export function redactSensitive(input: string): string {
  let result = input;
  for (const pattern of SENSITIVE_PATTERNS) {
    result = result.replace(pattern, '[REDACTED]');
  }
  return result;
}

/**
 * Sanitize a URL to origin + path only, stripping query and hash.
 */
export function sanitizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '[invalid-url]';
  }
}

/**
 * Build a sanitized diagnostic entry.
 */
export function buildDiagnostic(data: {
  step: string;
  url: string;
  sessionId?: string;
  steamAppId?: number;
  backloggdSlug?: string;
  attemptedSelectors: string[];
  error: Error | string;
}): DiagnosticEntry {
  const errorMessage =
    typeof data.error === 'string' ? data.error : (data.error.message ?? 'Unknown error');

  return {
    timestamp: new Date().toISOString(),
    step: data.step,
    sanitizedUrl: sanitizeUrl(data.url),
    sessionId: data.sessionId,
    steamAppId: data.steamAppId,
    backloggdSlug: data.backloggdSlug,
    attemptedSelectors: data.attemptedSelectors,
    errorMessage: redactSensitive(errorMessage),
  };
}

/**
 * Write diagnostics to a JSON file in the configured diagnostics directory.
 */
export async function writeDiagnostics(
  diagDir: string,
  entries: DiagnosticEntry[],
): Promise<string> {
  await mkdir(diagDir, { recursive: true });
  const fileName = `backloggd-poc-diagnostics-${Date.now()}.json`;
  const filePath = join(diagDir, fileName);
  const payload = {
    generatedAt: new Date().toISOString(),
    entryCount: entries.length,
    entries,
  };
  await writeFile(filePath, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
  return filePath;
}
