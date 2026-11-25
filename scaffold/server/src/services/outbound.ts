import { config } from '../config.js';
import { collections, type MessageDoc } from '../db.js';
import { emitWorkspaceEvent } from '../lib/events.js';
import { ensureConversation } from './conversations.js';
import { nudgeWorker } from './worker.js';

export interface EnqueueReplyInput {
  workspace: string;
  contact: string;
  text: string;
  clientRef: string;
}

export async function enqueueReply(
  input: EnqueueReplyInput
): Promise<{ ok: true; message: MessageDoc; created: boolean } | { ok: false; status: 400 | 404; error: string }> {
  const { workspace, contact, text, clientRef } = input;

  if (!workspace || !config.pigeon.apiKeys[workspace]) {
    return { ok: false, status: 404, error: 'unknown workspace' };
  }
  if (!contact || !text || !clientRef) {
    return { ok: false, status: 400, error: 'contact, text, and client_ref are required' };
  }

  const now = new Date();
  await ensureConversation(workspace, contact, now, text);

  const { messages } = await collections();
  let created = false;
  let doc: MessageDoc | null = null;

  try {
    const res = await messages.findOneAndUpdate(
      { workspace, direction: 'outbound', clientRef },
      {
        $setOnInsert: {
          workspace,
          contact,
          direction: 'outbound',
          messageId: null,
          clientRef,
          text,
          status: 'queued',
          occurredAt: now,
          createdAt: now,
          carrierAccepted: false,
          carrierId: null,
          attempts: 0,
          nextAttemptAt: now,
          leaseUntil: null,
          leaseOwner: null,
          lastError: null,
        },
      },
      { upsert: true, returnDocument: 'after', includeResultMetadata: true }
    );
    created = Boolean(res.lastErrorObject?.upserted);
    doc = res.value;
  } catch (err: unknown) {
    if ((err as { code?: number })?.code === 11000) {
      doc = await messages.findOne({ workspace, direction: 'outbound', clientRef });
      created = false;
    } else {
      throw err;
    }
  }

  if (!doc) {
    throw new Error('Failed to persist outbound message');
  }

  if (created) {
    await emitWorkspaceEvent(workspace, {
      type: 'message.status',
      contact,
      client_ref: clientRef,
      status: 'queued',
      text,
      occurred_at: now.toISOString(),
    });
    nudgeWorker();
  }

  return { ok: true, message: doc, created };
}
