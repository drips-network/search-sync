import {z} from 'zod';

export const ALLOWED_DB_SCHEMAS = ['sepolia', 'mainnet', 'filecoin'] as const;

export const postgresConfigSchema = z.object({
  connection: z.object({
    host: z.string().min(1),
    port: z.number().int().positive().default(5432),
    database: z.string().min(1),
    user: z.string().min(1),
    password: z.string().min(1),
  }),
  changeDetection: z.object({
    schema: z.enum(ALLOWED_DB_SCHEMAS),
    batchSize: z.number().int().positive().default(1000),
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

export const configSchema = z.object({
  nodeEnv: z.enum(['development', 'test', 'production']).default('development'),
  port: z.number().int().positive().default(3000),
  postgres: postgresConfigSchema,
  meiliSearch: meiliSearchConfigSchema,
  logging: loggingConfigSchema,
});

export type PostgresConfig = z.infer<typeof postgresConfigSchema>;
export type MeiliSearchConfig = z.infer<typeof meiliSearchConfigSchema>;
export type LoggingConfig = z.infer<typeof loggingConfigSchema>;
export type Config = z.infer<typeof configSchema>;
