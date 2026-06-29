import { describe, it, expect } from 'vitest';
import { loadConfig, envSchema } from '../../src/config/index.js';

describe('config', () => {
  describe('envSchema', () => {
    it('validates a complete set of environment variables', () => {
      const result = envSchema.safeParse({
        STEAM_API_KEY: 'abc123',
        STEAM_USER_ID: '76561197960287930',
        IGDB_CLIENT_ID: 'client123',
        IGDB_CLIENT_SECRET: 'secret456',
      });
      expect(result.success).toBe(true);
    });

    it('rejects missing variables', () => {
      const result = envSchema.safeParse({});
      expect(result.success).toBe(false);
      if (!result.success) {
        const fields = result.error.issues.map((i) => i.path.join('.'));
        expect(fields).toContain('STEAM_API_KEY');
        expect(fields).toContain('STEAM_USER_ID');
      }
    });

    it('rejects empty strings', () => {
      const result = envSchema.safeParse({
        STEAM_API_KEY: '',
        STEAM_USER_ID: 'valid',
        IGDB_CLIENT_ID: 'valid',
        IGDB_CLIENT_SECRET: 'valid',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('loadConfig', () => {
    it('returns a typed config object when env is complete', () => {
      const config = loadConfig({
        STEAM_API_KEY: 'key',
        STEAM_USER_ID: 'id',
        IGDB_CLIENT_ID: 'cid',
        IGDB_CLIENT_SECRET: 'cs',
      });
      expect(config.STEAM_API_KEY).toBe('key');
      expect(config.STEAM_USER_ID).toBe('id');
      expect(config.IGDB_CLIENT_ID).toBe('cid');
      expect(config.IGDB_CLIENT_SECRET).toBe('cs');
    });

    it('throws on missing variables', () => {
      expect(() => loadConfig({})).toThrow('Configuration validation failed');
    });
  });
});
