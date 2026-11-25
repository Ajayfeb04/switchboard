import { MongoClient, type Collection, type Db } from 'mongodb';
import { config } from './config.js';

export interface ConversationDoc {
  _id?: string;
  workspace: string;
  contact: string;
  assignee: string | null;
  status: 'open' | 'closed';
  lastMessageAt: Date;
  lastMessageText: string;
  createdAt: Date;
  updatedAt: Date;
}

export type MessageStatus = 'received' | 'queued' | 'sent' | 'delivered' | 'failed';

export interface MessageDoc {
  _id?: string;
  workspace: string;
  contact: string;
  direction: 'inbound' | 'outbound';
  messageId: string | null;
  clientRef: string | null;
  text: string;
  status: MessageStatus;
  occurredAt: Date;
  createdAt: Date;
  carrierAccepted?: boolean;
  carrierId?: string | null;
  attempts?: number;
  nextAttemptAt?: Date;
  leaseUntil?: Date | null;
  leaseOwner?: string | null;
  lastError?: string | null;
}

export interface ProcessedEventDoc {
  _id: string;
  workspace: string;
  type: string;
  receivedAt: Date;
}

export interface NoteDoc {
  _id: string;
  workspace: string;
  contact: string;
  authorSub: string;
  authorName: string;
  alg: 'AES-256-GCM';
  keyId: string;
  iv: string;
  ciphertext: string;
  createdAt: Date;
}

let client: MongoClient | undefined;
let indexesReady: Promise<void> | undefined;

export async function getDb(): Promise<Db> {
  if (!client) {
    client = new MongoClient(config.mongoUrl);
    await client.connect();
  }
  return client.db();
}

export async function collections() {
  const db = await getDb();
  return {
    conversations: db.collection<ConversationDoc>('conversations'),
    messages: db.collection<MessageDoc>('messages'),
    processedEvents: db.collection<ProcessedEventDoc>('processed_events'),
    notes: db.collection<NoteDoc>('notes'),
  };
}

export async function ensureIndexes(): Promise<void> {
  if (!indexesReady) {
    indexesReady = (async () => {
      const { conversations, messages, notes } = await collections();
      await Promise.all([
        conversations.createIndex({ workspace: 1, contact: 1 }, { unique: true }),
        conversations.createIndex({ workspace: 1, lastMessageAt: -1 }),
        messages.createIndex(
          { workspace: 1, messageId: 1 },
          { unique: true, partialFilterExpression: { direction: 'inbound', messageId: { $type: 'string' } } }
        ),
        messages.createIndex(
          { workspace: 1, clientRef: 1 },
          { unique: true, partialFilterExpression: { direction: 'outbound', clientRef: { $type: 'string' } } }
        ),
        messages.createIndex({ workspace: 1, contact: 1, occurredAt: 1, messageId: 1 }),
        messages.createIndex({ direction: 1, carrierAccepted: 1, status: 1, nextAttemptAt: 1, leaseUntil: 1 }),
        notes.createIndex({ workspace: 1, contact: 1, createdAt: 1 }),
      ]);
    })().catch((err) => {
      indexesReady = undefined;
      throw err;
    });
  }
  return indexesReady;
}

export async function closeDb(): Promise<void> {
  if (client) {
    await client.close();
    client = undefined;
    indexesReady = undefined;
  }
}

export type Collections = Awaited<ReturnType<typeof collections>>;
export type { Collection };
