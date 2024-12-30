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
import {
  ALLOWED_DB_SCHEMAS,
  postgresConfigSchema,
} from '../../../config/configSchema';

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
  if (!ALLOWED_DB_SCHEMAS.includes(schema as any)) {
    throw new Error(`Schema "${schema}" is not allowed.`);
  }

  const getChangedDripLists = async (since: Date): Promise<DripList[]> => {
    const sql = `
        SELECT "id", "name", "updatedAt", "description", "ownerAddress", "ownerAccountId"
        FROM ${schema}."DripLists"
        WHERE "updatedAt" >= $1
        ORDER BY "updatedAt" ASC
        LIMIT $2
        FOR UPDATE SKIP LOCKED
      `;

    return (await pool.query<DripList>(sql, [since, batchSize])).rows;
  };

  const getChangedProjects = async (since: Date): Promise<Project[]> => {
    const sql = `
        SELECT "id", "name", "updatedAt", "description", "ownerAddress", "ownerAccountId", "url"
        FROM ${schema}."GitProjects"
        WHERE "updatedAt" >= $1
        ORDER BY "updatedAt" ASC
        LIMIT $2
        FOR UPDATE SKIP LOCKED
      `;

    return (await pool.query<Project>(sql, [since, batchSize])).rows;
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
