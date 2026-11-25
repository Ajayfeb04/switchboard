import { useCallback, useEffect, useState } from 'react';
import {
  addNote,
  claimConversation,
  fetchConversations,
  fetchMe,
  fetchThread,
  logout,
  releaseConversation,
  sendReply,
  setConversationStatus,
} from './api/client';
import { ConversationList } from './components/ConversationList';
import { LoginView } from './components/LoginView';
import { ThreadView } from './components/ThreadView';
import { useWorkspaceWs } from './hooks/useWorkspaceWs';
import { encryptNoteText } from './lib/e2ee';
import type { Conversation, MeUser, Message, Note, WsFrame } from './types';

export function App() {
  const [user, setUser] = useState<MeUser | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [activeWorkspace, setActiveWorkspace] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'open' | 'closed'>('all');
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedContact, setSelectedContact] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [threadLoading, setThreadLoading] = useState(false);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);

  useEffect(() => {
    fetchMe()
      .then((me) => {
        setUser(me);
        if (me.workspaces.length > 0) {
          setActiveWorkspace(me.workspaces[0].id);
        }
      })
      .catch(() => {
        setUser(null);
      })
      .finally(() => setAuthChecked(true));
  }, []);

  const loadConversations = useCallback(async () => {
    if (!activeWorkspace) return;
    try {
      const res = await fetchConversations(activeWorkspace, statusFilter);
      setConversations(res.conversations);
      setSelectedContact((prev) => {
        if (prev && res.conversations.some((c) => c.contact === prev)) return prev;
        return res.conversations[0]?.contact ?? null;
      });
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : 'Failed to load conversations');
    }
  }, [activeWorkspace, statusFilter]);

  useEffect(() => {
    void loadConversations();
  }, [loadConversations]);

  useEffect(() => {
    if (!activeWorkspace || !selectedContact) {
      setMessages([]);
      setNotes([]);
      return;
    }
    setThreadLoading(true);
    fetchThread(activeWorkspace, selectedContact)
      .then((res) => {
        setMessages(res.messages);
        setNotes(res.notes);
      })
      .catch((err) => {
        setErrorBanner(err instanceof Error ? err.message : 'Failed to load thread');
      })
      .finally(() => setThreadLoading(false));
  }, [activeWorkspace, selectedContact]);

  const handleWsFrame = useCallback(
    (frame: WsFrame) => {
      if (frame.type === 'message.inbound') {
        void loadConversations();
        if (frame.contact === selectedContact) {
          setMessages((prev) => {
            if (prev.some((m) => m.messageId === frame.message_id)) return prev;
            const nextMsg: Message = {
              workspace: activeWorkspace,
              contact: frame.contact,
              direction: 'inbound',
              messageId: frame.message_id,
              clientRef: null,
              text: frame.text ?? '',
              status: 'received',
              occurredAt: frame.occurred_at ?? new Date().toISOString(),
              createdAt: new Date().toISOString(),
            };
            return [...prev, nextMsg].sort(
              (a, b) => new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime()
            );
          });
        }
      } else if (frame.type === 'message.status') {
        if (frame.contact === selectedContact) {
          setMessages((prev) => {
            const exists = prev.some((m) => m.clientRef === frame.client_ref);
            if (!exists && frame.text) {
              return [
                ...prev,
                {
                  workspace: activeWorkspace,
                  contact: frame.contact,
                  direction: 'outbound',
                  messageId: null,
                  clientRef: frame.client_ref,
                  text: frame.text,
                  status: frame.status,
                  occurredAt: frame.occurred_at ?? new Date().toISOString(),
                  createdAt: new Date().toISOString(),
                },
              ];
            }
            return prev.map((m) =>
              m.clientRef === frame.client_ref ? { ...m, status: frame.status } : m
            );
          });
        }
        void loadConversations();
      } else if (frame.type === 'conversation.assigned') {
        setConversations((prev) =>
          prev.map((c) =>
            c.contact === frame.contact
              ? {
                  ...c,
                  assignee: frame.assignee,
                  ...(frame.status ? { status: frame.status } : {}),
                }
              : c
          )
        );
      }
    },
    [activeWorkspace, loadConversations, selectedContact]
  );

  const wsStatus = useWorkspaceWs(activeWorkspace || null, handleWsFrame);

  if (!authChecked) {
    return <div className="loading-screen">Checking session...</div>;
  }

  if (!user) {
    return <LoginView />;
  }

  const activeConversation = conversations.find((c) => c.contact === selectedContact) ?? null;
  const workspaceRole = user.workspaces.find((w) => w.id === activeWorkspace)?.role ?? 'agent';

  const handleClaim = async () => {
    if (!selectedContact) return;
    setErrorBanner(null);
    try {
      const res = await claimConversation(activeWorkspace, selectedContact);
      setConversations((prev) =>
        prev.map((c) => (c.contact === selectedContact ? res.conversation : c))
      );
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : 'Claim failed');
    }
  };

  const handleRelease = async () => {
    if (!selectedContact) return;
    setErrorBanner(null);
    try {
      const res = await releaseConversation(activeWorkspace, selectedContact);
      setConversations((prev) =>
        prev.map((c) => (c.contact === selectedContact ? res.conversation : c))
      );
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : 'Release failed');
    }
  };

  const handleToggleStatus = async (next: 'open' | 'closed') => {
    if (!selectedContact) return;
    setErrorBanner(null);
    try {
      const res = await setConversationStatus(activeWorkspace, selectedContact, next);
      setConversations((prev) =>
        prev.map((c) => (c.contact === selectedContact ? res.conversation : c))
      );
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : 'Status update failed');
    }
  };

  const handleSendReply = async (text: string) => {
    if (!selectedContact) return;
    setErrorBanner(null);
    const clientRef = `ui_${crypto.randomUUID()}`;
    const res = await sendReply(activeWorkspace, selectedContact, text, clientRef);
    setMessages((prev) => {
      if (prev.some((m) => m.clientRef === res.message.clientRef)) return prev;
      return [...prev, res.message];
    });
  };

  const handleAddNote = async (body: string) => {
    if (!selectedContact || !user) return;
    const encrypted = await encryptNoteText(activeWorkspace, selectedContact, user.sub, body);
    const res = await addNote(activeWorkspace, selectedContact, encrypted);
    setNotes((prev) => [...prev, res.note]);
  };

  const handleLogout = async () => {
    await logout();
    setUser(null);
    setActiveWorkspace('');
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-left">
          <span className="brand-dot" />
          <strong>Switchboard</strong>
          <span className={`ws-status ws-${wsStatus}`}>Live: {wsStatus}</span>
        </div>
        <div className="topbar-right">
          <span className="user-chip">
            {user.name ?? user.sub} ({workspaceRole})
          </span>
          <button type="button" className="btn btn-secondary" onClick={() => void handleLogout()}>
            Sign out
          </button>
        </div>
      </header>

      {errorBanner && (
        <div className="error-banner" role="alert">
          <span>{errorBanner}</span>
          <button type="button" onClick={() => setErrorBanner(null)}>
            ×
          </button>
        </div>
      )}

      <main className="inbox-layout">
        <ConversationList
          workspaces={user.workspaces}
          activeWorkspace={activeWorkspace}
          onWorkspaceChange={(ws) => {
            setSelectedContact(null);
            setActiveWorkspace(ws);
          }}
          statusFilter={statusFilter}
          onStatusFilterChange={setStatusFilter}
          conversations={conversations}
          selectedContact={selectedContact}
          onSelectContact={setSelectedContact}
        />

        <ThreadView
          user={user}
          workspaceRole={workspaceRole}
          conversation={activeConversation}
          messages={messages}
          notes={notes}
          loading={threadLoading}
          onClaim={handleClaim}
          onRelease={handleRelease}
          onToggleStatus={handleToggleStatus}
          onSendReply={handleSendReply}
          onAddNote={handleAddNote}
        />
      </main>
    </div>
  );
}
