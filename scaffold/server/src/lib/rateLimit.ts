import { getRedis } from '../redis.js';

/**
 * Atomically update cool-off deadline in Redis only if the new deadline is
 * further in the future than any existing cool-off.
 */
const SET_MAX_TTL_LUA = `
local current = redis.call('PTTL', KEYS[1])
local nextMs = tonumber(ARGV[1])
if current < nextMs then
  redis.call('SET', KEYS[1], '1', 'PX', nextMs)
end
return 1
`;

/**
 * Shared token bucket + cool-off + outage gate per workspace in Redis.
 * Capacity 7.5 with refill 3.8/s stays safely inside Pigeon's 8 / 4 per s bucket
 * across multiple server instances while honoring explicit Retry-After cool-offs.
 */
const ACQUIRE_SLOT_LUA = `
local coolTtl = redis.call('PTTL', KEYS[1])
if coolTtl > 0 then
  return {0, coolTtl}
end
local outTtl = redis.call('PTTL', KEYS[2])
if outTtl > 0 then
  return {0, outTtl}
end

local now = tonumber(ARGV[1])
local capacity = tonumber(ARGV[2])
local refillPerMs = tonumber(ARGV[3])

local vals = redis.call('HMGET', KEYS[3], 'tokens', 'ts')
local tokens = tonumber(vals[1])
local ts = tonumber(vals[2])

if not tokens or not ts then
  tokens = capacity
  ts = now
else
  local elapsed = math.max(0, now - ts)
  tokens = math.min(capacity, tokens + elapsed * refillPerMs)
  ts = now
end

if tokens >= 1 then
  tokens = tokens - 1
  redis.call('HSET', KEYS[3], 'tokens', string.format('%.6f', tokens), 'ts', tostring(ts))
  redis.call('PEXPIRE', KEYS[3], 60000)
  return {1, 0}
end

local waitMs = math.ceil((1 - tokens) / refillPerMs)
redis.call('HSET', KEYS[3], 'tokens', string.format('%.6f', tokens), 'ts', tostring(ts))
redis.call('PEXPIRE', KEYS[3], 60000)
return {0, math.max(50, waitMs)}
`;

export async function setWorkspaceCoolOff(workspace: string, retryAfterSeconds: number): Promise<void> {
  const ms = Math.max(250, Math.ceil(retryAfterSeconds * 1000) + 200);
  await getRedis().eval(SET_MAX_TTL_LUA, 1, `pigeon:cooloff:${workspace}`, String(ms));
}

export async function setWorkspaceOutageBackoff(workspace: string, backoffMs: number): Promise<void> {
  const ms = Math.max(200, Math.ceil(backoffMs));
  await getRedis().eval(SET_MAX_TTL_LUA, 1, `pigeon:outage:${workspace}`, String(ms));
}

export async function acquireWorkspaceSendSlot(
  workspace: string
): Promise<{ allowed: true } | { allowed: false; waitMs: number }> {
  const res = (await getRedis().eval(
    ACQUIRE_SLOT_LUA,
    3,
    `pigeon:cooloff:${workspace}`,
    `pigeon:outage:${workspace}`,
    `pigeon:tb:${workspace}`,
    String(Date.now()),
    '7',
    '0.0038'
  )) as [number, number];

  if (Number(res[0]) === 1) {
    return { allowed: true };
  }
  return { allowed: false, waitMs: Math.max(50, Number(res[1]) || 250) };
}
