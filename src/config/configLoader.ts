import {z} from 'zod';
import {configSchema, type Config} from './configSchema';
import dotenv from 'dotenv';
import dotenvExpand from 'dotenv-expand';

dotenvExpand.expand(dotenv.config());

function loadConfig(): Config {
  const config = {
    env: process.env.NODE_ENV,
    postgres: {
      connectionString: process.env.DB_CONNECTION_STRING,
      changeDetection: {
        schemas: process.env.DB_SCHEMAS?.split(','),
        pollingInterval: process.env.DB_POLLING_INTERVAL
          ? parseInt(process.env.DB_POLLING_INTERVAL, 10)
          : undefined,
      },
    },
    meiliSearch: {
      host: process.env.MEILISEARCH_HOST,
      apiKey: process.env.MEILISEARCH_API_KEY,
      timeout: process.env.MEILISEARCH_TIMEOUT
        ? parseInt(process.env.MEILISEARCH_TIMEOUT, 10)
        : undefined,
    },
    logging: {
      level: process.env.LOG_LEVEL,
      format: process.env.LOG_FORMAT,
      destination: process.env.LOG_DESTINATION,
      filename: process.env.LOG_FILE,
    },
  };

  try {
    return configSchema.parse(config);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const details = error.errors
        .map(err => `${err.path.join('.')}: ${err.message}`)
        .join('\n');

      throw new Error(`Invalid configuration:\n${details}`);
    }

    throw error;
  }
}

// Singleton config instance
export const config = loadConfig();

export function validateEnvFile(envPath: string): void {
  require('dotenv').config({path: envPath});
  loadConfig();
}
