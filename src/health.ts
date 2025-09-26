import {createServer, type IncomingMessage, type ServerResponse} from 'http';
import type {Server as HttpServer} from 'http';
import type {Pool} from 'pg';
import * as winston from 'winston';
import {config} from './config/configLoader';
import type {Synchronizer} from './synchronizer/types';

type HealthComponentStatus = {
  status: 'ok' | 'fail' | 'initializing';
  latencyMs?: number;
  message?: string;
  lastSyncTime?: string;
  totalProcessedRecords?: number;
};

type HealthServerDependencies = {
  pool: Pool;
  synchronizer: Synchronizer;
  logger: winston.Logger;
};

export function createHealthRequestHandler({
  pool,
  synchronizer,
  logger,
}: HealthServerDependencies) {
  const handleRequest = async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    const requestUrl = req.url ?? '';

    if (req.method !== 'GET' || !requestUrl.startsWith('/health')) {
      res.statusCode = 404;
      res.end('Not Found');
      return;
    }

    const postgresStatus = await performPostgresCheck(pool, logger);
    const synchronizerStatus = evaluateSynchronizer(synchronizer);

    const isHealthy =
      postgresStatus.status === 'ok' && synchronizerStatus.status === 'ok';

    res.statusCode = isHealthy ? 200 : 503;
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        status: isHealthy ? 'ok' : 'fail',
        components: {
          postgres: postgresStatus,
          synchronizer: synchronizerStatus,
        },
      }),
    );
  };

  return handleRequest;
}

export async function performPostgresCheck(
  pool: Pool,
  logger: winston.Logger,
): Promise<HealthComponentStatus> {
  const startTime = process.hrtime();

  try {
    await pool.query('SELECT 1');
    const [elapsedSeconds, elapsedNanoseconds] = process.hrtime(startTime);
    const latencyMs =
      Math.round(
        (elapsedSeconds * 1_000 + elapsedNanoseconds / 1_000_000) * 100,
      ) / 100;

    return {
      status: 'ok',
      latencyMs,
    };
  } catch (error) {
    logger.error('Postgres health check failed.', error as Error);

    return {
      status: 'fail',
      message: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

export function evaluateSynchronizer(
  synchronizer: Synchronizer,
): HealthComponentStatus {
  const metrics = synchronizer.getMetrics();
  if (!metrics.lastSyncTime) {
    return {
      status: 'initializing',
      message: 'Synchronizer has not reported a last sync time yet.',
      totalProcessedRecords: metrics.totalProcessedRecords,
    };
  }

  const lastSyncTimestamp = metrics.lastSyncTime.getTime();

  if (lastSyncTimestamp === 0) {
    return {
      status: 'initializing',
      lastSyncTime: metrics.lastSyncTime.toISOString(),
      totalProcessedRecords: metrics.totalProcessedRecords,
      message: 'Synchronizer has not completed a sync cycle yet.',
    };
  }

  return {
    status: 'ok',
    lastSyncTime: metrics.lastSyncTime.toISOString(),
    totalProcessedRecords: metrics.totalProcessedRecords,
  };
}

export function startHealthServer({
  pool,
  synchronizer,
  logger,
}: HealthServerDependencies): HttpServer | undefined {
  if (!config.health.enabled) {
    logger.info('Health endpoint disabled via configuration.');
    return undefined;
  }

  const requestHandler = createHealthRequestHandler({
    pool,
    synchronizer,
    logger,
  });

  const server = createServer((req, res) => {
    void requestHandler(req, res);
  });

  server.on('error', error => {
    logger.error('Health server encountered an error.', error as Error);
  });

  server.listen(config.health.port, config.health.host, () => {
    logger.info('Health endpoint listening.', {
      metadata: {
        host: config.health.host,
        port: config.health.port,
      },
    });
  });

  return server;
}

export async function stopHealthServer(
  server: HttpServer | undefined,
  logger: winston.Logger,
): Promise<void> {
  if (!server) return;

  await new Promise<void>(resolve => {
    server.close(error => {
      if (error) {
        logger.error('Error while closing health server.', error as Error);
      }

      resolve();
    });
  });
}
