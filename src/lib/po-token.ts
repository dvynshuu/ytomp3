import { BG, type BgConfig } from 'bgutils-js';
import { JSDOM } from 'jsdom';
import { Innertube } from 'youtubei.js';
import { getEnv } from './env';

// ─── PO Token Auto-Generation ──────────────────────────────────────────
// Uses bgutils-js to generate Proof of Origin tokens required by YouTube
// to prove requests come from a legitimate client. Without these tokens,
// datacenter IPs (like Render) are flagged as bots.
//
// Flow:
//   1. Create a barebones Innertube instance to get fresh visitorData
//   2. Fetch a BotGuard challenge from YouTube
//   3. Execute the challenge JS in a JSDOM sandbox
//   4. Generate PO token via BG.PoToken.generate()
//   5. Cache result in memory with 6h TTL

interface CachedTokens {
  poToken: string;
  visitorData: string;
  generatedAt: number;
}

const TOKEN_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const REQUEST_KEY = 'O43z0dpjhgX20SCx4KAo'; // YouTube's BotGuard request key

let cachedTokens: CachedTokens | null = null;
const videoTokenCache = new Map<string, CachedTokens>();
const videoGenerationPromises = new Map<string, Promise<CachedTokens>>();
let generationPromise: Promise<CachedTokens> | null = null;
let activeWindow: any = null;

// Expose JSDOM window properties dynamically on globalThis once.
// This allows the BotGuard VM script (which is executed via new Function())
// to access browser APIs (like navigator, location, screen) in Node's global scope.
try {
  const dummyDom = new JSDOM();
  const keys = Object.getOwnPropertyNames(dummyDom.window).filter(
    k => !k.startsWith('_') && k !== 'window' && k !== 'document'
  );
  const forceOverride = new Set(['navigator', 'location', 'screen', 'history']);
  for (const key of keys) {
    if (!(key in globalThis) || forceOverride.has(key)) {
      try {
        if (key in globalThis) {
          delete (globalThis as any)[key];
        }
        Object.defineProperty(globalThis, key, {
          get: () => (globalThis as any)._activeWindow?.[key],
          set: (val) => { if ((globalThis as any)._activeWindow) (globalThis as any)._activeWindow[key] = val; },
          configurable: true
        });
      } catch (e) {
        // Ignore read-only or clashes
      }
    }
  }
} catch (e) {
  console.error('[PoToken] Failed to initialize JSDOM global wrappers:', e);
}

/**
 * Get cached tokens or generate fresh ones.
 * Environment variables take priority over auto-generated tokens.
 */
export async function getOrGenerateTokens(videoId?: string): Promise<{
  poToken: string | undefined;
  visitorData: string | undefined;
}> {
  // 1. Environment variables take priority
  const envPoToken = cleanEnvVar(getEnv('PO_TOKEN'));
  const envVisitorData = cleanEnvVar(getEnv('VISITOR_DATA'));

  if (envPoToken && envVisitorData) {
    return { poToken: envPoToken, visitorData: envVisitorData };
  }

  // 2. We bypass video-bound tokens because they require expensive JSDOM challenge execution on every new video,
  // which takes a long time (up to 30-40 seconds on low-resource container environments like Hugging Face Spaces).
  // Instead, we always use and return visitor-bound tokens, which are cached for 6 hours.
  if (videoId) {
    if (cachedTokens && (Date.now() - cachedTokens.generatedAt) < TOKEN_TTL_MS) {
      return { poToken: cachedTokens.poToken, visitorData: cachedTokens.visitorData };
    }
  }

  // 3. Otherwise, use/return the visitor-bound cached tokens
  if (cachedTokens && (Date.now() - cachedTokens.generatedAt) < TOKEN_TTL_MS) {
    return { poToken: cachedTokens.poToken, visitorData: cachedTokens.visitorData };
  }

  // 4. Generate fresh visitor tokens (coalesce concurrent calls)
  if (!generationPromise) {
    generationPromise = generateFreshTokens()
      .finally(() => { generationPromise = null; });
  }

  try {
    const tokens = await generationPromise;
    return { poToken: tokens.poToken, visitorData: tokens.visitorData };
  } catch (err) {
    console.error('[PoToken] Token generation failed:', err);
    // Return undefined so innertube can still try without tokens
    return { poToken: undefined, visitorData: undefined };
  }
}

/**
 * Force-refresh tokens (call after bot detection errors).
 */
export function invalidateTokens(): void {
  cachedTokens = null;
  videoTokenCache.clear();
  videoGenerationPromises.clear();
  console.log('[PoToken] Token cache invalidated, will regenerate on next request');
}

/**
 * Generate fresh PO token + visitor data using bgutils-js.
 */
async function generateFreshTokens(videoId?: string): Promise<CachedTokens> {
  const startTime = Date.now();
  console.log(`[PoToken] Generating fresh PO token + visitor data (${videoId ? 'video-bound' : 'visitor-bound'})...`);

  // Step 1: Create a lightweight Innertube instance to get visitorData
  const innertube = await Innertube.create({ retrieve_player: false });
  const visitorData = innertube.session.context.client.visitorData;

  if (!videoIdToUse(visitorData)) {
    throw new Error('Could not obtain visitor data from Innertube session');
  }

  // Step 2: Set up JSDOM for BotGuard VM execution
  const dom = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>', {
    url: 'https://www.youtube.com/',
    referrer: 'https://www.youtube.com/',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  activeWindow = dom.window;
  (globalThis as any)._activeWindow = dom.window;
  (globalThis as any).window = dom.window;
  (globalThis as any).document = dom.window.document;

  // Step 3: Fetch and solve BotGuard challenge
  const bgConfig: BgConfig = {
    fetch: (input: string | URL | globalThis.Request, init?: RequestInit) => fetch(input, init),
    globalObj: globalThis,
    identifier: videoId || visitorData,
    requestKey: REQUEST_KEY
  };

  const bgChallenge = await BG.Challenge.create(bgConfig);
  if (!bgChallenge) {
    throw new Error('Could not obtain BotGuard challenge from YouTube');
  }

  // Step 4: Execute the challenge interpreter script
  const interpreterJs = bgChallenge.interpreterJavascript.privateDoNotAccessOrElseSafeScriptWrappedValue;
  if (interpreterJs) {
    new Function(interpreterJs)();
  } else {
    throw new Error('BotGuard challenge interpreter script was empty');
  }

  // Step 5: Generate the PO token
  const poTokenResult = await BG.PoToken.generate({
    program: bgChallenge.program,
    globalName: bgChallenge.globalName,
    bgConfig
  });

  const elapsed = Date.now() - startTime;
  console.log(`[PoToken] Successfully generated tokens in ${elapsed}ms`);

  const newTokens = {
    poToken: poTokenResult.poToken,
    visitorData,
    generatedAt: Date.now()
  };

  if (!videoId) {
    cachedTokens = newTokens;
  }

  return newTokens;
}

/**
 * Clean environment variable values (strip quotes, prefixes, whitespace).
 */
function cleanEnvVar(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value
    .replace(/^(po_token|poToken|visitor_data|visitorData|cookie|Cookie):\s*/i, '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .trim() || undefined;
}

function videoIdToUse(val: any): val is string {
  return typeof val === 'string' && val.length > 0;
}
