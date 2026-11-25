import { getRedis } from '../redis.js';

export type WorkspaceEventPayload =
  | {
      type: 'message.inbound';
      contact: string;
      message_id: string;
      text?: string;
      occurred_at?: string;
    }
  | {
      type: 'message.status';
      contact: string;
      client_ref: string;
      status: 'queued' | 'sent' | 'delivered' | 'failed';
      text?: string;
      occurred_at?: string;
    }
  | {
      type: 'conversation.assigned';
      contact: string;
      assignee: string | null;
      status?: 'open' | 'closed';
    };

export type WorkspaceEventFrame = WorkspaceEventPayload & {
  seq: number;
};

/**
 * Atomically allocate the next monotonic workspace seq, append to the replay
 * sorted set, and publish to Redis Pub/Sub in one Lua execution so PUBLISH
 * order always matches seq order across instances.
 */
const EMIT_LUA = `
local seq = redis.call('INCR', KEYS[1])
local frame = '{"seq":' .. seq .. ',' .. string.sub(ARGV[1], 2)
redis.call('ZADD', KEYS[2], seq, frame)
redis.call('PUBLISH', KEYS[3], frame)
return seq
`;

export function wsChannel(workspace: string): string {
  return `ws:events:${workspace}`;
}

export async function emitWorkspaceEvent(
  workspace: string,
  payload: WorkspaceEventPayload
): Promise<WorkspaceEventFrame> {
  const r = getRedis();
  const seqKey = `ws:seq:${workspace}`;
  const logKey = `ws:log:${workspace}`;
  const chan = wsChannel(workspace);
  const raw = JSON.stringify(payload);
  const seq = Number(await r.eval(EMIT_LUA, 3, seqKey, logKey, chan, raw));
  return { seq, ...payload };
}

export async function getMissedWorkspaceEvents(
  workspace: string,
  afterSeq: number
): Promise<WorkspaceEventFrame[]> {
  const r = getRedis();
  const minScore = `(${Math.max(0, Math.floor(afterSeq))}`;
  const entries = await r.zrangebyscore(`ws:log:${workspace}`, minScore, '+inf');
  const frames: WorkspaceEventFrame[] = [];
  for (const item of entries) {
    try {
      frames.push(JSON.parse(item) as WorkspaceEventFrame);
    } catch {
      // ignore malformed log entries
    }
  }
  return frames;
}
