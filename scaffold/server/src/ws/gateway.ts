import type { IncomingMessage, Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { getMissedWorkspaceEvents, wsChannel, type WorkspaceEventFrame } from '../lib/events.js';
import { getSubscriber } from '../redis.js';
import { loadSessionFromCookie } from '../routes/auth.js';

interface ClientState {
  ws: WebSocket;
  workspace: string;
  lastSentSeq: number;
  ready: boolean;
  buffer: WorkspaceEventFrame[];
}

const clientsByWorkspace = new Map<string, Set<ClientState>>();
const subscribedChannels = new Set<string>();
let wss: WebSocketServer | undefined;
let subscriberBound = false;

function sendFrame(client: ClientState, frame: WorkspaceEventFrame): void {
  if (client.ws.readyState !== WebSocket.OPEN) return;
  if (frame.seq <= client.lastSentSeq) return;
  client.lastSentSeq = frame.seq;
  client.ws.send(JSON.stringify(frame));
}

async function ensureChannelSubscribed(workspace: string): Promise<void> {
  const channel = wsChannel(workspace);
  if (subscribedChannels.has(channel)) return;
  subscribedChannels.add(channel);
  const sub = getSubscriber();
  if (!subscriberBound) {
    subscriberBound = true;
    sub.on('message', (chan, raw) => {
      const wsId = chan.startsWith('ws:events:') ? chan.slice('ws:events:'.length) : '';
      const set = clientsByWorkspace.get(wsId);
      if (!set || set.size === 0) return;

      let frame: WorkspaceEventFrame;
      try {
        frame = JSON.parse(raw) as WorkspaceEventFrame;
      } catch {
        return;
      }

      for (const client of set) {
        if (!client.ready) {
          client.buffer.push(frame);
        } else {
          sendFrame(client, frame);
        }
      }
    });
  }
  await sub.subscribe(channel);
}

function rejectUpgrade(socket: import('node:stream').Duplex, statusCode: number, reason: string): void {
  socket.write(`HTTP/1.1 ${statusCode} ${reason}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

export async function initWsGateway(server: Server): Promise<void> {
  wss = new WebSocketServer({ noServer: true });

  // Pre-subscribe known workspaces so Pub/Sub is warm before traffic arrives
  await Promise.all([
    ensureChannelSubscribed('ws_acme'),
    ensureChannelSubscribed('ws_globex'),
  ]);

  server.on('upgrade', (req: IncomingMessage, socket, head) => {
    void (async () => {
      const url = new URL(req.url || '/', 'http://localhost');
      if (url.pathname !== '/ws') {
        rejectUpgrade(socket, 404, 'Not Found');
        return;
      }

      const workspace = url.searchParams.get('workspace') || '';
      const afterRaw = url.searchParams.get('after');

      const session = await loadSessionFromCookie(req.headers.cookie);
      if (!session) {
        rejectUpgrade(socket, 401, 'Unauthorized');
        return;
      }

      const isMember = session.user.workspaces.some((w) => w.id === workspace);
      if (!workspace || !isMember) {
        rejectUpgrade(socket, 403, 'Forbidden');
        return;
      }

      await ensureChannelSubscribed(workspace);

      wss!.handleUpgrade(req, socket, head, (ws) => {
        const hasAfter = afterRaw !== null && afterRaw !== '' && /^\d+$/.test(afterRaw);
        const afterSeq = hasAfter ? Number(afterRaw) : null;

        const client: ClientState = {
          ws,
          workspace,
          lastSentSeq: afterSeq ?? 0,
          ready: !hasAfter,
          buffer: [],
        };

        let set = clientsByWorkspace.get(workspace);
        if (!set) {
          set = new Set();
          clientsByWorkspace.set(workspace, set);
        }
        set.add(client);

        ws.on('close', () => {
          set?.delete(client);
        });
        ws.on('error', () => {
          set?.delete(client);
        });

        if (hasAfter && afterSeq !== null) {
          void getMissedWorkspaceEvents(workspace, afterSeq)
            .then((missed) => {
              const combined = [...missed, ...client.buffer].sort((a, b) => a.seq - b.seq);
              client.buffer = [];
              for (const frame of combined) {
                sendFrame(client, frame);
              }
              client.ready = true;
            })
            .catch(() => {
              client.ready = true;
            });
        }
      });
    })().catch(() => {
      try {
        socket.destroy();
      } catch {
        // ignore
      }
    });
  });
}

export async function closeWsGateway(): Promise<void> {
  if (wss) {
    await new Promise<void>((resolve) => wss!.close(() => resolve()));
    wss = undefined;
  }
  clientsByWorkspace.clear();
  subscribedChannels.clear();
}
