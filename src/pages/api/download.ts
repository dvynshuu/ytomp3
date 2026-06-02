import { getInnertube, invalidateCache, CLIENT_TYPES, getInfoWithFallback } from '../../lib/innertube-cache';
import ffmpegPath from 'ffmpeg-static';
import { spawn } from 'child_process';
import { Readable } from 'stream';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export const prerender = false;

function getYouTubeID(url: string) {
  const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|\&v=)([^#\&\?]*).*/;
  const match = url.match(regExp);
  return (match && match[2].length === 11) ? match[2] : null;
}

function sanitizeFilename(name: string) {
  return name.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim();
}

function isTimeoutError(err: any): boolean {
  const msg = String(err?.message || err);
  return msg.includes('fetch failed') || msg.includes('timeout') ||
         err?.cause?.code === 'UND_ERR_CONNECT_TIMEOUT' ||
         err?.code === 'UND_ERR_CONNECT_TIMEOUT';
}

/**
 * Saves a web ReadableStream to a local file.
 */
async function saveStreamToFile(
  stream: any,
  outputPath: string,
  requestSignal?: AbortSignal
) {
  const writeStream = fs.createWriteStream(outputPath);
  const nodeStream = Readable.fromWeb(stream as any);

  return new Promise<void>((resolve, reject) => {
    nodeStream.pipe(writeStream);
    writeStream.on('finish', () => resolve());
    writeStream.on('error', (err) => reject(err));
    nodeStream.on('error', (err) => reject(err));

    if (requestSignal) {
      requestSignal.addEventListener('abort', () => {
        writeStream.close();
        nodeStream.destroy();
        try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch (e) {}
        reject(new Error('Download aborted by user'));
      });
    }
  });
}

// (getInfoWithFallback has been moved to src/lib/innertube-cache.ts)

/**
 * Attempt to download a stream, falling back to different client types
 * if the CDN connection times out. Each fallback re-fetches video info
 * to get fresh CDN URLs pointing to different googlevideo servers.
 */
async function downloadStreamWithFallback(
  videoId: string,
  downloadOptions: any,
  startingClientIndex: number = 0
): Promise<{ stream: any; info: any; clientType: string }> {
  const errors: string[] = [];

  for (let i = startingClientIndex; i < CLIENT_TYPES.length; i++) {
    const clientType = CLIENT_TYPES[i];
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
        console.warn(`[Download] ${clientType} CDN timed out, trying next client type...`);
        invalidateCache(clientType);
        errors.push(`${clientType}: CDN timeout`);
        continue;
      }
      // Non-timeout error — might be a format issue, try next
      console.warn(`[Download] ${clientType} download error: ${err?.message}`);
      errors.push(`${clientType}: ${err?.message}`);
      continue;
    }
  }

  throw new Error(`All client types failed to download stream: ${errors.join('; ')}`);
}

export async function GET({ request }: { request: Request }) {
  const urlParams = new URL(request.url).searchParams;
  const videoUrl = urlParams.get('url');
  const format = urlParams.get('format') || 'mp3';
  const quality = urlParams.get('quality');

  if (!videoUrl) {
    return new Response('Missing URL parameter', { status: 400 });
  }

  const videoId = getYouTubeID(videoUrl);
  if (!videoId) {
    return new Response('Invalid YouTube URL', { status: 400 });
  }

  try {
    let webStream: any;
    let contentType = '';
    let extension = '';
    let workingInfo: any;

    const tempDir = os.tmpdir();

    if (format === 'mp3') {
      // ═══════════════════════════════════════════════════════════════════
      // MP3: STREAMING PIPELINE with client-type fallback
      // Downloads audio via YouTube → pipes directly into ffmpeg → client.
      // If a CDN times out, automatically retries with a different YouTube
      // client type to get routed to a different googlevideo server.
      // ═══════════════════════════════════════════════════════════════════
      const targetBitrate = quality || '192';
      console.log(`[MP3] Starting download for ${videoId} at ${targetBitrate}kbps`);

      const { stream: ytStream, info: mp3Info } = await downloadStreamWithFallback(
        videoId,
        { type: 'audio', quality: 'best' }
      );
      workingInfo = mp3Info;
      const nodeReadable = Readable.fromWeb(ytStream as any);

      // Spawn FFmpeg reading from stdin (pipe:0)
      const ffmpegProcess = spawn(ffmpegPath || 'ffmpeg', [
        '-hide_banner',
        '-loglevel', 'error',
        '-i', 'pipe:0',
        '-c:a', 'libmp3lame',
        '-b:a', `${targetBitrate}k`,
        '-f', 'mp3',
        'pipe:1'
      ]);

      // Pipe YouTube audio directly into ffmpeg's stdin
      nodeReadable.pipe(ffmpegProcess.stdin);

      // Handle backpressure and errors on stdin
      nodeReadable.on('error', (err) => {
        console.error('[MP3] YouTube stream error:', err.message);
        ffmpegProcess.stdin.destroy();
      });
      ffmpegProcess.stdin.on('error', (err) => {
        if ((err as any).code !== 'EPIPE') {
          console.error('[MP3] ffmpeg stdin error:', err.message);
        }
        nodeReadable.destroy();
      });

      webStream = Readable.toWeb(ffmpegProcess.stdout);
      contentType = 'audio/mpeg';
      extension = 'mp3';

      let ffmpegStderr = '';
      ffmpegProcess.stderr.on('data', (chunk) => {
        ffmpegStderr += chunk.toString();
      });
      ffmpegProcess.on('error', (err) => {
        console.error('[MP3] ffmpeg spawn/execution error:', err);
      });
      ffmpegProcess.on('close', (code) => {
        if (code !== 0) {
          console.error(`[MP3] ffmpeg exited with code ${code}. Stderr: ${ffmpegStderr}`);
        }
      });

      if (request.signal) {
        request.signal.addEventListener('abort', () => {
          console.log('[MP3] Client aborted, killing pipeline...');
          nodeReadable.destroy();
          ffmpegProcess.kill('SIGKILL');
        });
      }

    } else {
      // ═══════════════════════════════════════════════════════════════════
      // MP4: Get info first (with fallback), then select format + download
      // ═══════════════════════════════════════════════════════════════════
      const { info, clientType } = await getInfoWithFallback(videoId);
      workingInfo = info;
      const title = info.basic_info.title || 'YouTube Download';

      let videoFormat: any;
      let needsMuxing = false;

      if (quality === '1080') {
        videoFormat = info.chooseFormat({ type: 'video', quality: '1080p', format: 'mp4' }) ||
                      info.chooseFormat({ type: 'video', quality: '1080p' });
        needsMuxing = true;
      } else if (quality === '720') {
        videoFormat = info.streaming_data?.formats?.find((f: any) => f.itag === 22);
        if (videoFormat) {
          needsMuxing = false;
        } else {
          videoFormat = info.chooseFormat({ type: 'video', quality: '720p', format: 'mp4' }) ||
                        info.chooseFormat({ type: 'video', quality: '720p' });
          needsMuxing = true;
        }
      } else if (quality === '480') {
        videoFormat = info.chooseFormat({ type: 'video', quality: '480p', format: 'mp4' }) ||
                      info.chooseFormat({ type: 'video', quality: '480p' });
        needsMuxing = true;
      } else if (quality === '360') {
        videoFormat = info.streaming_data?.formats?.find((f: any) => f.itag === 18);
        if (videoFormat) {
          needsMuxing = false;
        } else {
          videoFormat = info.chooseFormat({ type: 'video', quality: '360p', format: 'mp4' }) ||
                        info.chooseFormat({ type: 'video', quality: '360p' });
          needsMuxing = true;
        }
      }

      if (!videoFormat) {
        videoFormat = info.streaming_data?.formats?.find((f: any) => f.itag === 22) ||
                      info.streaming_data?.formats?.find((f: any) => f.itag === 18) ||
                      info.chooseFormat({ type: 'video', quality: 'best', format: 'mp4' }) ||
                      info.chooseFormat({ type: 'video', quality: 'best' });
        needsMuxing = !info.streaming_data?.formats?.find((f: any) => f.itag === videoFormat?.itag);
      }

      if (!videoFormat) {
        throw new Error(`Requested video quality ${quality}p is not available.`);
      }

      if (needsMuxing) {
        const videoTempPath = path.join(tempDir, `yt_video_${videoId}_${Date.now()}.mp4`);
        const audioTempPath = path.join(tempDir, `yt_audio_${videoId}_${Date.now()}.m4a`);

        console.log(`[MP4-MUX] Downloading video+audio in parallel for ${videoId} via ${clientType}`);

        // Download both streams with individual client-type fallback
        const [videoResult, audioResult] = await Promise.all([
          downloadStreamWithFallback(videoId, { type: 'video', quality: `${quality}p` }),
          downloadStreamWithFallback(videoId, { type: 'audio', quality: 'best' })
        ]);

        await Promise.all([
          saveStreamToFile(videoResult.stream, videoTempPath, request.signal),
          saveStreamToFile(audioResult.stream, audioTempPath, request.signal)
        ]);

        console.log(`[MP4-MUX] Muxing downloaded streams to MP4`);
        const ffmpegProcess = spawn(ffmpegPath || 'ffmpeg', [
          '-hide_banner',
          '-loglevel', 'error',
          '-i', videoTempPath,
          '-i', audioTempPath,
          '-c:v', 'copy',
          '-c:a', 'copy',
          '-f', 'mp4',
          '-movflags', 'frag_keyframe+empty_moov',
          'pipe:1'
        ]);

        webStream = Readable.toWeb(ffmpegProcess.stdout);
        contentType = 'video/mp4';
        extension = 'mp4';

        const cleanup = () => {
          try { if (fs.existsSync(videoTempPath)) fs.unlinkSync(videoTempPath); } catch (e) {}
          try { if (fs.existsSync(audioTempPath)) fs.unlinkSync(audioTempPath); } catch (e) {}
        };

        let ffmpegStderr = '';
        ffmpegProcess.stderr.on('data', (chunk) => {
          ffmpegStderr += chunk.toString();
        });
        ffmpegProcess.on('error', (err) => {
          console.error('[MP4-MUX] ffmpeg error:', err);
          cleanup();
        });
        ffmpegProcess.on('close', (code) => {
          if (code !== 0) {
            console.error(`[MP4-MUX] ffmpeg exited with code ${code}. Stderr: ${ffmpegStderr}`);
          }
          cleanup();
        });

        if (request.signal) {
          request.signal.addEventListener('abort', () => {
            console.log('[MP4-MUX] Client aborted, cleaning up...');
            ffmpegProcess.kill('SIGKILL');
            cleanup();
          });
        }
      } else {
        // Combined format — try download with fallback
        console.log(`[MP4-DIRECT] Streaming combined format for ${videoId}`);
        const { stream: videoStream } = await downloadStreamWithFallback(
          videoId,
          { type: 'video+audio', quality: `${quality}p` }
        );
        webStream = videoStream;
        contentType = 'video/mp4';
        extension = 'mp4';
      }
    }

    // Get title for the Content-Disposition header
    const title = workingInfo?.basic_info?.title || 'YouTube Download';
    const safeTitle = sanitizeFilename(title);
    const asciiTitle = safeTitle.replace(/[^\x00-\x7F]/g, '').replace(/\s+/g, ' ').trim() || 'download';

    return new Response(webStream as any, {
      status: 200,
      headers: {
        'Content-Disposition': `attachment; filename="${asciiTitle}.${extension}"; filename*=UTF-8''${encodeURIComponent(safeTitle)}.${extension}`,
        'Content-Type': contentType,
        'Cache-Control': 'no-store',
        'X-App-Version': '2.2.0'
      }
    });
  } catch (error: any) {
    console.error('Download error:', error);
    return new Response(`Failed to initiate download stream: ${error?.message || error}`, { status: 500 });
  }
}
