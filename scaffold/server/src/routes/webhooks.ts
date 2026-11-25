import { Router, type Request, type Response } from 'express';
import { config } from '../config.js';
import { verifyPigeonSignature } from '../lib/crypto.js';
import { processPigeonEvent, type PigeonWebhookBody } from '../services/inbound.js';

export const webhooksRouter = Router();

interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

webhooksRouter.post('/webhooks/pigeon', async (req: RawBodyRequest, res: Response) => {
  const rawBody = req.rawBody ?? (Buffer.isBuffer(req.body) ? req.body : Buffer.from(''));
  const sigHeader = req.header('x-pigeon-signature');

  const sig = verifyPigeonSignature(rawBody, sigHeader, config.pigeon.webhookSecret, 300);
  if (!sig.ok) {
    res.status(401).json({ error: `unauthorized webhook: ${sig.reason}` });
    return;
  }

  let parsed: PigeonWebhookBody;
  try {
    parsed = JSON.parse(rawBody.toString('utf8')) as PigeonWebhookBody;
  } catch {
    res.status(400).json({ error: 'invalid json payload' });
    return;
  }

  try {
    const result = await processPigeonEvent(parsed);
    res.status(result.status).json({ ok: result.status < 300, action: result.action });
  } catch (err) {
    console.error('webhook processing error', err);
    res.status(500).json({ error: 'internal error' });
  }
});
