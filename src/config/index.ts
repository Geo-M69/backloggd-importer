import { z } from 'zod';

/**
 * Environment variable schema for runtime validation.
 */
export const envSchema = z.object({
  STEAM_API_KEY: z.string().min(1, 'Steam API key is required'),
  STEAM_USER_ID: z.string().min(1, 'Steam user ID is required'),
  IGDB_CLIENT_ID: z.string().min(1, 'IGDB client ID is required'),
  IGDB_CLIENT_SECRET: z.string().min(1, 'IGDB client secret is required'),
});

export type Config = z.infer<typeof envSchema>;

/**
 * Load and validate configuration from process.env.
 * Call dotenv expand before this if using a .env file.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const missing = result.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`Configuration validation failed: missing or invalid variables: ${missing}`);
  }
  return result.data;
}
