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
// ANDROID is most reliable for downloads, WEB has broadest format support,
// ANDROID_VR/TV_EMBEDDED are fallbacks for age-restricted content.
export const CLIENT_TYPES = ['ANDROID', 'WEB', 'ANDROID_VR', 'TV_EMBEDDED'] as const;

function getAuthConfig() {
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
 * Get or create an Innertube instance for a specific client type.
 * Cached per client type for 30 minutes.
 */
export async function getInnertube(clientType?: string): Promise<Innertube> {
  const auth = getAuthConfig();
  // If cookie is set, always use MWEB (cookie-authenticated)
  const resolvedType = auth.cookie ? 'MWEB' : (clientType || CLIENT_TYPES[0]);
  const now = Date.now();

  const cached = instanceCache.get(resolvedType);
  if (cached && (now - cached.createdAt) < CACHE_TTL_MS) {
    return cached.instance;
  }

  console.log(`[Innertube] Creating new ${resolvedType} client instance...`);
  const instance = await Innertube.create({
    client_type: resolvedType as any,
    cookie: auth.cookie,
    po_token: auth.poToken,
    visitor_data: auth.visitorData
  });

  instanceCache.set(resolvedType, { instance, createdAt: now });
  return instance;
}

/**
 * Invalidate cached instance for a specific client type (or all).
 * Forces a fresh Innertube.create() on next call.
 */
export function invalidateCache(clientType?: string) {
  if (clientType) {
    instanceCache.delete(clientType);
  } else {
    instanceCache.clear();
  }
}

/**
 * Fetch video info with client-type fallback.
 * If the primary client gets blocked (e.g. "Sign in to confirm you're not a bot"),
 * we cycle through alternative client types to get active/unblocked access.
 */
export async function getInfoWithFallback(videoId: string): Promise<{ info: any; clientType: string }> {
  const errors: string[] = [];

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
      continue;
    }
  }

  throw new Error(`All client types failed to fetch video info: ${errors.join('; ')}`);
}

// Eagerly warm the primary client on module load
getInnertube().catch(() => {});

