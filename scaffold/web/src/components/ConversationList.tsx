import type { Conversation, WorkspaceMembership } from '../types';

interface ConversationListProps {
  workspaces: WorkspaceMembership[];
  activeWorkspace: string;
  onWorkspaceChange: (ws: string) => void;
  statusFilter: 'all' | 'open' | 'closed';
  onStatusFilterChange: (filter: 'all' | 'open' | 'closed') => void;
  conversations: Conversation[];
  selectedContact: string | null;
  onSelectContact: (contact: string) => void;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function ConversationList({
  workspaces,
  activeWorkspace,
  onWorkspaceChange,
  statusFilter,
  onStatusFilterChange,
  conversations,
  selectedContact,
  onSelectContact,
}: ConversationListProps) {
  return (
    <aside className="sidebar">
      <div className="sidebar-controls">
        <label className="field-label" htmlFor="ws-select">
          Workspace
        </label>
        <select
          id="ws-select"
          className="select"
          value={activeWorkspace}
          onChange={(e) => onWorkspaceChange(e.target.value)}
        >
          {workspaces.map((w) => (
            <option key={w.id} value={w.id}>
              {w.id} ({w.role})
            </option>
          ))}
        </select>

        <div className="filter-tabs" role="tablist">
          {(['all', 'open', 'closed'] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              className={`tab-btn ${statusFilter === tab ? 'active' : ''}`}
              onClick={() => onStatusFilterChange(tab)}
            >
              {tab}
            </button>
          ))}
        </div>
      </div>

      <div className="conv-list">
        {conversations.length === 0 ? (
          <div className="empty-state">No conversations yet in {activeWorkspace}.</div>
        ) : (
          conversations.map((conv) => {
            const active = conv.contact === selectedContact;
            return (
              <button
                key={conv.contact}
                type="button"
                className={`conv-item ${active ? 'active' : ''}`}
                onClick={() => onSelectContact(conv.contact)}
              >
                <div className="conv-row">
                  <span className="conv-contact">{conv.contact}</span>
                  <span className="conv-time">{formatTime(conv.lastMessageAt)}</span>
                </div>
                <div className="conv-preview">{conv.lastMessageText || '(no messages)'}</div>
                <div className="conv-meta">
                  <span className={`pill ${conv.status === 'closed' ? 'pill-muted' : 'pill-open'}`}>
                    {conv.status}
                  </span>
                  {conv.assignee ? (
                    <span className="pill pill-assigned">{conv.assignee}</span>
                  ) : (
                    <span className="pill pill-unassigned">unassigned</span>
                  )}
                </div>
              </button>
            );
          })
        )}
      </div>
    </aside>
  );
}
