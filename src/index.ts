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
  logger.info('Starting application... 🚀', {metadata: {env: config.nodeEnv}});

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
