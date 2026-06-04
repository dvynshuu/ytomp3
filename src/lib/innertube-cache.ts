import { Innertube, Platform } from 'youtubei.js';

// Setup signature decipher shim for Innertube (once)
if (typeof Platform !== 'undefined' && Platform.shim) {
  Platform.shim.eval = async (data: any, args: any) => {
    const fn = new Function(...Object.keys(args), data.output);
    return fn(...Object.values(args));
  };
}

// ─── Multi-client Innertube cache ──────────────────────────────────────
// Different YouTube client types (ANDROID, WEB, etc.) return stream URLs
// pointing to different CDN servers. If one CDN node times out, we can
// fall back to a different client type to get working URLs.
//
// Each client type is cached independently with a 30-minute TTL.

interface CachedInstance {
  instance: Innertube;
  createdAt: number;
}

const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const instanceCache = new Map<string, CachedInstance>();

// Client types to try, in priority order.
// IOS and MWEB are highly effective at bypassing "Sign in to confirm you're not a bot" checks on cloud hosts.
// ANDROID is most reliable for downloads, WEB has broadest format support,
// ANDROID_VR/TV_EMBEDDED are fallbacks for age-restricted content.
export const CLIENT_TYPES = ['IOS', 'MWEB', 'ANDROID', 'WEB', 'ANDROID_VR', 'TV_EMBEDDED'] as const;

export function getAuthConfig() {
  let cookie = process.env.YOUTUBE_COOKIE || undefined;
  if (cookie) {
    cookie = cookie.replace(/^(cookie|Cookie):\s*/i, '').trim().replace(/^["']|["']$/g, '').trim();
  }

  let poToken = process.env.PO_TOKEN || undefined;
  if (poToken) {
    poToken = poToken.replace(/^(po_token|poToken):\s*/i, '').trim().replace(/^["']|["']$/g, '').trim();
  }

  let visitorData = process.env.VISITOR_DATA || undefined;
  if (visitorData) {
    visitorData = visitorData.replace(/^(visitor_data|visitorData):\s*/i, '').trim().replace(/^["']|["']$/g, '').trim();
  }

  return { cookie, poToken, visitorData };
}

/**
 * Custom fetch wrapper that times out the connection/header phase
 * to prevent hanging requests on network blocks/dropped packets.
 */
function fetchWithTimeout(timeoutMs: number = 15000): typeof fetch {
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
 * Get or create an Innertube instance for a specific client type, with optional auth.
 * Cached for 30 minutes.
 */
export async function getInnertube(clientType?: string, useAuth: boolean = true): Promise<Innertube> {
  const auth = useAuth ? getAuthConfig() : { cookie: undefined, poToken: undefined, visitorData: undefined };
  const resolvedType = clientType || (auth.cookie ? 'MWEB' : CLIENT_TYPES[0]);
  const now = Date.now();
  const cacheKey = `${resolvedType}_${useAuth ? 'auth' : 'noauth'}`;

  const cached = instanceCache.get(cacheKey);
  if (cached && (now - cached.createdAt) < CACHE_TTL_MS) {
    return cached.instance;
  }

  console.log(`[Innertube] Creating new ${resolvedType} client instance (auth: ${useAuth})...`);
  const instance = await Innertube.create({
    client_type: resolvedType as any,
    cookie: auth.cookie,
    po_token: auth.poToken,
    visitor_data: auth.visitorData,
    fetch: fetchWithTimeout(15000)
  });

  instanceCache.set(cacheKey, { instance, createdAt: now });
  return instance;
}

/**
 * Invalidate cached instance for a specific client type and auth status.
 */
export function invalidateCache(clientType?: string, useAuth: boolean = true) {
  if (clientType) {
    const cacheKey = `${clientType}_${useAuth ? 'auth' : 'noauth'}`;
    instanceCache.delete(cacheKey);
  } else {
    instanceCache.clear();
  }
}

function isTimeoutError(err: any): boolean {
  const msg = String(err?.message || err);
  return msg.includes('fetch failed') || msg.includes('timeout') ||
         err?.cause?.code === 'UND_ERR_CONNECT_TIMEOUT' ||
         err?.code === 'UND_ERR_CONNECT_TIMEOUT';
}

interface ClientConfig {
  type: string;
  useAuth: boolean;
}

function getFallbackConfigs(): ClientConfig[] {
  const auth = getAuthConfig();
  const hasAuth = !!(auth.cookie || auth.poToken);
  const configs: ClientConfig[] = [];

  // If auth is provided, prioritize trying configurations with auth
  if (hasAuth) {
    for (const type of CLIENT_TYPES) {
      configs.push({ type, useAuth: true });
    }
  }
  // Then try configurations without auth
  for (const type of CLIENT_TYPES) {
    configs.push({ type, useAuth: false });
  }

  return configs;
}

/**
 * Fetch video info with client-type fallback and auth fallback.
 */
export async function getInfoWithFallback(videoId: string): Promise<{ info: any; clientType: string; useAuth: boolean }> {
  const errors: string[] = [];
  const configs = getFallbackConfigs();

  for (const config of configs) {
    try {
      const yt = await getInnertube(config.type, config.useAuth);
      const info = await yt.getBasicInfo(videoId);

      if (info.playability_status && info.playability_status.status !== 'OK') {
        const reason = info.playability_status.reason || 'Video unplayable';
        console.warn(`[Fallback] ${config.type} (auth: ${config.useAuth}) returned unplayable: ${reason}`);
        errors.push(`${config.type}(auth:${config.useAuth}): ${reason}`);
        continue;
      }

      return { info, clientType: config.type, useAuth: config.useAuth };
    } catch (err: any) {
      console.warn(`[Fallback] ${config.type} (auth: ${config.useAuth}) getBasicInfo failed: ${err?.message}`);
      errors.push(`${config.type}(auth:${config.useAuth}): ${err?.message}`);
      invalidateCache(config.type, config.useAuth);
      continue;
    }
  }

  throw new Error(`All client types failed to fetch video info: ${errors.join('; ')}`);
}

/**
 * Attempt to download a stream, falling back through client types and auth options.
 */
export async function downloadStreamWithFallback(
  videoId: string,
  downloadOptions: any
): Promise<{ stream: any; info: any; clientType: string; useAuth: boolean }> {
  const errors: string[] = [];
  const configs = getFallbackConfigs();

  for (const config of configs) {
    try {
      const yt = await getInnertube(config.type, config.useAuth);
      const info = await yt.getBasicInfo(videoId);

      if (info.playability_status && info.playability_status.status !== 'OK') {
        errors.push(`${config.type}(auth:${config.useAuth}): unplayable`);
        continue;
      }

      console.log(`[Download] Trying ${config.type} client (auth: ${config.useAuth}) for stream...`);
      const stream = await info.download(downloadOptions);
      return { stream, info, clientType: config.type, useAuth: config.useAuth };
    } catch (err: any) {
      if (isTimeoutError(err)) {
        console.warn(`[Download] ${config.type} (auth: ${config.useAuth}) CDN timed out, trying fallback...`);
        invalidateCache(config.type, config.useAuth);
        errors.push(`${config.type}(auth:${config.useAuth}): CDN timeout`);
        continue;
      }
      console.warn(`[Download] ${config.type} (auth: ${config.useAuth}) download error: ${err?.message}`);
      errors.push(`${config.type}(auth:${config.useAuth}): ${err?.message}`);
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


