import { BG, type BgConfig } from 'bgutils-js';
import { JSDOM } from 'jsdom';
import { Innertube } from 'youtubei.js';

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
let generationPromise: Promise<CachedTokens> | null = null;

/**
 * Get cached tokens or generate fresh ones.
 * Environment variables take priority over auto-generated tokens.
 */
export async function getOrGenerateTokens(): Promise<{
  poToken: string | undefined;
  visitorData: string | undefined;
}> {
  // 1. Environment variables take priority
  const envPoToken = cleanEnvVar(process.env.PO_TOKEN);
  const envVisitorData = cleanEnvVar(process.env.VISITOR_DATA);

  if (envPoToken && envVisitorData) {
    return { poToken: envPoToken, visitorData: envVisitorData };
  }

  // 2. Check in-memory cache
  if (cachedTokens && (Date.now() - cachedTokens.generatedAt) < TOKEN_TTL_MS) {
    return { poToken: cachedTokens.poToken, visitorData: cachedTokens.visitorData };
  }

  // 3. Generate fresh tokens (coalesce concurrent calls)
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
  console.log('[PoToken] Token cache invalidated, will regenerate on next request');
}

/**
 * Generate fresh PO token + visitor data using bgutils-js.
 */
async function generateFreshTokens(): Promise<CachedTokens> {
  const startTime = Date.now();
  console.log('[PoToken] Generating fresh PO token + visitor data...');

  // Step 1: Create a lightweight Innertube instance to get visitorData
  const innertube = await Innertube.create({ retrieve_player: false });
  const visitorData = innertube.session.context.client.visitorData;

  if (!visitorData) {
    throw new Error('Could not obtain visitor data from Innertube session');
  }

  // Step 2: Set up JSDOM for BotGuard VM execution
  const dom = new JSDOM();
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document
  });

  // Step 3: Fetch and solve BotGuard challenge
  const bgConfig: BgConfig = {
    fetch: (input: string | URL | globalThis.Request, init?: RequestInit) => fetch(input, init),
    globalObj: globalThis,
    identifier: visitorData,
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

  // Step 6: Cache and return
  cachedTokens = {
    poToken: poTokenResult.poToken,
    visitorData,
    generatedAt: Date.now()
  };

  return cachedTokens;
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
