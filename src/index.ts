/* eslint-disable n/no-process-exit */
import {Pool} from 'pg';
import type {Server as HttpServer} from 'http';
import {createMeiliSearchSynchronizer} from './synchronizer/meilisearch/createMeiliSearchSynchronizer';
import MeiliSearch from 'meilisearch';
import {createPollingChangeDetection} from './synchronizer/meilisearch/changeDetection/createPollingChangeDetection';
import {logger} from './logger';
import * as winston from 'winston';
import {Synchronizer} from './synchronizer/types';
import {config} from './config/configLoader';
import {startHealthServer, stopHealthServer} from './health';

async function initializeApp() {
  const pool = new Pool({
    connectionString: config.postgres.connectionString,
  });

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

  return {pool, synchronizer};
}

async function main() {
  logger.info('Starting application... 🚀', {metadata: {env: config.nodeEnv}});

  const {pool, synchronizer} = await initializeApp();

  let healthServer: HttpServer | undefined;

  registerShutdownHandlers(pool, synchronizer, logger, () => healthServer);

  try {
    await synchronizer.start();

    healthServer = startHealthServer({pool, synchronizer, logger});
  } catch (error) {
    logger.error('Failed to start sync process:', error as Error);
    await shutdown(pool, synchronizer, 'STARTUP_ERROR', logger, healthServer);
  }
}

async function shutdown(
  pool: Pool,
  synchronizer: Synchronizer,
  signal: string,
  logger: winston.Logger,
  healthServer?: HttpServer,
) {
  logger.info(`${signal} received, starting graceful shutdown...`);

  try {
    await stopHealthServer(healthServer, logger);
    await synchronizer.stop();
    await pool.end();

    logger.info('Graceful shutdown completed.');
    process.exitCode = 1;
  } catch (error) {
    logger.error('Error during shutdown.', error as Error);
    process.exitCode = 1;
  }
}

function registerShutdownHandlers(
  pool: Pool,
  synchronizer: Synchronizer,
  logger: winston.Logger,
  getHealthServer: () => HttpServer | undefined,
) {
  ['SIGTERM', 'SIGINT'].forEach(signal => {
    process.once(signal, () =>
      shutdown(pool, synchronizer, signal, logger, getHealthServer()),
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
