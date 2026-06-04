import Redis from 'ioredis';

const globalSymbols = globalThis as any;

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

// 1. General Redis connection for metadata cache (fails fast if offline)
if (!globalSymbols.redisConnection) {
  console.log(`[Redis-Cache] Connecting to ${redisUrl}...`);
  globalSymbols.redisConnection = new Redis(redisUrl, {
    maxRetriesPerRequest: 3, // Fail fast on cache hits if Redis is down
    connectTimeout: 5000,
    enableOfflineQueue: true, // Safe for startup lag
  });
  
  globalSymbols.redisConnection.on('error', (err: any) => {
    console.error('[Redis-Cache] Connection error:', err);
  });
}

// 2. Dedicated connection for BullMQ (requires maxRetriesPerRequest: null)
if (!globalSymbols.queueRedisConnection) {
  console.log(`[Redis-Queue] Connecting to ${redisUrl}...`);
  globalSymbols.queueRedisConnection = new Redis(redisUrl, {
    maxRetriesPerRequest: null, // Required by BullMQ
    connectTimeout: 5000,
    enableOfflineQueue: true,
  });
  
  globalSymbols.queueRedisConnection.on('error', (err: any) => {
    console.error('[Redis-Queue] Connection error:', err);
  });
}

export const redisConnection: Redis = globalSymbols.redisConnection;
export const queueRedisConnection: Redis = globalSymbols.queueRedisConnection;
