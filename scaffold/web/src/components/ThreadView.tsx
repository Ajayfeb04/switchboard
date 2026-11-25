import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  decryptNoteText,
  getOrCreateWorkspaceKey,
  importWorkspaceKey,
} from '../lib/e2ee';
import type { Conversation, MeUser, Message, Note } from '../types';
import { ReplyBox } from './ReplyBox';

interface ThreadViewProps {
  user: MeUser;
  workspaceRole: string;
  conversation: Conversation | null;
  messages: Message[];
  notes: Note[];
  loading: boolean;
  onClaim: () => Promise<void>;
  onRelease: () => Promise<void>;
  onToggleStatus: (next: 'open' | 'closed') => Promise<void>;
  onSendReply: (text: string) => Promise<void>;
  onAddNote: (body: string) => Promise<void>;
}

function formatStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function ThreadView({
  user,
  workspaceRole,
  conversation,
  messages,
  notes,
  loading,
  onClaim,
  onRelease,
  onToggleStatus,
  onSendReply,
  onAddNote,
}: ThreadViewProps) {
  const [noteInput, setNoteInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [decryptedMap, setDecryptedMap] = useState<Record<string, string>>({});
  const [showKeyModal, setShowKeyModal] = useState(false);
  const [workspaceKeyStr, setWorkspaceKeyStr] = useState('');
  const [workspaceKeyId, setWorkspaceKeyId] = useState('');
  const [importInput, setImportInput] = useState('');
  const [keyStatusMsg, setKeyStatusMsg] = useState<string | null>(null);
  const [keyVersion, setKeyVersion] = useState(0);
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  useEffect(() => {
    if (!conversation) return;
    let cancelled = false;

    void getOrCreateWorkspaceKey(conversation.workspace).then(({ keyId, rawBase64 }) => {
      if (!cancelled) {
        setWorkspaceKeyId(keyId);
        setWorkspaceKeyStr(rawBase64);
      }
    });

    void Promise.all(
      notes.map(async (n) => {
        const res = await decryptNoteText(
          n.workspace,
          n.contact,
          n.authorSub,
          n.keyId,
          n.iv,
          n.ciphertext
        );
        return [n._id, res.ok ? res.text : `[Encrypted: ${res.reason}]`] as const;
      })
    ).then((pairs) => {
      if (!cancelled) {
        setDecryptedMap(Object.fromEntries(pairs));
      }
    });

    return () => {
      cancelled = true;
    };
  }, [conversation, notes, keyVersion]);

  if (!conversation) {
    return (
      <section className="thread-empty">
        <p>Select a conversation from the left inbox to view messages and reply.</p>
      </section>
    );
  }

  const isMine = conversation.assignee === user.sub;
  const canRelease = Boolean(conversation.assignee && (isMine || workspaceRole === 'admin'));

  const submitNote = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = noteInput.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setNoteInput('');
    try {
      await onAddNote(trimmed);
    } catch {
      setNoteInput(trimmed);
    } finally {
      setBusy(false);
    }
  };

  const handleImportKey = async (e: FormEvent) => {
    e.preventDefault();
    setKeyStatusMsg(null);
    try {
      const id = await importWorkspaceKey(conversation.workspace, importInput);
      setImportInput('');
      setKeyStatusMsg(`Imported key ${id}`);
      setKeyVersion((v) => v + 1);
    } catch (err) {
      setKeyStatusMsg(err instanceof Error ? err.message : 'Invalid key');
    }
  };

  return (
    <section className="thread-pane">
      <header className="thread-header">
        <div>
          <h2 className="thread-title">{conversation.contact}</h2>
          <div className="thread-sub">
            Status: <strong>{conversation.status}</strong> · Assignee:{' '}
            <strong>{conversation.assignee ?? 'Unassigned'}</strong>
          </div>
        </div>

        <div className="thread-actions">
          {!conversation.assignee && (
            <button type="button" className="btn btn-primary" onClick={() => void onClaim()}>
              Claim
            </button>
          )}
          {canRelease && (
            <button type="button" className="btn btn-secondary" onClick={() => void onRelease()}>
              Release
            </button>
          )}
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => void onToggleStatus(conversation.status === 'open' ? 'closed' : 'open')}
          >
            {conversation.status === 'open' ? 'Close' : 'Reopen'}
          </button>
        </div>
      </header>

      <div className="thread-body-grid">
        <div className="messages-column">
          <div className="messages-scroll">
            {loading && messages.length === 0 ? (
              <div className="empty-state">Loading messages...</div>
            ) : messages.length === 0 ? (
              <div className="empty-state">No messages yet.</div>
            ) : (
              messages.map((m) => {
                const key = m.messageId || m.clientRef || m._id || `${m.occurredAt}-${m.text}`;
                const outbound = m.direction === 'outbound';
                return (
                  <div key={key} className={`msg-row ${outbound ? 'msg-out' : 'msg-in'}`}>
                    <div className={`msg-bubble ${outbound ? 'bubble-out' : 'bubble-in'}`}>
                      <div className="msg-text">{m.text}</div>
                      <div className="msg-meta">
                        <span>{formatStamp(m.occurredAt)}</span>
                        {outbound && <span className={`status-badge status-${m.status}`}>{m.status}</span>}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
            <div ref={endRef} />
          </div>

          <ReplyBox
            disabled={false}
            isClosed={conversation.status === 'closed'}
            onSend={onSendReply}
            onReopen={() => onToggleStatus('open')}
          />
        </div>

        <aside className="notes-column">
          <div className="notes-header">
            <h3>Internal Notes (E2EE)</h3>
            <button
              type="button"
              className="btn btn-secondary btn-xs"
              onClick={() => setShowKeyModal((s) => !s)}
            >
              {showKeyModal ? 'Hide Key' : 'Key'}
            </button>
          </div>

          {showKeyModal && (
            <div className="key-box">
              <div className="small muted">Active keyId: {workspaceKeyId}</div>
              <input className="input small" readOnly value={workspaceKeyStr} onFocus={(e) => e.target.select()} />
              <form className="note-form" onSubmit={(e) => void handleImportKey(e)}>
                <input
                  className="input small"
                  placeholder="Paste teammate key..."
                  value={importInput}
                  onChange={(e) => setImportInput(e.target.value)}
                />
                <button type="submit" className="btn btn-secondary btn-xs">
                  Save
                </button>
              </form>
              {keyStatusMsg && <div className="small muted">{keyStatusMsg}</div>}
            </div>
          )}

          <div className="notes-list">
            {notes.length === 0 ? (
              <p className="muted small">
                End-to-end encrypted AES-256-GCM team notes. The server stores ciphertext only.
              </p>
            ) : (
              notes.map((n) => (
                <div key={n._id} className="note-card">
                  <div className="note-author">
                    {n.authorName} · {formatStamp(n.createdAt)}
                  </div>
                  <div className="note-body">{decryptedMap[n._id] ?? 'Decrypting...'}</div>
                </div>
              ))
            )}
          </div>
          <form className="note-form" onSubmit={(e) => void submitNote(e)}>
            <input
              className="input"
              placeholder="Add encrypted note..."
              value={noteInput}
              onChange={(e) => setNoteInput(e.target.value)}
            />
            <button type="submit" className="btn btn-secondary" disabled={busy || !noteInput.trim()}>
              Add
            </button>
          </form>
        </aside>
      </div>
    </section>
  );
}
