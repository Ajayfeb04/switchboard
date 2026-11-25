import type { Conversation, MeUser, Message, Note } from '../types';

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
    ...init,
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    const err = new Error(body.error || `HTTP ${res.status}`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }

  return (await res.json()) as T;
}

export function fetchMe(): Promise<MeUser> {
  return requestJson<MeUser>('/api/me');
}

export function logout(): Promise<{ ok: boolean }> {
  return requestJson<{ ok: boolean }>('/auth/logout', { method: 'POST', body: '{}' });
}

export function fetchConversations(workspace: string, status = 'all'): Promise<{ conversations: Conversation[] }> {
  const q = new URLSearchParams({ workspace, status });
  return requestJson<{ conversations: Conversation[] }>(`/api/conversations?${q.toString()}`);
}

export function fetchThread(
  workspace: string,
  contact: string
): Promise<{ conversation: Conversation | null; messages: Message[]; notes: Note[] }> {
  const q = new URLSearchParams({ workspace });
  return requestJson(`/api/conversations/${encodeURIComponent(contact)}/messages?${q.toString()}`);
}

export function claimConversation(workspace: string, contact: string): Promise<{ conversation: Conversation }> {
  return requestJson(`/api/conversations/${encodeURIComponent(contact)}/claim`, {
    method: 'POST',
    body: JSON.stringify({ workspace }),
  });
}

export function releaseConversation(workspace: string, contact: string): Promise<{ conversation: Conversation }> {
  return requestJson(`/api/conversations/${encodeURIComponent(contact)}/release`, {
    method: 'POST',
    body: JSON.stringify({ workspace }),
  });
}

export function setConversationStatus(
  workspace: string,
  contact: string,
  status: 'open' | 'closed'
): Promise<{ conversation: Conversation }> {
  return requestJson(`/api/conversations/${encodeURIComponent(contact)}/status`, {
    method: 'POST',
    body: JSON.stringify({ workspace, status }),
  });
}

export function sendReply(
  workspace: string,
  contact: string,
  text: string,
  client_ref: string
): Promise<{ message: Message }> {
  return requestJson(`/api/conversations/${encodeURIComponent(contact)}/reply`, {
    method: 'POST',
    body: JSON.stringify({ workspace, text, client_ref }),
  });
}

export function addNote(
  workspace: string,
  contact: string,
  encrypted: { alg: 'AES-256-GCM'; keyId: string; iv: string; ciphertext: string }
): Promise<{ note: Note }> {
  return requestJson(`/api/conversations/${encodeURIComponent(contact)}/notes`, {
    method: 'POST',
    body: JSON.stringify({ workspace, ...encrypted }),
  });
}
