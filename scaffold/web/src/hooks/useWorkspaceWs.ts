import { useEffect, useRef, useState } from 'react';
import type { WsFrame } from '../types';

export function useWorkspaceWs(
  workspace: string | null,
  onFrame: (frame: WsFrame) => void
): 'connecting' | 'connected' | 'disconnected' {
  const [status, setStatus] = useState<'connecting' | 'connected' | 'disconnected'>('disconnected');
  const lastSeqRef = useRef<number>(0);
  const onFrameRef = useRef(onFrame);
  onFrameRef.current = onFrame;

  useEffect(() => {
    lastSeqRef.current = 0;
    if (!workspace) {
      setStatus('disconnected');
      return;
    }

    let closed = false;
    let ws: WebSocket | null = null;
    let retryTimer: number | undefined;

    const connect = () => {
      if (closed) return;
      setStatus('connecting');
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const afterPart = lastSeqRef.current > 0 ? `&after=${lastSeqRef.current}` : '';
      const url = `${proto}//${window.location.host}/ws?workspace=${encodeURIComponent(workspace)}${afterPart}`;
      ws = new WebSocket(url);

      ws.onopen = () => {
        if (!closed) setStatus('connected');
      };

      ws.onmessage = (ev) => {
        try {
          const frame = JSON.parse(String(ev.data)) as WsFrame;
          if (typeof frame.seq === 'number') {
            if (frame.seq > lastSeqRef.current) {
              lastSeqRef.current = frame.seq;
            }
            onFrameRef.current(frame);
          }
        } catch {
          // ignore malformed frames
        }
      };

      ws.onclose = () => {
        if (closed) return;
        setStatus('disconnected');
        retryTimer = window.setTimeout(connect, 1500);
      };

      ws.onerror = () => {
        ws?.close();
      };
    };

    connect();

    return () => {
      closed = true;
      if (retryTimer) window.clearTimeout(retryTimer);
      ws?.close();
    };
  }, [workspace]);

  return status;
}
