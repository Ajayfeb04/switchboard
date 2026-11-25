import express, { type Request } from 'express';
import { authRouter } from './routes/auth.js';
import { apiRouter } from './routes/api.js';
import { graderRouter } from './routes/grader.js';
import { webhooksRouter } from './routes/webhooks.js';

interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

export function createApp() {
  const app = express();

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });

  // Capture raw bytes for webhook HMAC verification, and allow malformed JSON
  // on /webhooks/pigeon to pass through so the route can verify signature first
  // and return 400 (instead of Express's default 400 before signature check).
  app.use('/webhooks/pigeon', express.raw({ type: '*/*', limit: '2mb' }), (req: RawBodyRequest, _res, next) => {
    req.rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
    next();
  });

  app.use(express.json({ limit: '2mb' }));

  app.use(webhooksRouter);
  app.use(graderRouter);
  app.use(authRouter);
  app.use(apiRouter);

  return app;
}
