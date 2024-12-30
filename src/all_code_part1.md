## ./main.ts

```typescript
/* eslint-disable n/no-process-exit */
import {Pool} from 'pg';
import {createMeiliSearchSynchronizer} from './synchronizer/meilisearch/createMeiliSearchSynchronizer';
import MeiliSearch from 'meilisearch';
import {createPollingChangeDetection} from './synchronizer/meilisearch/changeDetection/createPollingChangeDetection';
import {logger} from './logger';
import * as winston from 'winston';
import {Synchronizer} from './synchronizer/types';
import express, {Request, Response} from 'express';
import {Server} from 'http';
import {config} from './config/configLoader';

async function initializeApp() {
  const app = express();
  const pool = new Pool(config.postgres.connection);

  const changeDetection = createPollingChangeDetection(
    pool,
    logger,
    config.postgres.changeDetection,
  );

  const synchronizer = createMeiliSearchSynchronizer(
    new MeiliSearch({
      host: config.meiliSearch.host,
      apiKey: config.meiliSearch.apiKey,
      timeout: config.meiliSearch.timeout,
    }),
    changeDetection,
    logger,
  );

  app.get('/health', async (_req: Request, res: Response) => {
    const isHealthy = await synchronizer.isHealthy();

    res
      .status(isHealthy ? 200 : 503)
      .json({status: isHealthy ? 'ok' : 'unhealthy'});
  });

  const server = app.listen(config.port, () => {
    logger.info(`HTTP server listening on port ${config.port}`);
  });

  return {pool, synchronizer, server};
}

async function main() {
  logger.info('Starting application... 🚀', {metadata: {env: config.env}});

  const {pool, synchronizer, server} = await initializeApp();

  registerShutdownHandlers(pool, synchronizer, logger, server);

  if (!(await synchronizer.isHealthy())) {
    logger.error('Synchronizer is unhealthy, exiting...');

    await shutdown(pool, synchronizer, 'UNHEALTHY', logger);

    return;
  }

  try {
    await synchronizer.start();
  } catch (error) {
    logger.error('Failed to start sync process:', error as Error);
    await shutdown(pool, synchronizer, 'STARTUP_ERROR', logger);
  }
}

async function shutdown(
  pool: Pool,
  synchronizer: Synchronizer,
  signal: string,
  logger: winston.Logger,
  server?: Server,
) {
  logger.info(`${signal} received, starting graceful shutdown...`);

  try {
    await synchronizer.stop();
    await pool.end();
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((err: Error | undefined) =>
          err ? reject(err) : resolve(),
        );
      });
    }

    logger.info('Graceful shutdown completed.');
    process.exitCode = 0;
  } catch (error) {
    logger.error('Error during shutdown.', error as Error);
    process.exitCode = 1;
  }
}

function registerShutdownHandlers(
  pool: Pool,
  synchronizer: Synchronizer,
  logger: winston.Logger,
  server: Server,
) {
  ['SIGTERM', 'SIGINT'].forEach(signal => {
    process.once(signal, () =>
      shutdown(pool, synchronizer, signal, logger, server),
    );
  });
}

process.on('unhandledRejection', error => {
  logger.error('Unhandled rejection:', error as Error);
  process.exit(1);
});

process.on('uncaughtException', error => {
  logger.error('Uncaught exception:', error as Error);
  process.exit(1);
});

main().catch(error => {
  logger.error('Failed to start application:', error as Error);
  process.exit(1);
});
```

## ./config/configSchema.ts

```typescript
import {z} from 'zod';

export const postgresConfigSchema = z.object({
  connection: z.object({
    host: z.string().min(1),
    port: z.number().int().positive().default(5432),
    database: z.string().min(1),
    user: z.string().min(1),
    password: z.string().min(1),
  }),
  changeDetection: z.object({
    schema: z.enum(['sepolia', 'mainnet', 'filecoin']),
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
  env: z.enum(['development', 'test', 'production']).default('development'),
  port: z.number().int().positive().default(3000),
  postgres: postgresConfigSchema,
  meiliSearch: meiliSearchConfigSchema,
  logging: loggingConfigSchema,
});

export type PostgresConfig = z.infer<typeof postgresConfigSchema>;
export type MeiliSearchConfig = z.infer<typeof meiliSearchConfigSchema>;
export type LoggingConfig = z.infer<typeof loggingConfigSchema>;
export type Config = z.infer<typeof configSchema>;
```

## ./config/configLoader.ts

```typescript
import {z} from 'zod';
import {configSchema, type Config} from './configSchema';
import 'dotenv/config';

function loadConfig(): Config {
  const config = {
    env: process.env.NODE_ENV,
    postgres: {
      connection: {
        host: process.env.DB_HOST,
        port: process.env.DB_PORT
          ? parseInt(process.env.DB_PORT, 10)
          : undefined,
        database: process.env.DB_NAME,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
      },
      changeDetection: {
        schema: process.env.DB_SCHEMA,
        batchSize: process.env.DB_BATCH_SIZE
          ? parseInt(process.env.DB_BATCH_SIZE, 10)
          : undefined,

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
```

## ./logger.ts

```typescript
import * as winston from 'winston';
import {LoggingConfig} from './config/configSchema';
import {config} from './config/configLoader';

function createLogger(config: LoggingConfig): winston.Logger {
  const formats = [
    winston.format.timestamp(),
    winston.format.errors({stack: true}),
  ];

  // Add pretty printing for console if configured.
  if (config.format === 'pretty' && config.destination === 'console') {
    formats.push(
      winston.format.colorize(),
      winston.format.printf((info: winston.Logform.TransformableInfo) => {
        const {level, message, timestamp, metadata, ...rest} = info;
        const metaStr =
          metadata || Object.keys(rest).length
            ? `\n${JSON.stringify(metadata || rest, null, 2)}`
            : '';

        return `${timestamp} ${level}: ${message}${metaStr}`;
      }),
    );
  } else {
    formats.push(winston.format.json());
  }

  const transports: winston.transport[] = [];

  // Configure transport based on destination.
  if (config.destination === 'file' && config.filename) {
    transports.push(
      new winston.transports.File({
        filename: config.filename,
        level: config.level,
        format: winston.format.combine(...formats),
        maxFiles: 7,
        maxsize: 10 * 1024 * 1024, // 10MB
        tailable: true,
      }),
    );
  } else {
    transports.push(
      new winston.transports.Console({
        level: config.level,
        format: winston.format.combine(...formats),
      }),
    );
  }

  return winston.createLogger({
    level: config.level,
    transports,
  });
}

// Singleton logger instance
export const logger = createLogger(config.logging);
```

## ./synchronizer/types.ts

```typescript
export type SyncMetrics = {
  lastSyncTime: Date;
  lastSuccessfulSync: Date | null;
  totalProcessedRecords: number;
};

export type Synchronizer = {
  name: string;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  getMetrics: () => SyncMetrics;
  isHealthy: () => Promise<boolean>;
};
```

## ./synchronizer/meilisearch/types.ts

```typescript
import {Index} from 'meilisearch';

export type SearchDocument = {
  id: string;
  name: string;
  type: 'drip_list' | 'project';
  accountId?: string; // Only for drip lists
  updatedAt: Date;
};

export type SearchDb = {
  getIndex: (indexName: string) => Promise<Index>;
  updateDocuments: (
    indexName: string,
    documents: SearchDocument[],
  ) => Promise<void>;
  initializeIndices: () => Promise<void>;
};

export type IndexSettings = {
  searchableAttributes: string[];
  filterableAttributes: string[];
  sortableAttributes: string[];
  rankingRules: string[];
  distinctAttribute: string;
};

export type ConfigureIndexSettings = {
  searchableAttributes: string[];
  filterableAttributes: string[];
  sortableAttributes: string[];
  rankingRules: string[];
  distinctAttribute: string;
};
```

## ./synchronizer/meilisearch/changeDetection/types.ts

```typescript
/**
 * The strategy interface for detecting changes in the source database.
 */
export type ChangeDetectionStrategy = {
  start(onChangesDetected: OnChangesDetected): Promise<void>;
  stop(): Promise<void>;
};

export type DripList = {
  id: string;
  name: string;
  updatedAt: Date;
};

export type Project = {
  id: string;
  name: string;
  updatedAt: Date;
};

export type Changes = {
  dripLists: DripList[];
  projects: Project[];
  timestamp: Date;
};

export type OnChangesDetected = (changes: Changes) => Promise<void>;
```

## ./synchronizer/meilisearch/changeDetection/createPollingChangeDetection.ts

```typescript
import * as winston from 'winston';
import {
  ChangeDetectionStrategy,
  Changes,
  DripList,
  OnChangesDetected,
  Project,
} from './types';
import {Pool} from 'pg';
import {z} from 'zod';
import {postgresConfigSchema} from '../../../config/configSchema';

export function createPollingChangeDetection(
  pool: Pool,
  logger: winston.Logger,
  {
    schema,
    batchSize,
    pollingInterval,
  }: z.infer<typeof postgresConfigSchema>['changeDetection'],
): ChangeDetectionStrategy {
  let interval: NodeJS.Timeout | null = null;
  let isRunning = false;
  let lastProcessedTime = new Date(0); // Start from the beginning of time - OK for now.

  const getChangedDripLists = async (since: Date): Promise<DripList[]> => {
    const sql = `
        SELECT id, name, "updatedAt"
        FROM $1."DripLists"
        WHERE "updatedAt" >= $2
        ORDER BY "updatedAt" ASC
        LIMIT $3
        FOR UPDATE SKIP LOCKED
      `;

    return (await pool.query<DripList>(sql, [schema, since, batchSize])).rows;
  };

  const getChangedProjects = async (since: Date): Promise<Project[]> => {
    const sql = `
        SELECT id, name, "updatedAt"
        FROM $1."GitProjects"
        WHERE "updatedAt" >= $2
        ORDER BY "updatedAt" ASC
        LIMIT $3
        FOR UPDATE SKIP LOCKED
      `;

    return (await pool.query<Project>(sql, [schema, since, batchSize])).rows;
  };

  const gatherChanges = async (since: Date): Promise<Changes | null> => {
    await pool.query('BEGIN');
    try {
      const [dripLists, projects] = await Promise.all([
        getChangedDripLists(since),
        getChangedProjects(since),
      ]);

      await pool.query('COMMIT');

      if (dripLists.length === 0 && projects.length === 0) {
        return null;
      }

      const allTimestamps = [
        ...dripLists.map(dl => dl.updatedAt),
        ...projects.map(p => p.updatedAt),
      ];

      const latestTimestamp = new Date(
        Math.max(...allTimestamps.map(t => t.getTime())) + 1,
      );

      return {
        dripLists,
        projects,
        timestamp: latestTimestamp,
      };
    } catch (error) {
      await pool.query('ROLLBACK');
      throw error;
    }
  };

  return {
    async start(onChangesDetected: OnChangesDetected) {
      if (isRunning) {
        logger.warn('Polling strategy already running.');

        return;
      }

      logger.info('Starting polling the database for changes...', {
        metadata: {interval: pollingInterval},
      });
      isRunning = true;

      const poll = async () => {
        if (!isRunning) return;

        try {
          const changes = await gatherChanges(lastProcessedTime);

          if (changes) {
            lastProcessedTime = changes.timestamp;

            await onChangesDetected(changes);
          } else {
            logger.info('No changes detected.');
          }
        } catch (error) {
          logger.error('Error polling for changes:', {
            metadata: {
              error: error instanceof Error ? error.message : String(error),
              stack: error instanceof Error ? error.stack : undefined,
            },
          });
        }
      };

      await poll(); // Initial poll

      interval = setInterval(poll, pollingInterval);
    },

    async stop() {
      logger.info('Stopping polling...');
      isRunning = false;

      if (interval) {
        clearInterval(interval);
        interval = null;
      }
    },
  };
}
```

## ./synchronizer/meilisearch/createMeiliSearchSynchronizer.ts

```typescript
import {Index, MeiliSearch} from 'meilisearch';
import * as winston from 'winston';
import {IndexSettings} from './types';
import {ChangeDetectionStrategy, Changes} from './changeDetection/types';
import {Synchronizer, SyncMetrics} from '../types';

export function createMeiliSearchSynchronizer(
  meiliSearch: MeiliSearch,
  changeDetection: ChangeDetectionStrategy,
  logger: winston.Logger,
): Synchronizer {
  let isRunning = false;

  const metrics: SyncMetrics = {
    lastSyncTime: new Date(0),
    lastSuccessfulSync: null,
    totalProcessedRecords: 0,
  };

  const handleChanges = async (changes: Changes) => {
    try {
      await Promise.all([
        meiliSearch.index('drip_lists').updateDocuments(
          changes.dripLists.map(dl => ({
            id: dl.id,
            name: dl.name,
            type: 'drip_list',
            updatedAt: dl.updatedAt,
          })),
        ),
        meiliSearch.index('projects').updateDocuments(
          changes.projects.map(p => ({
            id: p.id,
            name: p.name,
            type: 'project',
            updatedAt: p.updatedAt,
          })),
        ),
      ]);

      metrics.lastSyncTime = changes.timestamp;
      metrics.lastSuccessfulSync = new Date();
      metrics.totalProcessedRecords +=
        changes.dripLists.length + changes.projects.length;

      logger.info('Sync completed:', {
        metadata: {
          dripListsCount: changes.dripLists.length,
          projectsCount: changes.projects.length,
          timestamp: changes.timestamp.toISOString(),
          metrics,
        },
      });
    } catch (error) {
      logger.error('Sync failed:', {
        metadata: {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        },
      });
    }
  };

  const initializeIndices = async () => {
    const configureIndex = async (
      index: Index,
      settings: IndexSettings,
    ): Promise<void> => {
      try {
        await index.updateSettings(settings);
      } catch (error) {
        throw new Error(
          `Failed to configure index: ${(error as Error).message}`,
        );
      }
    };

    const initializeDripListsIndex = async (): Promise<void> => {
      const index = meiliSearch.index('drip_lists');
      await configureIndex(index, {
        searchableAttributes: ['name'],
        filterableAttributes: ['type', 'accountId'],
        sortableAttributes: ['updatedAt'],
        rankingRules: [
          'words',
          'typo',
          'proximity',
          'attribute',
          'sort',
          'exactness',
        ],
        distinctAttribute: 'id',
      });
    };

    const initializeProjectsIndex = async (): Promise<void> => {
      const index = meiliSearch.index('projects');
      await configureIndex(index, {
        searchableAttributes: ['name'],
        filterableAttributes: ['type'],
        sortableAttributes: ['updatedAt'],
        rankingRules: [
          'words',
          'typo',
          'proximity',
          'attribute',
          'sort',
          'exactness',
        ],
        distinctAttribute: 'id',
      });
    };

    await Promise.all([initializeDripListsIndex(), initializeProjectsIndex()]);
  };

  const start = async () => {
    if (isRunning) {
      logger.warn('MeiliSearch synchronizer is already running.');

      return;
    }

    logger.info('Starting MeiliSearch synchronizer...');
    isRunning = true;

    try {
      await initializeIndices();

      await changeDetection.start(handleChanges);

      logger.info('MeiliSearch synchronizer started successfully.');
    } catch (error) {
      logger.error('Failed to start MeiliSearch synchronizer:', {
        metadata: {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        },
      });
      throw error;
    }
  };

  const stop = async () => {
    if (!isRunning) return;

    isRunning = false;
    await changeDetection.stop();

    logger.info('MeiliSearch synchronizer stopped.', {
      metadata: {metrics},
    });
  };

  const isHealthy = async () => {
    try {
      await meiliSearch.health();
      return true;
    } catch (error) {
      logger.error('MeiliSearch synchronizer health check failed.', {
        metadata: {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        },
      });
      return false;
    }
  };

  const getMetrics = (): SyncMetrics => ({...metrics});

  return {
    name: 'meilisearch synchronizer',
    start,
    stop,
    getMetrics,
    isHealthy,
  };
}
```
