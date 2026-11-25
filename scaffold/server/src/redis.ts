import { Redis } from 'ioredis';
import { config } from './config.js';

let redis: Redis | undefined;
let subscriber: Redis | undefined;

export function getRedis(): Redis {
  if (!redis) {
    redis = new Redis(config.redisUrl, {
      lazyConnect: false,
      maxRetriesPerRequest: 2,
    });
  }
  return redis;
}

export function getSubscriber(): Redis {
  if (!subscriber) {
    subscriber = new Redis(config.redisUrl, {
      lazyConnect: false,
      maxRetriesPerRequest: 2,
    });
  }
  return subscriber;
}

/** Delete application state keys in Redis while keeping login sessions intact. */
export async function resetAppRedis(): Promise<void> {
  const r = getRedis();
  const prefixes = ['ws:seq:*', 'ws:log:*', 'pigeon:*'];
  for (const pattern of prefixes) {
    let cursor = '0';
    do {
      const [next, keys] = await r.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
      cursor = next;
      if (keys.length > 0) {
        await r.del(...keys);
      }
    } while (cursor !== '0');
  }
}

export async function closeRedis(): Promise<void> {
  const tasks: Promise<unknown>[] = [];
  if (redis) {
    tasks.push(redis.quit().catch(() => redis?.disconnect()));
    redis = undefined;
  }
  if (subscriber) {
    tasks.push(subscriber.quit().catch(() => subscriber?.disconnect()));
    subscriber = undefined;
  }
  await Promise.all(tasks);
}
