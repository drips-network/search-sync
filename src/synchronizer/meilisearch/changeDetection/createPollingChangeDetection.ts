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
  DbSchema,
  postgresConfigSchema,
} from '../../../config/configSchema';

/**
 * Simple change detection strategy that polls all records in the database at a fixed interval.
 *
 * TODO: when performance becomes an issue, consider using a more efficient change detection strategy:
 * - Add an `updatedAt` column to Projects and DripLists tables and query for records that have been updated since the last poll.
 * - Use CDC (Change Data Capture) to stream changes from the database.
 */
export function createPollingChangeDetection(
  pool: Pool,
  logger: winston.Logger,
  {
    schemas,
    pollingInterval,
  }: z.infer<typeof postgresConfigSchema>['changeDetection'],
): ChangeDetectionStrategy {
  let interval: NodeJS.Timeout | null = null;
  let isRunning = false;

  for (const schema of schemas) {
    if (!ALLOWED_DB_SCHEMAS.includes(schema as any)) {
      throw new Error(`Schema "${schema}" is not allowed.`);
    }
  }

  const getAllRecords = async (): Promise<Changes> => {
    const dripListsSql = (schema: DbSchema) => `
      SELECT "account_id" as "id", "name", "description", "owner_address" as "ownerAddress", "owner_account_id" as "ownerAccountId", "is_visible" as "isVisible", '${schema}' AS chain
      FROM ${schema}."drip_lists"
      WHERE "is_visible" = TRUE
    `;

    const projectsSql = (schema: DbSchema) => `
      SELECT "account_id" as "id", "name", "owner_address" as "ownerAddress", "owner_account_id" as "ownerAccountId", "url", "avatar_cid" as "avatarCid", "emoji", "color", "is_visible" as "isVisible", "verification_status"::TEXT as "verificationStatus", '${schema}' AS chain
      FROM ${schema}."projects"
    `;

    const dripListsQueries = schemas.map(chain => dripListsSql(chain));
    const dripListsFullQuery = `${dripListsQueries.join(' UNION ')}`;

    const projectsQueries = schemas.map(chain => projectsSql(chain));
    const projectsSqlFullQuery = `${projectsQueries.join(' UNION ')}`;

    const [dripLists, projects] = await Promise.all([
      pool.query<DripList>(dripListsFullQuery).then(result => result.rows),
      pool.query<Project>(projectsSqlFullQuery).then(result => result.rows),
    ]);

    return {dripLists, projects};
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
          const records = await getAllRecords();
          await onChangesDetected(records);
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
