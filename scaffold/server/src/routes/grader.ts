import { Router, type NextFunction, type Request, type Response } from 'express';
import { config } from '../config.js';
import { collections, ensureIndexes } from '../db.js';
import { resetAppRedis } from '../redis.js';
import { claimConversation } from '../services/conversations.js';
import { enqueueReply } from '../services/outbound.js';

export const graderRouter = Router();

function requireGraderToken(req: Request, res: Response, next: NextFunction): void {
  const token = req.header('x-grader-token');
  if (!token || token !== config.graderToken) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
}

graderRouter.use('/__grader', requireGraderToken);

graderRouter.post('/__grader/reset', async (_req: Request, res: Response) => {
  const { conversations, messages, processedEvents, notes } = await collections();
  await Promise.all([
    conversations.deleteMany({}),
    messages.deleteMany({}),
    processedEvents.deleteMany({}),
    notes.deleteMany({}),
    resetAppRedis(),
  ]);
  await ensureIndexes();
  res.status(200).json({ ok: true });
});

graderRouter.get('/__grader/snapshot', async (_req: Request, res: Response) => {
  const { conversations, messages } = await collections();
  const [convs, msgs] = await Promise.all([
    conversations.find({}).toArray(),
    messages.find({}).sort({ occurredAt: 1, messageId: 1, createdAt: 1 }).toArray(),
  ]);

  const workspaces: Record<
    string,
    {
      contacts: Record<string, { inbound: string[]; assignee: string | null }>;
      outbound: Record<string, string>;
    }
  > = {};

  const ensureWs = (ws: string) => {
    if (!workspaces[ws]) {
      workspaces[ws] = { contacts: {}, outbound: {} };
    }
    return workspaces[ws];
  };

  for (const c of convs) {
    const ws = ensureWs(c.workspace);
    ws.contacts[c.contact] = {
      inbound: [],
      assignee: c.assignee ?? null,
    };
  }

  for (const m of msgs) {
    const ws = ensureWs(m.workspace);
    if (m.direction === 'inbound' && m.messageId) {
      if (!ws.contacts[m.contact]) {
        ws.contacts[m.contact] = { inbound: [], assignee: null };
      }
      ws.contacts[m.contact].inbound.push(m.messageId);
    } else if (m.direction === 'outbound' && m.clientRef) {
      ws.outbound[m.clientRef] = m.status;
    }
  }

  res.status(200).json({ workspaces });
});

graderRouter.post('/__grader/reply', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const workspace = typeof body.workspace === 'string' ? body.workspace : '';
  const contact = typeof body.contact === 'string' ? body.contact : '';
  const text = typeof body.text === 'string' ? body.text : '';
  const clientRef = typeof body.client_ref === 'string' ? body.client_ref : '';

  const result = await enqueueReply({ workspace, contact, text, clientRef });
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }

  res.status(202).json({
    ok: true,
    client_ref: result.message.clientRef,
    status: result.message.status,
  });
});

graderRouter.post('/__grader/claim', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const workspace = typeof body.workspace === 'string' ? body.workspace : '';
  const contact = typeof body.contact === 'string' ? body.contact : '';
  const agent = typeof body.agent === 'string' ? body.agent : '';

  if (!workspace || !config.pigeon.apiKeys[workspace]) {
    res.status(404).json({ error: 'unknown workspace' });
    return;
  }
  if (!contact || !agent) {
    res.status(400).json({ error: 'contact and agent are required' });
    return;
  }

  const result = await claimConversation(workspace, contact, agent);
  if (!result.ok) {
    res.status(409).json({ error: 'already claimed' });
    return;
  }

  res.status(200).json({
    ok: true,
    workspace,
    contact,
    assignee: result.conversation.assignee,
  });
});
