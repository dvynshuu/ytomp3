import { Innertube, Platform } from 'youtubei.js';

// Setup signature decipher shim for Innertube (once)
if (typeof Platform !== 'undefined' && Platform.shim) {
  Platform.shim.eval = async (data: any, args: any) => {
    const fn = new Function(...Object.keys(args), data.output);
    return fn(...Object.values(args));
  };
}

// ─── Cached Innertube singleton ────────────────────────────────────────
// Innertube.create() fetches and parses YouTube's player JS, builds a
// signature decipher context, etc. This takes 2-8 seconds on cold start.
// We cache the instance and reuse it across requests for the same config.
// The cache expires after 30 minutes to pick up any player changes.

interface CachedInstance {
  instance: Innertube;
  createdAt: number;
  configKey: string;
}

const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
let cached: CachedInstance | null = null;

function getConfig() {
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

  const clientType = cookie ? 'MWEB' : 'ANDROID_VR';
  const configKey = `${clientType}|${cookie || ''}|${poToken || ''}|${visitorData || ''}`;

  return { cookie, poToken, visitorData, clientType, configKey };
}

export async function getInnertube(): Promise<Innertube> {
  const config = getConfig();
  const now = Date.now();

  // Return cached instance if still valid and config matches
  if (cached && cached.configKey === config.configKey && (now - cached.createdAt) < CACHE_TTL_MS) {
    return cached.instance;
  }

  // Create new instance
  const instance = await Innertube.create({
    client_type: config.clientType as any,
    cookie: config.cookie,
    po_token: config.poToken,
    visitor_data: config.visitorData
  });

  cached = {
    instance,
    createdAt: now,
    configKey: config.configKey
  };

  return instance;
}

// Eagerly warm up the cache on module load (fire-and-forget)
getInnertube().catch(() => {});
