import Redis from 'ioredis';

const globalSymbols = globalThis as any;

if (!globalSymbols.redisConnection) {
  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
  console.log(`[Redis] Connecting to ${redisUrl}...`);
  globalSymbols.redisConnection = new Redis(redisUrl, {
    maxRetriesPerRequest: null,
    connectTimeout: 5000,
    enableOfflineQueue: false,
  });
  
  globalSymbols.redisConnection.on('error', (err: any) => {
    console.error('[Redis] Connection error:', err);
  });
}

export const redisConnection: Redis = globalSymbols.redisConnection;
