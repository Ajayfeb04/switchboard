import crypto from 'node:crypto';
import { Router, type Response } from 'express';
import { config } from '../config.js';
import { collections } from '../db.js';
import {
  claimConversation,
  getConversationMessages,
  listConversations,
  updateConversationState,
} from '../services/conversations.js';
import { enqueueReply } from '../services/outbound.js';
import {
  requireSession,
  type AuthenticatedRequest,
  type WorkspaceMembership,
} from './auth.js';

export const apiRouter = Router();

apiRouter.use('/api', requireSession);

function getMembership(req: AuthenticatedRequest, workspace: string): WorkspaceMembership | null {
  if (!workspace) return null;
  return req.session?.workspaces.find((w) => w.id === workspace) ?? null;
}

function getWorkspaceParam(req: AuthenticatedRequest): string {
  const q = typeof req.query.workspace === 'string' ? req.query.workspace : '';
  const b =
    req.body && typeof (req.body as Record<string, unknown>).workspace === 'string'
      ? String((req.body as Record<string, unknown>).workspace)
      : '';
  return q || b;
}

apiRouter.get('/api/conversations', async (req: AuthenticatedRequest, res: Response) => {
  const workspace = getWorkspaceParam(req);
  if (!workspace) {
    res.status(400).json({ error: 'workspace is required' });
    return;
  }

  const member = getMembership(req, workspace);
  if (!member) {
    res.status(403).json({ error: 'forbidden for workspace' });
    return;
  }

  const limit = Math.min(100, Math.max(1, Number(req.query.limit || 50) || 50));
  const offset = Math.max(0, Number(req.query.offset || 0) || 0);
  const statusFilter = typeof req.query.status === 'string' ? req.query.status : 'all';

  let conversations = await listConversations(workspace, limit, offset);
  if (statusFilter === 'open' || statusFilter === 'closed') {
    conversations = conversations.filter((c) => c.status === statusFilter);
  }

  res.status(200).json({ conversations });
});

apiRouter.get(
  '/api/conversations/:contact/messages',
  async (req: AuthenticatedRequest, res: Response) => {
    const workspace = getWorkspaceParam(req);
    const contact = decodeURIComponent(req.params.contact || '');
    if (!workspace || !contact) {
      res.status(400).json({ error: 'workspace and contact are required' });
      return;
    }

    const member = getMembership(req, workspace);
    if (!member) {
      res.status(403).json({ error: 'forbidden for workspace' });
      return;
    }

    const { conversations, notes } = await collections();
    const [conversation, messages, noteList] = await Promise.all([
      conversations.findOne({ workspace, contact }),
      getConversationMessages(workspace, contact),
      notes.find({ workspace, contact }).sort({ createdAt: 1 }).toArray(),
    ]);

    res.status(200).json({ conversation, messages, notes: noteList });
  }
);

apiRouter.post('/api/conversations/:contact/claim', async (req: AuthenticatedRequest, res: Response) => {
  const workspace = getWorkspaceParam(req);
  const contact = decodeURIComponent(req.params.contact || '');
  if (!workspace || !contact) {
    res.status(400).json({ error: 'workspace and contact are required' });
    return;
  }

  const member = getMembership(req, workspace);
  if (!member) {
    res.status(403).json({ error: 'forbidden for workspace' });
    return;
  }

  const result = await claimConversation(workspace, contact, req.session!.sub);
  if (!result.ok) {
    res.status(409).json({ error: 'conversation already claimed by another agent' });
    return;
  }

  res.status(200).json({ conversation: result.conversation });
});

apiRouter.post(
  '/api/conversations/:contact/release',
  async (req: AuthenticatedRequest, res: Response) => {
    const workspace = getWorkspaceParam(req);
    const contact = decodeURIComponent(req.params.contact || '');
    if (!workspace || !contact) {
      res.status(400).json({ error: 'workspace and contact are required' });
      return;
    }

    const member = getMembership(req, workspace);
    if (!member) {
      res.status(403).json({ error: 'forbidden for workspace' });
      return;
    }

    const { conversations } = await collections();
    const existing = await conversations.findOne({ workspace, contact });
    if (!existing) {
      res.status(404).json({ error: 'conversation not found' });
      return;
    }

    if (
      existing.assignee &&
      existing.assignee !== req.session!.sub &&
      member.role !== 'admin'
    ) {
      res.status(403).json({ error: 'only the assignee or an admin can release this conversation' });
      return;
    }

    const updated = await updateConversationState(workspace, contact, { assignee: null });
    res.status(200).json({ conversation: updated });
  }
);

apiRouter.post('/api/conversations/:contact/status', async (req: AuthenticatedRequest, res: Response) => {
  const workspace = getWorkspaceParam(req);
  const contact = decodeURIComponent(req.params.contact || '');
  const status = (req.body as { status?: unknown })?.status;
  if (!workspace || !contact || (status !== 'open' && status !== 'closed')) {
    res.status(400).json({ error: 'workspace, contact, and status (open|closed) are required' });
    return;
  }

  const member = getMembership(req, workspace);
  if (!member) {
    res.status(403).json({ error: 'forbidden for workspace' });
    return;
  }

  const updated = await updateConversationState(workspace, contact, { status });
  if (!updated) {
    res.status(404).json({ error: 'conversation not found' });
    return;
  }

  res.status(200).json({ conversation: updated });
});

apiRouter.post('/api/conversations/:contact/reply', async (req: AuthenticatedRequest, res: Response) => {
  const workspace = getWorkspaceParam(req);
  const contact = decodeURIComponent(req.params.contact || '');
  const body = (req.body ?? {}) as Record<string, unknown>;
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  const clientRef =
    typeof body.client_ref === 'string' && body.client_ref.trim()
      ? body.client_ref.trim()
      : `ui_${crypto.randomUUID()}`;

  if (!workspace || !contact || !text) {
    res.status(400).json({ error: 'workspace, contact, and text are required' });
    return;
  }

  const member = getMembership(req, workspace);
  if (!member) {
    res.status(403).json({ error: 'forbidden for workspace' });
    return;
  }
  if (!config.pigeon.apiKeys[workspace]) {
    res.status(404).json({ error: 'unknown workspace' });
    return;
  }

  const result = await enqueueReply({ workspace, contact, text, clientRef });
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }

  res.status(202).json({ message: result.message });
});

apiRouter.post('/api/conversations/:contact/notes', async (req: AuthenticatedRequest, res: Response) => {
  const workspace = getWorkspaceParam(req);
  const contact = decodeURIComponent(req.params.contact || '');
  const payload = (req.body ?? {}) as Record<string, unknown>;
  const alg = payload.alg;
  const keyId = typeof payload.keyId === 'string' ? payload.keyId.trim() : '';
  const iv = typeof payload.iv === 'string' ? payload.iv.trim() : '';
  const ciphertext = typeof payload.ciphertext === 'string' ? payload.ciphertext.trim() : '';

  if (typeof payload.body === 'string') {
    res.status(400).json({ error: 'plaintext notes are not accepted; encrypt client-side' });
    return;
  }

  if (!workspace || !contact || alg !== 'AES-256-GCM' || !keyId || !iv || !ciphertext) {
    res.status(400).json({ error: 'workspace, contact, alg (AES-256-GCM), keyId, iv, and ciphertext are required' });
    return;
  }

  const member = getMembership(req, workspace);
  if (!member) {
    res.status(403).json({ error: 'forbidden for workspace' });
    return;
  }

  const { notes } = await collections();
  const note = {
    _id: `note_${crypto.randomUUID()}`,
    workspace,
    contact,
    authorSub: req.session!.sub,
    authorName: req.session!.name ?? req.session!.sub,
    alg: 'AES-256-GCM' as const,
    keyId,
    iv,
    ciphertext,
    createdAt: new Date(),
  };
  await notes.insertOne(note);
  res.status(201).json({ note });
});
