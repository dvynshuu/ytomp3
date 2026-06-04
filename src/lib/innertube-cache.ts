import { Innertube, Platform } from 'youtubei.js';
import { getOrGenerateTokens, invalidateTokens } from './po-token';

// Setup signature decipher shim for Innertube (once)
if (typeof Platform !== 'undefined' && Platform.shim) {
  Platform.shim.eval = async (data: any, args: any) => {
    const fn = new Function(...Object.keys(args), data.output);
    return fn(...Object.values(args));
  };
}

// ─── Multi-client Innertube cache ──────────────────────────────────────
// Focused on 3 client types that actually work with PO tokens.
// Each client type is cached independently with a 30-minute TTL.

interface CachedInstance {
  instance: Innertube;
  createdAt: number;
}

const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const instanceCache = new Map<string, CachedInstance>();

// Reduced client types — only those that reliably work with PO tokens.
// WEB has the broadest format support, MWEB/ANDROID are good fallbacks.
export const CLIENT_TYPES = ['WEB', 'MWEB', 'ANDROID'] as const;

/**
 * Get cookie from environment variable (cleaned).
 */
function getEnvCookie(): string | undefined {
  let cookie = process.env.YOUTUBE_COOKIE || undefined;
  if (cookie) {
    cookie = cookie.replace(/^(cookie|Cookie):\s*/i, '').trim().replace(/^["']|["']$/g, '').trim();
  }
  return cookie;
}

/**
 * Custom fetch wrapper that times out the connection/header phase
 * to prevent hanging requests on network blocks/dropped packets.
 */
function fetchWithTimeout(timeoutMs: number = 30000): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(input, {
        ...init,
        signal: controller.signal
      });
      clearTimeout(id);
      return response;
    } catch (err: any) {
      clearTimeout(id);
      if (err.name === 'AbortError') {
        throw new Error(`Request timed out after ${timeoutMs}ms`);
      }
      throw err;
    }
  };
}

/**
 * Get or create an Innertube instance for a specific client type.
 * Automatically uses PO tokens from the po-token module.
 * Cached for 30 minutes.
 */
export async function getInnertube(clientType?: string): Promise<Innertube> {
  const tokens = await getOrGenerateTokens();
  const cookie = getEnvCookie();
  const resolvedType = clientType || 'WEB';
  const now = Date.now();
  const cacheKey = resolvedType;

  const cached = instanceCache.get(cacheKey);
  if (cached && (now - cached.createdAt) < CACHE_TTL_MS) {
    return cached.instance;
  }

  console.log(`[Innertube] Creating ${resolvedType} client (poToken: ${tokens.poToken ? 'yes' : 'no'}, visitorData: ${tokens.visitorData ? 'yes' : 'no'}, cookie: ${cookie ? 'yes' : 'no'})`);

  const instance = await Innertube.create({
    client_type: resolvedType as any,
    po_token: tokens.poToken,
    visitor_data: tokens.visitorData,
    cookie,
    fetch: fetchWithTimeout(30000)
  });

  instanceCache.set(cacheKey, { instance, createdAt: now });
  return instance;
}

/**
 * Invalidate cached instance for a specific client type.
 */
export function invalidateCache(clientType?: string) {
  if (clientType) {
    instanceCache.delete(clientType);
  } else {
    instanceCache.clear();
  }
}

function isBotDetectionError(err: any): boolean {
  const msg = String(err?.message || err);
  return msg.includes('Sign in to confirm') || msg.includes('not a bot');
}

function isTimeoutError(err: any): boolean {
  const msg = String(err?.message || err);
  return msg.includes('fetch failed') || msg.includes('timeout') || msg.includes('timed out') ||
         err?.cause?.code === 'UND_ERR_CONNECT_TIMEOUT' ||
         err?.code === 'UND_ERR_CONNECT_TIMEOUT';
}

/**
 * Fetch video info with client-type fallback and automatic token refresh.
 * 
 * Strategy:
 *  1. Try each client type with current tokens
 *  2. On bot detection: refresh tokens and retry once
 *  3. On timeout: move to next client type
 */
export async function getInfoWithFallback(videoId: string): Promise<{ info: any; clientType: string }> {
  const errors: string[] = [];
  let tokenRefreshed = false;

  for (const clientType of CLIENT_TYPES) {
    try {
      const yt = await getInnertube(clientType);
      const info = await yt.getBasicInfo(videoId);

      if (info.playability_status && info.playability_status.status !== 'OK') {
        const reason = info.playability_status.reason || 'Video unplayable';
        console.warn(`[Fallback] ${clientType} returned unplayable: ${reason}`);
        errors.push(`${clientType}: ${reason}`);
        continue;
      }

      return { info, clientType };
    } catch (err: any) {
      console.warn(`[Fallback] ${clientType} getBasicInfo failed: ${err?.message}`);
      errors.push(`${clientType}: ${err?.message}`);
      invalidateCache(clientType);

      // On bot detection, refresh tokens and retry with same client
      if (isBotDetectionError(err) && !tokenRefreshed) {
        console.log('[Fallback] Bot detection triggered — refreshing PO tokens...');
        tokenRefreshed = true;
        invalidateTokens();
        instanceCache.clear();

        try {
          const yt = await getInnertube(clientType);
          const info = await yt.getBasicInfo(videoId);

          if (info.playability_status && info.playability_status.status === 'OK') {
            return { info, clientType };
          }
        } catch (retryErr: any) {
          console.warn(`[Fallback] Retry after token refresh failed: ${retryErr?.message}`);
          errors.push(`${clientType}(retry): ${retryErr?.message}`);
        }
      }

      continue;
    }
  }

  throw new Error(`All client types failed to fetch video info: ${errors.join('; ')}`);
}

/**
 * Attempt to download a stream, falling back through client types.
 */
export async function downloadStreamWithFallback(
  videoId: string,
  downloadOptions: any
): Promise<{ stream: any; info: any; clientType: string }> {
  const errors: string[] = [];
  let tokenRefreshed = false;

  for (const clientType of CLIENT_TYPES) {
    try {
      const yt = await getInnertube(clientType);
      const info = await yt.getBasicInfo(videoId);

      if (info.playability_status && info.playability_status.status !== 'OK') {
        errors.push(`${clientType}: unplayable`);
        continue;
      }

      console.log(`[Download] Trying ${clientType} client for stream...`);
      const stream = await info.download(downloadOptions);
      return { stream, info, clientType };
    } catch (err: any) {
      if (isTimeoutError(err)) {
        console.warn(`[Download] ${clientType} CDN timed out, trying fallback...`);
        invalidateCache(clientType);
        errors.push(`${clientType}: CDN timeout`);
        continue;
      }

      // On bot detection, refresh tokens and retry
      if (isBotDetectionError(err) && !tokenRefreshed) {
        console.log('[Download] Bot detection triggered — refreshing PO tokens...');
        tokenRefreshed = true;
        invalidateTokens();
        instanceCache.clear();

        try {
          const yt = await getInnertube(clientType);
          const info = await yt.getBasicInfo(videoId);
          const stream = await info.download(downloadOptions);
          return { stream, info, clientType };
        } catch (retryErr: any) {
          errors.push(`${clientType}(retry): ${retryErr?.message}`);
        }
      }

      console.warn(`[Download] ${clientType} download error: ${err?.message}`);
      errors.push(`${clientType}: ${err?.message}`);
      continue;
    }
  }

  throw new Error(`All client types failed to download stream: ${errors.join('; ')}`);
}

// Eagerly warm the primary client on module load
getInnertube().catch(() => {});

export function findVideoFormat(info: any, qualityPrefix: string) {
  const formats = [
    ...info.streaming_data?.formats || [],
    ...info.streaming_data?.adaptive_formats || []
  ];

  // Filter for video formats matching qualityPrefix
  const candidates = formats.filter((f: any) => {
    if (!f.has_video) return false;
    const label = f.quality_label || f.quality || '';
    return label.startsWith(qualityPrefix);
  });

  if (candidates.length === 0) return undefined;

  // Prioritize mp4 over other containers (e.g. webm)
  const mp4Candidates = candidates.filter((f: any) => f.mime_type?.includes('mp4'));
  if (mp4Candidates.length > 0) {
    return mp4Candidates.sort((a: any, b: any) => (a.bitrate || 0) - (b.bitrate || 0))[0];
  }

  // Fallback to any matching format sorted by bitrate ascending
  return candidates.sort((a: any, b: any) => (a.bitrate || 0) - (b.bitrate || 0))[0];
}
