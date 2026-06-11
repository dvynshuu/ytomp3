import { Innertube, Platform } from 'youtubei.js';
import { getOrGenerateTokens, invalidateTokens } from './po-token';
import { getEnv } from './env';

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
// WEB_REMIX is added and prioritized for audio downloads.
export const CLIENT_TYPES = ['WEB_REMIX', 'MWEB', 'ANDROID', 'WEB'] as const;

/**
 * Get cookie from environment variable (cleaned).
 */
function getEnvCookie(): string | undefined {
  let cookie = getEnv('YOUTUBE_COOKIE');
  if (cookie) {
    cookie = cookie.replace(/^(cookie|Cookie):\s*/i, '').trim().replace(/^["']|["']$/g, '').trim();
  }
  return cookie;
}

function getClientUserAgent(client: string | null): string {
  if (client === 'MWEB') {
    return 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
  }
  if (client === 'ANDROID') {
    return 'com.google.android.youtube/21.03.36(Linux; U; Android 16; en_US; SM-S908E Build/TP1A.220624.014) gzip';
  }
  if (client === 'IOS') {
    return 'com.google.ios.youtube/20.11.6 (iPhone10,4; U; CPU iOS 16_7_7 like Mac OS X)';
  }
  return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
}

/**
 * Custom fetch wrapper that sets client-specific headers (User-Agent, Origin, Referer)
 * for googlevideo.com URLs to avoid 403 Forbidden, and implements a connection timeout.
 */
function fetchWithClientUAAndTimeout(timeoutMs: number = 30000): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);
    
    const urlStr = typeof input === 'string' ? input : (input instanceof URL ? input.toString() : (input as any).url || '');
    const newInit = init ? { ...init } : {};
    
    let headers: Record<string, string> = {};
    if (newInit.headers) {
      if (typeof (newInit.headers as any).get === 'function') {
        const h = newInit.headers as Headers;
        h.forEach((v, k) => {
          headers[k] = v;
        });
      } else if (Array.isArray(newInit.headers)) {
        for (const [k, v] of newInit.headers) {
          headers[k] = v;
        }
      } else {
        headers = { ...(newInit.headers as Record<string, string>) };
      }
    }
    
    if (urlStr.includes('googlevideo.com')) {
      try {
        const url = new URL(urlStr);
        const client = url.searchParams.get('c');
        headers['User-Agent'] = getClientUserAgent(client);
      } catch (e) {
        headers['User-Agent'] = getClientUserAgent(null);
      }
      headers['Origin'] = 'https://www.youtube.com';
      headers['Referer'] = 'https://www.youtube.com';

      const cookie = getEnvCookie();
      if (cookie) {
        headers['Cookie'] = cookie;
      }
    }
    
    newInit.headers = headers;
    newInit.signal = controller.signal;
    
    try {
      const response = await fetch(input, newInit);
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
export async function getInnertube(clientType?: string, videoId?: string): Promise<Innertube> {
  const resolvedType = clientType || 'WEB_REMIX';
  const now = Date.now();

  // Use video-bound tokens if videoId is provided
  const useVideoBound = !!videoId;
  const cacheKey = useVideoBound ? `${resolvedType}:${videoId}` : resolvedType;

  const cached = instanceCache.get(cacheKey);
  if (cached && (now - cached.createdAt) < CACHE_TTL_MS) {
    return cached.instance;
  }

  const tokens = await getOrGenerateTokens(useVideoBound ? videoId : undefined);
  const cookie = getEnvCookie();

  console.log(`[Innertube] Creating ${resolvedType} client (poToken: ${tokens.poToken ? 'yes' : 'no'}, visitorData: ${tokens.visitorData ? 'yes' : 'no'}, cookie: ${cookie ? 'yes' : 'no'})`);

  const instance = await Innertube.create({
    client_type: resolvedType as any,
    user_agent: getClientUserAgent(resolvedType),
    po_token: tokens.poToken,
    visitor_data: tokens.visitorData,
    cookie,
    fetch: fetchWithClientUAAndTimeout(30000)
  });

  instanceCache.set(cacheKey, { instance, createdAt: now });
  return instance;
}

/**
 * Invalidate cached instance for a specific client type.
 */
export function invalidateCache(clientType?: string, videoId?: string) {
  if (clientType) {
    if (clientType === 'WEB_REMIX' && videoId) {
      instanceCache.delete(`${clientType}:${videoId}`);
    } else {
      instanceCache.delete(clientType);
    }
  } else {
    instanceCache.clear();
  }
}

function isBotDetectionError(err: any): boolean {
  const msg = String(err?.message || err);
  return msg.includes('Sign in to confirm') ||
         msg.includes('not a bot');
}

function isClientCompatError(err: any): boolean {
  const msg = String(err?.message || err);
  return msg.includes('No valid URL to decipher') ||
         msg.includes('non 2xx status code');
}

function isTimeoutError(err: any): boolean {
  const msg = String(err?.message || err);
  return msg.includes('fetch failed') || msg.includes('timeout') || msg.includes('timed out') ||
         err?.cause?.code === 'UND_ERR_CONNECT_TIMEOUT' ||
         err?.code === 'UND_ERR_CONNECT_TIMEOUT';
}

function buildDownloadFailureMessage(errors: string[]): string {
  const details = errors.join('; ');
  const rejectedByYouTube = errors.some((error) =>
    error.includes('non 2xx status code') ||
    error.includes('unplayable') ||
    error.includes('LOGIN_REQUIRED') ||
    error.includes('Sign in')
  );

  if (rejectedByYouTube && !getEnvCookie()) {
    return `YouTube rejected the media stream before conversion could start. Set YOUTUBE_COOKIE from a logged-in browser session, restart the server, and try again. Details: ${details}`;
  }

  return `All client types failed to download stream: ${details}`;
}

async function probeDownloadStream(stream: any): Promise<any> {
  if (!stream || typeof stream.getReader !== 'function' || typeof ReadableStream === 'undefined') {
    return stream;
  }

  const reader = stream.getReader();
  let firstRead: any;

  try {
    firstRead = await reader.read();
  } catch (err) {
    try {
      reader.releaseLock();
    } catch {}
    throw err;
  }

  return new ReadableStream({
    async pull(controller) {
      try {
        const result = firstRead || await reader.read();
        firstRead = null;

        if (result.done) {
          try {
            reader.releaseLock();
          } catch {}
          controller.close();
          return;
        }

        controller.enqueue(result.value);
      } catch (err) {
        try {
          reader.releaseLock();
        } catch {}
        controller.error(err);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        try {
          reader.releaseLock();
        } catch {}
      }
    }
  });
}

/**
 * Fetch video info with client-type fallback and automatic token refresh.
 * 
 * Strategy:
 *  1. Try each client type with current tokens (WEB_REMIX excluded as it lacks video qualities/sizes)
 *  2. On bot detection: refresh tokens and retry once
 *  3. On timeout: move to next client type
 */
export async function getInfoWithFallback(videoId: string): Promise<{ info: any; clientType: string }> {
  const errors: string[] = [];
  let tokenRefreshed = false;
  const metadataClients = ['MWEB', 'ANDROID', 'WEB'] as const;

  for (const clientType of metadataClients) {
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

  // WEB_REMIX provides URLs for both audio and video formats.
  // MWEB is the fallback (works for non-music videos where WEB_REMIX returns unplayable).
  // ANDROID/WEB now use YouTube's SABR protocol and return no decodable URLs.
  const clientsToTry = (['WEB_REMIX', 'MWEB'] as const);

  for (const clientType of clientsToTry) {
    try {
      const yt = await getInnertube(clientType, videoId);
      
      console.log(`[Download] Fetching info for ${clientType}...`);
      let info: any;
      if (clientType === 'WEB_REMIX') {
        info = await yt.music.getInfo(videoId);
      } else {
        info = await yt.getBasicInfo(videoId);
      }

      if (info.playability_status && info.playability_status.status !== 'OK') {
        errors.push(`${clientType}: unplayable (${info.playability_status.reason || 'unknown'})`);
        continue;
      }

      console.log(`[Download] Trying ${clientType} client for stream...`);
      const stream = await probeDownloadStream(await info.download(downloadOptions));
      return { stream, info, clientType };
    } catch (err: any) {
      invalidateCache(clientType, videoId);

      if (isTimeoutError(err)) {
        console.warn(`[Download] ${clientType} CDN timed out, trying fallback...`);
        errors.push(`${clientType}: CDN timeout`);
        continue;
      }

      if (isClientCompatError(err)) {
        console.warn(`[Download] ${clientType} client compat error, trying fallback...`);
        errors.push(`${clientType}: ${err?.message}`);
        continue;
      }

      // On bot detection, refresh tokens and retry
      if (isBotDetectionError(err) && !tokenRefreshed) {
        console.log('[Download] Bot detection triggered — refreshing PO tokens...');
        tokenRefreshed = true;
        invalidateTokens();
        instanceCache.clear();

        try {
          const yt = await getInnertube(clientType, videoId);
          let info: any;
          if (clientType === 'WEB_REMIX') {
            info = await yt.music.getInfo(videoId);
          } else {
            info = await yt.getBasicInfo(videoId);
          }
          const stream = await probeDownloadStream(await info.download(downloadOptions));
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

  throw new Error(buildDownloadFailureMessage(errors));
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
