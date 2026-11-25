import { config } from '../config.js';
import { collections, type MessageStatus } from '../db.js';
import { emitWorkspaceEvent } from '../lib/events.js';
import { ensureConversation } from './conversations.js';

export type DeliveryStatus = Extract<MessageStatus, 'sent' | 'delivered' | 'failed'>;

const STATUS_RANK: Record<MessageStatus, number> = {
  received: 0,
  queued: 0,
  sent: 1,
  delivered: 2,
  failed: 2,
};

/**
 * Enforce forward-only outbound status transitions so out-of-order webhooks
 * (for example `delivered` arriving before `sent`) never regress final state.
 */
export function canTransitionOutboundStatus(current: MessageStatus, incoming: DeliveryStatus): boolean {
  return STATUS_RANK[incoming] > STATUS_RANK[current];
}

export interface PigeonWebhookBody {
  id?: unknown;
  type?: unknown;
  workspace?: unknown;
  occurred_at?: unknown;
  data?: Record<string, unknown>;
}

export async function processPigeonEvent(
  event: PigeonWebhookBody
): Promise<{ status: 200 | 400; action: string }> {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    return { status: 400, action: 'invalid_body' };
  }

  const workspace = typeof event.workspace === 'string' ? event.workspace : '';
  const type = typeof event.type === 'string' ? event.type : '';

  // Unknown workspaces or unknown event types must return 2xx and be ignored.
  if (!workspace || !config.pigeon.apiKeys[workspace]) {
    return { status: 200, action: 'ignored_unknown_workspace' };
  }

  if (type === 'message.inbound') {
    const data = event.data;
    if (!data || typeof data !== 'object') {
      return { status: 400, action: 'missing_inbound_data' };
    }
    const messageId = typeof data.message_id === 'string' ? data.message_id : '';
    const from = typeof data.from === 'string' ? data.from : '';
    const text = typeof data.text === 'string' ? data.text : '';
    const occurredAtStr = typeof event.occurred_at === 'string' ? event.occurred_at : '';
    const occurredAt = new Date(occurredAtStr);

    if (!messageId || !from || Number.isNaN(occurredAt.getTime())) {
      return { status: 400, action: 'invalid_inbound_fields' };
    }

    const { messages } = await collections();
    const now = new Date();

    const res = await messages.updateOne(
      { workspace, direction: 'inbound', messageId },
      {
        $setOnInsert: {
          workspace,
          contact: from,
          direction: 'inbound',
          messageId,
          clientRef: null,
          text,
          status: 'received',
          occurredAt,
          createdAt: now,
        },
      },
      { upsert: true }
    );

    if (res.upsertedCount === 1) {
      await ensureConversation(workspace, from, occurredAt, text);
      await emitWorkspaceEvent(workspace, {
        type: 'message.inbound',
        contact: from,
        message_id: messageId,
        text,
        occurred_at: occurredAt.toISOString(),
      });
      return { status: 200, action: 'stored_inbound' };
    }

    return { status: 200, action: 'duplicate_inbound' };
  }

  if (type === 'message.status') {
    const data = event.data;
    if (!data || typeof data !== 'object') {
      return { status: 400, action: 'missing_status_data' };
    }
    const clientRef = typeof data.client_ref === 'string' ? data.client_ref : '';
    const rawStatus = typeof data.status === 'string' ? data.status : '';
    const carrierId = typeof data.message_id === 'string' ? data.message_id : undefined;

    if (!clientRef || !['sent', 'delivered', 'failed'].includes(rawStatus)) {
      return { status: 200, action: 'ignored_untracked_status' };
    }

    const nextStatus = rawStatus as DeliveryStatus;
    const allowedFrom = (['queued', 'sent'] as MessageStatus[]).filter((s) =>
      canTransitionOutboundStatus(s, nextStatus)
    );

    const { messages } = await collections();
    const existing = await messages.findOne({ workspace, direction: 'outbound', clientRef });
    if (!existing) {
      // Status for a message we never sent: ignore with 2xx.
      return { status: 200, action: 'ignored_unknown_message' };
    }

    const updated = await messages.findOneAndUpdate(
      {
        workspace,
        direction: 'outbound',
        clientRef,
        status: { $in: allowedFrom },
      },
      {
        $set: {
          status: nextStatus,
          carrierAccepted: true,
          leaseUntil: null,
          ...(carrierId ? { carrierId } : {}),
        },
      },
      { returnDocument: 'after' }
    );

    if (updated) {
      await emitWorkspaceEvent(workspace, {
        type: 'message.status',
        contact: updated.contact,
        client_ref: clientRef,
        status: nextStatus,
      });
      return { status: 200, action: 'updated_status' };
    }

    return { status: 200, action: 'duplicate_or_stale_status' };
  }

  // Unknown event types must return 2xx so Pigeon does not retry.
  return { status: 200, action: 'ignored_unknown_type' };
}
