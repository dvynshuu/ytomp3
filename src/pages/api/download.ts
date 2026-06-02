import { getInnertube } from '../../lib/innertube-cache';
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

export async function GET({ request }: { request: Request }) {
  const urlParams = new URL(request.url).searchParams;
  const videoUrl = urlParams.get('url');
  const format = urlParams.get('format') || 'mp3'; // 'mp3' or 'mp4'
  const quality = urlParams.get('quality');

  if (!videoUrl) {
    return new Response('Missing URL parameter', { status: 400 });
  }

  const videoId = getYouTubeID(videoUrl);
  if (!videoId) {
    return new Response('Invalid YouTube URL', { status: 400 });
  }

  try {
    // Use cached Innertube instance — avoids 2-8s cold start
    const yt = await getInnertube();
    const info = await yt.getBasicInfo(videoId);

    if (info.playability_status && info.playability_status.status !== 'OK') {
      throw new Error(info.playability_status.reason || 'This YouTube video is restricted or unplayable.');
    }

    const title = info.basic_info.title || 'YouTube Download';
    const safeTitle = sanitizeFilename(title);

    let webStream: any;
    let contentType = '';
    let extension = '';

    const tempDir = os.tmpdir();

    if (format === 'mp3') {
      // ═══════════════════════════════════════════════════════════════════
      // MP3: STREAMING PIPELINE — pipe YouTube audio directly into ffmpeg
      // instead of downloading the entire file to disk first.
      // This eliminates the "download-to-temp-file" wait and starts
      // sending bytes to the client almost immediately.
      // ═══════════════════════════════════════════════════════════════════
      const targetBitrate = quality || '192';
      console.log(`[MP3] Streaming audio → ffmpeg pipeline for ${videoId} at ${targetBitrate}kbps`);

      // Get the YouTube audio stream (web ReadableStream)
      const ytStream = await info.download({ type: 'audio', quality: 'best' });
      const nodeReadable = Readable.fromWeb(ytStream as any);

      // Spawn FFmpeg reading from stdin (pipe:0) instead of a temp file
      const ffmpegProcess = spawn(ffmpegPath || 'ffmpeg', [
        '-hide_banner',
        '-loglevel', 'error',
        '-i', 'pipe:0',        // Read from stdin
        '-c:a', 'libmp3lame',
        '-b:a', `${targetBitrate}k`,
        '-f', 'mp3',
        'pipe:1'               // Write to stdout
      ]);

      // Pipe YouTube audio directly into ffmpeg's stdin
      nodeReadable.pipe(ffmpegProcess.stdin);

      // Handle backpressure and errors on stdin
      nodeReadable.on('error', (err) => {
        console.error('[MP3] YouTube stream error:', err.message);
        ffmpegProcess.stdin.destroy();
      });
      ffmpegProcess.stdin.on('error', (err) => {
        // EPIPE is expected if ffmpeg closes early; don't crash
        if ((err as any).code !== 'EPIPE') {
          console.error('[MP3] ffmpeg stdin error:', err.message);
        }
        nodeReadable.destroy();
      });

      webStream = Readable.toWeb(ffmpegProcess.stdout);
      contentType = 'audio/mpeg';
      extension = 'mp3';

      // Log ffmpeg errors
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

      // Kill ffmpeg + destroy YouTube stream on client abort
      if (request.signal) {
        request.signal.addEventListener('abort', () => {
          console.log('[MP3] Client aborted, killing pipeline...');
          nodeReadable.destroy();
          ffmpegProcess.kill('SIGKILL');
        });
      }

    } else {
      // ═══════════════════════════════════════════════════════════════════
      // MP4: Format selection + muxing when needed
      // ═══════════════════════════════════════════════════════════════════
      let videoFormat: any;
      let needsMuxing = false;

      // Select format based on quality
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

      // Default fallback
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
        // ─── Muxing path: download video + audio in parallel to temp files,
        //     then mux via ffmpeg. We use parallel downloads to cut wait time.
        const videoTempPath = path.join(tempDir, `yt_video_${videoId}_${Date.now()}.mp4`);
        const audioTempPath = path.join(tempDir, `yt_audio_${videoId}_${Date.now()}.m4a`);

        console.log(`[MP4-MUX] Downloading video+audio streams in parallel for ${videoId}`);

        // Start both downloads concurrently
        const [videoStream, audioStream] = await Promise.all([
          info.download({ type: 'video', quality: `${quality}p` }),
          info.download({ type: 'audio', quality: 'best' })
        ]);

        // Save both to disk in parallel
        await Promise.all([
          saveStreamToFile(videoStream, videoTempPath, request.signal),
          saveStreamToFile(audioStream, audioTempPath, request.signal)
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
        // ─── Combined format (no muxing): stream directly to client
        //     Pipe YouTube stream → client with zero temp files.
        console.log(`[MP4-DIRECT] Streaming combined format for ${videoId}`);
        const videoStream = await info.download({ type: 'video+audio', quality: `${quality}p` });
        webStream = videoStream;
        contentType = 'video/mp4';
        extension = 'mp4';
      }
    }

    const asciiTitle = safeTitle.replace(/[^\x00-\x7F]/g, '').replace(/\s+/g, ' ').trim() || 'download';

    return new Response(webStream as any, {
      status: 200,
      headers: {
        'Content-Disposition': `attachment; filename="${asciiTitle}.${extension}"; filename*=UTF-8''${encodeURIComponent(safeTitle)}.${extension}`,
        'Content-Type': contentType,
        'Cache-Control': 'no-store',
        'X-App-Version': '2.1.0'
      }
    });
  } catch (error: any) {
    console.error('Download error:', error);
    return new Response(`Failed to initiate download stream: ${error?.message || error}`, { status: 500 });
  }
}
