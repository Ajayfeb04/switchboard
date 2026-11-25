import { createServer } from 'node:http';
import { createApp } from './app.js';
import { config } from './config.js';
import { closeDb, ensureIndexes } from './db.js';
import { closeRedis, getRedis } from './redis.js';
import { startWorker, stopWorker } from './services/worker.js';
import { closeWsGateway, initWsGateway } from './ws/gateway.js';

async function main(): Promise<void> {
  await ensureIndexes();
  await getRedis().ping();

  const app = createApp();
  const server = createServer(app);
  await initWsGateway(server);

  startWorker();

  server.listen(config.port, () => {
    console.log(`server on http://localhost:${config.port}`);
  });

  const shutdown = async () => {
    stopWorker();
    await closeWsGateway();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeRedis();
    await closeDb();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

main().catch((err) => {
  console.error('fatal startup error', err);
  process.exit(1);
});
