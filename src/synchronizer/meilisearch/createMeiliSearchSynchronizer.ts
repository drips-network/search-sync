import {Index, MeiliSearch, Settings} from 'meilisearch';
import * as winston from 'winston';
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
      logger.info('Starting sync...');

      const [dripListsResult, projectsResult] = await Promise.all([
        meiliSearch.index('drip_lists').updateDocuments(
          changes.dripLists.map(dl => ({
            id: dl.id,
            name: dl.name,
            type: 'drip_list',
            updatedAt: dl.updatedAt,
            description: dl.description,
            ownerAddress: dl.ownerAddress,
            ownerAccountId: dl.ownerAccountId,
          })),
          {primaryKey: 'id'},
        ),
        meiliSearch.index('projects').updateDocuments(
          changes.projects.map(p => ({
            id: p.id,
            name: p.name,
            type: 'project',
            updatedAt: p.updatedAt,
            description: p.description,
            ownerAddress: p.ownerAddress,
            ownerAccountId: p.ownerAccountId,
            url: p.url,
          })),
          {primaryKey: 'id'},
        ),
      ]);

      const [dripListsTask, projectsTask] = await Promise.all([
        meiliSearch.waitForTask(dripListsResult.taskUid),
        meiliSearch.waitForTask(projectsResult.taskUid),
      ]);

      if (dripListsTask.status === 'failed') {
        throw new Error(
          `Drip lists task failed: ${JSON.stringify(dripListsTask.error, null, 2)}`,
        );
      }
      if (projectsTask.status === 'failed') {
        throw new Error(
          `Projects task failed: ${JSON.stringify(projectsTask.error, null, 2)}`,
        );
      }

      // Only update metrics after confirming tasks succeeded.
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
      // Stop change detection and reset state on sync failure.
      isRunning = false;
      await changeDetection.stop().catch(stopError => {
        logger.warn(
          'Error while stopping change detection after sync failure:',
          {
            metadata: {
              error:
                stopError instanceof Error
                  ? stopError.message
                  : String(stopError),
            },
          },
        );
      });

      throw error;
    }
  };

  const initializeIndices = async () => {
    const configureIndex = async (
      index: Index,
      settings: Settings,
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
        searchableAttributes: [
          'name',
          'id',
          'ownerAddress',
          'ownerAccountId',
          'description',
        ],
        distinctAttribute: 'id',
        displayedAttributes: [
          'name',
          'id',
          'type',
          'updatedAt',
          'description',
          'ownerAddress',
          'ownerAccountId',
        ],
        typoTolerance: {
          disableOnAttributes: ['id', 'ownerAccountId', 'ownerAddress'],
        },
      });
    };

    const initializeProjectsIndex = async (): Promise<void> => {
      const index = meiliSearch.index('projects');
      await configureIndex(index, {
        searchableAttributes: [
          'id',
          'name',
          'description',
          'url',
          'ownerAddress',
          'ownerAccountId',
        ],
        distinctAttribute: 'id',
        displayedAttributes: [
          'id',
          'name',
          'type',
          'updatedAt',
          'description',
          'ownerAddress',
          'ownerAccountId',
          'url',
        ],
        typoTolerance: {
          disableOnAttributes: ['id', 'ownerAccountId', 'ownerAddress', 'url'],
        },
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
    } catch (error) {
      logger.error('Failed to start MeiliSearch synchronizer:', {
        metadata: {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        },
      });
      // Reset running state and cleanup on startup failure
      isRunning = false;
      await changeDetection.stop().catch(stopError => {
        logger.warn(
          'Error while stopping change detection after startup failure:',
          {
            metadata: {
              error:
                stopError instanceof Error
                  ? stopError.message
                  : String(stopError),
            },
          },
        );
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