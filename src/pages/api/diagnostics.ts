import { Innertube, Platform } from 'youtubei.js';
import ffmpegPath from 'ffmpeg-static';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// Setup signature decipher shim for Innertube
if (typeof Platform !== 'undefined' && Platform.shim) {
  Platform.shim.eval = async (data: any, args: any) => {
    const fn = new Function(...Object.keys(args), data.output);
    return fn(...Object.values(args));
  };
}

export const prerender = false;

export async function GET() {
  const diagnostics: Record<string, any> = {
    timestamp: new Date().toISOString(),
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    env: {}
  };

  // 1. Check Env Vars (safely)
  const cookie = process.env.YOUTUBE_COOKIE;
  diagnostics.env.YOUTUBE_COOKIE = cookie 
    ? { exists: true, length: cookie.length, prefix: cookie.substring(0, 15) + '...' }
    : { exists: false };

  const poToken = process.env.PO_TOKEN;
  diagnostics.env.PO_TOKEN = poToken
    ? { exists: true, length: poToken.length }
    : { exists: false };

  const visitorData = process.env.VISITOR_DATA;
  diagnostics.env.VISITOR_DATA = visitorData
    ? { exists: true, length: visitorData.length }
    : { exists: false };

  // 2. Check FFmpeg availability and execute permission
  try {
    diagnostics.ffmpeg = { path: ffmpegPath };
    if (ffmpegPath) {
      const { stdout } = await execAsync(`"${ffmpegPath}" -version`);
      diagnostics.ffmpeg.works = true;
      diagnostics.ffmpeg.version = stdout.split('\n')[0];
    } else {
      diagnostics.ffmpeg.works = false;
      diagnostics.ffmpeg.error = 'ffmpegPath is undefined or empty';
    }
  } catch (err: any) {
    diagnostics.ffmpeg.works = false;
    diagnostics.ffmpeg.error = err?.message || String(err);
  }

  // 3. Test Innertube and Video Info
  const testVideoId = 'dQw4w9WgXcQ';
  try {
    const yt = await Innertube.create({
      client_type: cookie ? 'MWEB' : 'ANDROID_VR',
      cookie: cookie ? cookie.replace(/^(cookie|Cookie):\s*/i, '').trim().replace(/^["']|["']$/g, '').trim() : undefined,
      po_token: poToken ? poToken.replace(/^(po_token|poToken):\s*/i, '').trim().replace(/^["']|["']$/g, '').trim() : undefined,
      visitor_data: visitorData ? visitorData.replace(/^(visitor_data|visitorData):\s*/i, '').trim().replace(/^["']|["']$/g, '').trim() : undefined
    });
    diagnostics.innertube = { status: 'created' };

    const info = await yt.getBasicInfo(testVideoId);
    diagnostics.innertube.getBasicInfo = 'success';
    diagnostics.innertube.title = info.basic_info.title;

    // Analyze formats
    const formats = [
      ...(info.streaming_data?.formats || []),
      ...(info.streaming_data?.adaptive_formats || [])
    ];
    diagnostics.formatsCount = formats.length;
    diagnostics.formatsList = formats.map((f: any) => ({
      itag: f.itag,
      quality: f.quality_label || f.quality || 'unknown',
      mimeType: f.mime_type,
      hasUrl: !!f.url,
      hasCipher: !!(f.signature_cipher || f.cipher),
      isSabr: !f.url && !(f.signature_cipher || f.cipher)
    }));

    // Test stream download initialization
    try {
      const stream = await info.download({ type: 'audio', quality: 'best' });
      diagnostics.innertube.streamInit = 'success';
      diagnostics.innertube.streamType = stream.constructor.name;
    } catch (streamErr: any) {
      diagnostics.innertube.streamInit = 'failed';
      diagnostics.innertube.streamError = streamErr?.message || String(streamErr);
    }
  } catch (err: any) {
    diagnostics.innertube = { status: 'failed', error: err?.message || String(err) };
  }

  return new Response(JSON.stringify(diagnostics, null, 2), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store'
    }
  });
}
