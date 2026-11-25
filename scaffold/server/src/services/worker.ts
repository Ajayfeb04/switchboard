import crypto from 'node:crypto';
import { config } from '../config.js';
import { collections, type MessageDoc } from '../db.js';
import { emitWorkspaceEvent } from '../lib/events.js';
import {
  acquireWorkspaceSendSlot,
  setWorkspaceCoolOff,
  setWorkspaceOutageBackoff,
} from '../lib/rateLimit.js';

const INSTANCE_ID = crypto.randomUUID();
const POLL_INTERVAL_MS = 250;
const LEASE_MS = 8000;
const SEND_TIMEOUT_MS = 5500;
const MAX_CONCURRENCY = 4;

let timer: NodeJS.Timeout | undefined;
let running = false;
let activeCount = 0;

export function startWorker(): void {
  if (running) return;
  running = true;
  const tick = () => {
    if (!running) return;
    void pumpQueue().finally(() => {
      if (running) {
        timer = setTimeout(tick, POLL_INTERVAL_MS);
      }
    });
  };
  timer = setTimeout(tick, 50);
}

export function stopWorker(): void {
  running = false;
  if (timer) {
    clearTimeout(timer);
    timer = undefined;
  }
}

export function nudgeWorker(): void {
  if (!running) return;
  void pumpQueue();
}

async function claimNextJob(): Promise<MessageDoc | null> {
  const { messages } = await collections();
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + LEASE_MS);

  return messages.findOneAndUpdate(
    {
      direction: 'outbound',
      carrierAccepted: false,
      status: { $ne: 'failed' },
      nextAttemptAt: { $lte: now },
      $or: [{ leaseUntil: null }, { leaseUntil: { $lte: now } }],
    },
    {
      $set: {
        leaseUntil,
        leaseOwner: INSTANCE_ID,
      },
    },
    {
      sort: { nextAttemptAt: 1, createdAt: 1 },
      returnDocument: 'after',
    }
  );
}

async function pumpQueue(): Promise<void> {
  while (running && activeCount < MAX_CONCURRENCY) {
    let job: MessageDoc | null = null;
    try {
      job = await claimNextJob();
    } catch {
      return;
    }
    if (!job) return;

    activeCount++;
    void processJob(job).finally(() => {
      activeCount--;
      if (running) {
        setImmediate(() => void pumpQueue());
      }
    });
  }
}

async function rescheduleJob(
  job: MessageDoc,
  delayMs: number,
  incrementAttempts: boolean,
  lastError?: string
): Promise<void> {
  const { messages } = await collections();
  const nextAttemptAt = new Date(Date.now() + Math.max(50, delayMs));
  await messages.updateOne(
    { _id: job._id, leaseOwner: INSTANCE_ID },
    {
      $set: {
        nextAttemptAt,
        leaseUntil: null,
        leaseOwner: null,
        ...(lastError ? { lastError } : {}),
      },
      ...(incrementAttempts ? { $inc: { attempts: 1 } } : {}),
    }
  );
}

async function processJob(job: MessageDoc): Promise<void> {
  const apiKey = config.pigeon.apiKeys[job.workspace];
  if (!apiKey || !job.clientRef) {
    const { messages } = await collections();
    await messages.updateOne(
      { _id: job._id },
      { $set: { carrierAccepted: true, status: 'failed', leaseUntil: null, leaseOwner: null } }
    );
    return;
  }

  try {
    const slot = await acquireWorkspaceSendSlot(job.workspace);
    if (!slot.allowed) {
      await rescheduleJob(job, slot.waitMs, false);
      return;
    }

    const res = await fetch(`${config.pigeon.url}/v1/messages`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        'idempotency-key': job.clientRef,
      },
      body: JSON.stringify({
        to: job.contact,
        text: job.text,
        client_ref: job.clientRef,
      }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });

    if (res.ok) {
      const body = (await res.json().catch(() => ({}))) as { id?: string };
      const { messages } = await collections();
      await messages.updateOne(
        { _id: job._id },
        {
          $set: {
            carrierAccepted: true,
            leaseUntil: null,
            leaseOwner: null,
            ...(body.id ? { carrierId: body.id } : {}),
          },
        }
      );
      return;
    }

    if (res.status === 429) {
      const retryAfterRaw = Number(res.headers.get('retry-after') || '2');
      const retryAfterSec = Number.isFinite(retryAfterRaw) && retryAfterRaw > 0 ? retryAfterRaw : 2;
      await setWorkspaceCoolOff(job.workspace, retryAfterSec);
      await rescheduleJob(job, retryAfterSec * 1000 + 250, true, '429 rate limited');
      return;
    }

    if (res.status >= 500) {
      const attempts = (job.attempts ?? 0) + 1;
      const backoffMs = Math.min(4000, 600 * Math.pow(2, Math.min(attempts, 3)));
      if (res.status === 503) {
        await setWorkspaceOutageBackoff(job.workspace, backoffMs);
      }
      await rescheduleJob(job, backoffMs, true, `upstream ${res.status}`);
      return;
    }

    // Permanent 4xx rejection
    const { messages } = await collections();
    await messages.updateOne(
      { _id: job._id },
      {
        $set: {
          carrierAccepted: true,
          status: 'failed',
          leaseUntil: null,
          leaseOwner: null,
          lastError: `rejected ${res.status}`,
        },
      }
    );
    await emitWorkspaceEvent(job.workspace, {
      type: 'message.status',
      contact: job.contact,
      client_ref: job.clientRef,
      status: 'failed',
    });
  } catch (err: unknown) {
    // Timeout or transient network error: retry with the exact same Idempotency-Key.
    const msg = err instanceof Error ? err.message : String(err);
    await rescheduleJob(job, 1000, true, msg);
  }
}
