import Redis from 'ioredis';

const globalSymbols = globalThis as any;

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

// Helper to construct connection options with TLS support for rediss:// URLs
function getRedisOptions(maxRetries: number | null) {
  const options: any = {
    maxRetriesPerRequest: maxRetries,
    connectTimeout: 5000,
    enableOfflineQueue: true,
  };

  if (redisUrl.startsWith('rediss://')) {
    options.tls = {
      rejectUnauthorized: false,
    };
  }

  return options;
}

// 1. General Redis connection for metadata cache (fails fast if offline)
if (!globalSymbols.redisConnection) {
  console.log(`[Redis-Cache] Connecting to ${redisUrl}...`);
  globalSymbols.redisConnection = new Redis(redisUrl, getRedisOptions(3));
  
  globalSymbols.redisConnection.on('error', (err: any) => {
    console.error('[Redis-Cache] Connection error:', err);
  });
}

// 2. Dedicated connection for BullMQ (requires maxRetriesPerRequest: null)
if (!globalSymbols.queueRedisConnection) {
  console.log(`[Redis-Queue] Connecting to ${redisUrl}...`);
  globalSymbols.queueRedisConnection = new Redis(redisUrl, getRedisOptions(null));
  
  globalSymbols.queueRedisConnection.on('error', (err: any) => {
    console.error('[Redis-Queue] Connection error:', err);
  });
}

export const redisConnection: Redis = globalSymbols.redisConnection;
export const queueRedisConnection: Redis = globalSymbols.queueRedisConnection;
