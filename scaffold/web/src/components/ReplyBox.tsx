import { useState, type FormEvent, type KeyboardEvent } from 'react';

interface ReplyBoxProps {
  disabled: boolean;
  isClosed: boolean;
  onSend: (text: string) => Promise<void>;
  onReopen: () => Promise<void>;
}

export function ReplyBox({ disabled, isClosed, onSend, onReopen }: ReplyBoxProps) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);

  if (isClosed) {
    return (
      <div className="reply-closed-banner">
        <span>This conversation is closed.</span>
        <button type="button" className="btn btn-secondary" onClick={() => void onReopen()}>
          Reopen conversation
        </button>
      </div>
    );
  }

  const submit = async () => {
    const trimmed = text.trim();
    if (!trimmed || sending || disabled) return;
    setSending(true);
    setText('');
    try {
      await onSend(trimmed);
    } catch {
      setText(trimmed);
    } finally {
      setSending(false);
    }
  };

  const onFormSubmit = (e: FormEvent) => {
    e.preventDefault();
    void submit();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <form className="reply-box" onSubmit={onFormSubmit}>
      <textarea
        className="reply-input"
        rows={2}
        placeholder="Write a reply... (Enter to send, Shift+Enter for new line)"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        disabled={disabled || sending}
      />
      <button type="submit" className="btn btn-primary" disabled={disabled || sending || !text.trim()}>
        {sending ? 'Sending...' : 'Send'}
      </button>
    </form>
  );
}
