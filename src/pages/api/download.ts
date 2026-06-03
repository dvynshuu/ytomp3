import { redisConnection } from '../../lib/redis';
import { mp3Dir, mp4Dir } from '../../lib/queue';
import { Readable } from 'stream';
import * as fs from 'fs';
import * as path from 'path';

export const prerender = false;

const CACHE_DIR = process.env.CACHE_DIR || path.join(process.cwd(), '.cache', 'downloads');

function sanitizeFilename(name: string) {
  return name.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim();
}

export async function GET({ request }: { request: Request }) {
  const urlParams = new URL(request.url).searchParams;
  const key = urlParams.get('key');

  if (!key) {
    // If someone calls the old API endpoint without the key (e.g. url, format, quality)
    const videoUrl = urlParams.get('url');
    if (videoUrl) {
      return new Response(
        JSON.stringify({ 
          error: 'Synchronous downloading is no longer supported to protect server resources. Please use the background conversion queue (/api/convert) first.' 
        }), 
        { 
          status: 400, 
          headers: { 'Content-Type': 'application/json' } 
        }
      );
    }
    
    return new Response('Missing key parameter', { status: 400 });
  }

  // 1. Validate key structure to prevent directory traversal
  // Key format: format/videoId_quality.ext (e.g., mp3/dQw4w9WgXcQ_192.mp3)
  const keyRegex = /^(mp3|mp4)\/[a-zA-Z0-9_-]{11}_[a-zA-Z0-9_]+\.(mp3|mp4)$/;
  if (!keyRegex.test(key)) {
    return new Response('Invalid download key', { status: 400 });
  }

  try {
    const targetFilePath = path.join(CACHE_DIR, key);

    // Double check path resolution safety
    const relativePath = path.relative(CACHE_DIR, targetFilePath);
    const isPathSafe = relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath);

    if (!isPathSafe || !fs.existsSync(targetFilePath)) {
      return new Response('File not found or expired from cache', { status: 404 });
    }

    // 2. Extract videoId and format from the key
    const parts = key.split('/');
    const format = parts[0]; // mp3 or mp4
    const filename = parts[1]; // videoId_quality.ext
    
    const lastUnderscore = filename.lastIndexOf('_');
    const videoId = filename.substring(0, lastUnderscore);

    // 3. Fetch title from Redis metadata cache if available
    let title = 'YouTube Download';
    try {
      const cacheKeyMeta = `ytomp3:meta:${videoId}`;
      const cachedMeta = await redisConnection.get(cacheKeyMeta);
      if (cachedMeta) {
        const metadata = JSON.parse(cachedMeta);
        title = metadata.title || title;
      }
    } catch (e) {
      console.warn('[Download] Failed to fetch video title from Redis:', e);
    }

    // 4. Set headers and stream the file
    const stat = fs.statSync(targetFilePath);
    const nodeStream = fs.createReadStream(targetFilePath);
    const webStream = Readable.toWeb(nodeStream as any);

    const safeTitle = sanitizeFilename(title);
    const asciiTitle = safeTitle.replace(/[^\x00-\x7F]/g, '').replace(/\s+/g, ' ').trim() || 'download';
    const contentType = format === 'mp3' ? 'audio/mpeg' : 'video/mp4';

    return new Response(webStream as any, {
      status: 200,
      headers: {
        'Content-Disposition': `attachment; filename="${asciiTitle}.${format}"; filename*=UTF-8''${encodeURIComponent(safeTitle)}.${format}`,
        'Content-Type': contentType,
        'Content-Length': stat.size.toString(),
        'Cache-Control': 'public, max-age=31536000, immutable',
        'X-App-Version': '2.2.0'
      }
    });

  } catch (error: any) {
    console.error('[API-Download] Error:', error);
    return new Response('An error occurred while preparing your download.', { status: 500 });
  }
}
