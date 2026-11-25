import { collections, type ConversationDoc, type MessageDoc } from '../db.js';
import { emitWorkspaceEvent } from '../lib/events.js';

export async function ensureConversation(
  workspace: string,
  contact: string,
  occurredAt?: Date,
  lastMessageText?: string
): Promise<ConversationDoc> {
  const { conversations } = await collections();
  const now = new Date();
  const msgTime = occurredAt ?? now;

  try {
    const res = await conversations.findOneAndUpdate(
      { workspace, contact },
      {
        $setOnInsert: {
          workspace,
          contact,
          assignee: null,
          status: 'open',
          createdAt: now,
        },
        $max: { lastMessageAt: msgTime },
        $set: {
          updatedAt: now,
          ...(lastMessageText !== undefined ? { lastMessageText } : {}),
        },
      },
      { upsert: true, returnDocument: 'after' }
    );
    return res!;
  } catch (err: unknown) {
    // Handle concurrent first-insert race on unique index (workspace, contact)
    if ((err as { code?: number })?.code === 11000) {
      const res = await conversations.findOneAndUpdate(
        { workspace, contact },
        {
          $max: { lastMessageAt: msgTime },
          $set: {
            updatedAt: now,
            ...(lastMessageText !== undefined ? { lastMessageText } : {}),
          },
        },
        { returnDocument: 'after' }
      );
      if (res) return res;
    }
    throw err;
  }
}

export async function claimConversation(
  workspace: string,
  contact: string,
  agent: string
): Promise<{ ok: true; conversation: ConversationDoc } | { ok: false; status: 409 }> {
  const { conversations } = await collections();
  const now = new Date();

  const tryClaim = async (upsert: boolean) =>
    conversations.findOneAndUpdate(
      {
        workspace,
        contact,
        $or: [{ assignee: null }, { assignee: agent }],
      },
      {
        $set: { assignee: agent, updatedAt: now },
        $setOnInsert: {
          workspace,
          contact,
          status: 'open',
          lastMessageAt: now,
          lastMessageText: '',
          createdAt: now,
        },
      },
      { upsert, returnDocument: 'after' }
    );

  let doc: ConversationDoc | null = null;
  try {
    doc = await tryClaim(true);
  } catch (err: unknown) {
    if ((err as { code?: number })?.code === 11000) {
      doc = await tryClaim(false);
    } else {
      throw err;
    }
  }

  if (!doc) {
    return { ok: false, status: 409 };
  }

  await emitWorkspaceEvent(workspace, {
    type: 'conversation.assigned',
    contact,
    assignee: doc.assignee,
    status: doc.status,
  });

  return { ok: true, conversation: doc };
}

export async function updateConversationState(
  workspace: string,
  contact: string,
  patch: { assignee?: string | null; status?: 'open' | 'closed' }
): Promise<ConversationDoc | null> {
  const { conversations } = await collections();
  const now = new Date();
  const update: Partial<ConversationDoc> = { updatedAt: now };
  if (patch.assignee !== undefined) update.assignee = patch.assignee;
  if (patch.status !== undefined) update.status = patch.status;

  const doc = await conversations.findOneAndUpdate(
    { workspace, contact },
    { $set: update },
    { returnDocument: 'after' }
  );

  if (doc) {
    await emitWorkspaceEvent(workspace, {
      type: 'conversation.assigned',
      contact,
      assignee: doc.assignee,
      status: doc.status,
    });
  }

  return doc;
}

export async function listConversations(
  workspace: string,
  limit = 50,
  offset = 0
): Promise<ConversationDoc[]> {
  const { conversations } = await collections();
  return conversations
    .find({ workspace })
    .sort({ lastMessageAt: -1, contact: 1 })
    .skip(offset)
    .limit(limit)
    .toArray();
}

export async function getConversationMessages(
  workspace: string,
  contact: string
): Promise<MessageDoc[]> {
  const { messages } = await collections();
  return messages
    .find({ workspace, contact })
    .sort({ occurredAt: 1, messageId: 1, createdAt: 1 })
    .toArray();
}
