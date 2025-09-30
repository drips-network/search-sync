import {z} from 'zod';

export const ALLOWED_DB_SCHEMAS = [
  'sepolia',
  'mainnet',
  'filecoin',
  'optimism',
  'metis',
  'localtestnet',
] as const;
export type DbSchema = (typeof ALLOWED_DB_SCHEMAS)[number];

export const postgresConfigSchema = z.object({
  connectionString: z.string(),
  changeDetection: z.object({
    schemas: z.array(z.enum(ALLOWED_DB_SCHEMAS)),
    pollingInterval: z.number().int().positive().default(30000), // 5 minutes. Specific to current - polling - strategy.
  }),
});

export const meiliSearchConfigSchema = z.object({
  host: z.string().url(),
  apiKey: z.string().min(1),
  timeout: z.number().positive().default(5000),
});

export const loggingConfigSchema = z.object({
  level: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  format: z.enum(['json', 'pretty']).default('json'),
  destination: z.enum(['console', 'file']).default('console'),
  filename: z.string().optional(),
});

export const healthConfigSchema = z.object({
  enabled: z.boolean().default(true),
  host: z.string().default('0.0.0.0'),
  port: z.number().int().positive().default(3000),
});

export const configSchema = z.object({
  nodeEnv: z.enum(['development', 'test', 'production']).default('development'),
  port: z.number().int().positive().default(3000),
  postgres: postgresConfigSchema,
  meiliSearch: meiliSearchConfigSchema,
  logging: loggingConfigSchema,
  health: healthConfigSchema,
});

export type PostgresConfig = z.infer<typeof postgresConfigSchema>;
export type MeiliSearchConfig = z.infer<typeof meiliSearchConfigSchema>;
export type LoggingConfig = z.infer<typeof loggingConfigSchema>;
export type HealthConfig = z.infer<typeof healthConfigSchema>;
export type Config = z.infer<typeof configSchema>;
