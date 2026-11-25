export interface WorkspaceMembership {
  id: string;
  role: 'admin' | 'agent' | string;
}

export interface MeUser {
  sub: string;
  name?: string;
  email?: string;
  workspaces: WorkspaceMembership[];
}

export interface Conversation {
  _id?: string;
  workspace: string;
  contact: string;
  assignee: string | null;
  status: 'open' | 'closed';
  lastMessageAt: string;
  lastMessageText: string;
}

export type MessageStatus = 'received' | 'queued' | 'sent' | 'delivered' | 'failed';

export interface Message {
  _id?: string;
  workspace: string;
  contact: string;
  direction: 'inbound' | 'outbound';
  messageId: string | null;
  clientRef: string | null;
  text: string;
  status: MessageStatus;
  occurredAt: string;
  createdAt: string;
}

export interface Note {
  _id: string;
  workspace: string;
  contact: string;
  authorSub: string;
  authorName: string;
  alg: 'AES-256-GCM';
  keyId: string;
  iv: string;
  ciphertext: string;
  createdAt: string;
}

export type WsFrame =
  | {
      seq: number;
      type: 'message.inbound';
      contact: string;
      message_id: string;
      text?: string;
      occurred_at?: string;
    }
  | {
      seq: number;
      type: 'message.status';
      contact: string;
      client_ref: string;
      status: 'queued' | 'sent' | 'delivered' | 'failed';
      text?: string;
      occurred_at?: string;
    }
  | {
      seq: number;
      type: 'conversation.assigned';
      contact: string;
      assignee: string | null;
      status?: 'open' | 'closed';
    };
