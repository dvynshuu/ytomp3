import { Innertube, Platform } from 'youtubei.js';
import ffmpegPath from 'ffmpeg-static';
import { spawn } from 'child_process';
import { Readable } from 'stream';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Setup signature decipher shim for Innertube
if (typeof Platform !== 'undefined' && Platform.shim) {
  Platform.shim.eval = async (data: any, args: any) => {
    const fn = new Function(...Object.keys(args), data.output);
    return fn(...Object.values(args));
  };
}

export const prerender = false;

function getYouTubeID(url: string) {
  const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|\&v=)([^#\&\?]*).*/;
  const match = url.match(regExp);
  return (match && match[2].length === 11) ? match[2] : null;
}

function sanitizeFilename(name: string) {
  // Remove characters that are illegal in Windows/Mac/Linux filenames
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

  try {
    const yt = await Innertube.create({
      client_type: cookie ? 'MWEB' : 'ANDROID_VR',
      cookie,
      po_token: poToken,
      visitor_data: visitorData
    });
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
      const audioTempPath = path.join(tempDir, `yt_audio_${videoId}_${Date.now()}.m4a`);
      console.log(`Downloading audio stream via youtubei.js for video ${videoId}`);
      const ytStream = await info.download({ type: 'audio', quality: 'best' });
      await saveStreamToFile(ytStream, audioTempPath, request.signal);

      const targetBitrate = quality || '192';
      console.log(`Transcoding downloaded local audio to MP3 at ${targetBitrate}kbps`);
      // Spawn FFmpeg to transcode to MP3 on-the-fly
      const ffmpegProcess = spawn(ffmpegPath || 'ffmpeg', [
        '-hide_banner',
        '-loglevel', 'error',
        '-i', audioTempPath,
        '-c:a', 'libmp3lame',
        '-b:a', `${targetBitrate}k`,
        '-f', 'mp3',
        'pipe:1'
      ]);

      webStream = Readable.toWeb(ffmpegProcess.stdout);
      contentType = 'audio/mpeg';
      extension = 'mp3';

      // Log ffmpeg errors and clean up temp file
      let ffmpegStderr = '';
      ffmpegProcess.stderr.on('data', (chunk) => {
        ffmpegStderr += chunk.toString();
      });
      ffmpegProcess.on('error', (err) => {
        console.error('ffmpegProcess spawn/execution error:', err);
        try { if (fs.existsSync(audioTempPath)) fs.unlinkSync(audioTempPath); } catch (e) {}
      });
      ffmpegProcess.on('close', (code) => {
        if (code !== 0) {
          console.error(`ffmpeg process exited with code ${code}. Stderr: ${ffmpegStderr}`);
        }
        try { if (fs.existsSync(audioTempPath)) fs.unlinkSync(audioTempPath); } catch (e) {}
      });

      // Kill ffmpeg process and clean up on client abort
      if (request.signal) {
        request.signal.addEventListener('abort', () => {
          console.log('Client aborted download, killing ffmpeg process...');
          ffmpegProcess.kill('SIGKILL');
          try { if (fs.existsSync(audioTempPath)) fs.unlinkSync(audioTempPath); } catch (e) {}
        });
      }
    } else {
      // MP4 Video format selection
      let videoFormat: any;
      let needsMuxing = false;

      // Select format based on quality
      if (quality === '1080') {
        videoFormat = info.chooseFormat({ type: 'video', quality: '1080p', format: 'mp4' }) ||
                      info.chooseFormat({ type: 'video', quality: '1080p' });
        needsMuxing = true;
      } else if (quality === '720') {
        // Try to find combined 720p first (itag 22)
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
        // Try to find combined 360p first (itag 18)
        videoFormat = info.streaming_data?.formats?.find((f: any) => f.itag === 18);
        if (videoFormat) {
          needsMuxing = false;
        } else {
          videoFormat = info.chooseFormat({ type: 'video', quality: '360p', format: 'mp4' }) ||
                        info.chooseFormat({ type: 'video', quality: '360p' });
          needsMuxing = true;
        }
      }

      // Default fallback if requested quality is missing
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

        console.log(`Downloading video and audio streams via youtubei.js for video ${videoId}`);
        const videoStream = await info.download({ type: 'video', quality: `${quality}p` });
        const audioStream = await info.download({ type: 'audio', quality: 'best' });

        await Promise.all([
          saveStreamToFile(videoStream, videoTempPath, request.signal),
          saveStreamToFile(audioStream, audioTempPath, request.signal)
        ]);

        console.log(`Muxing downloaded video and audio on-the-fly to MP4`);
        // Spawn FFmpeg to copy-mux streams on-the-fly
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

        // Log ffmpeg errors and clean up temp files
        let ffmpegStderr = '';
        ffmpegProcess.stderr.on('data', (chunk) => {
          ffmpegStderr += chunk.toString();
        });
        ffmpegProcess.on('error', (err) => {
          console.error('ffmpegProcess video mux spawn/execution error:', err);
          cleanup();
        });
        ffmpegProcess.on('close', (code) => {
          if (code !== 0) {
            console.error(`ffmpeg process exited with code ${code}. Stderr: ${ffmpegStderr}`);
          }
          cleanup();
        });

        // Kill ffmpeg process and clean up on client abort
        if (request.signal) {
          request.signal.addEventListener('abort', () => {
            console.log('Client aborted download, killing ffmpeg process...');
            ffmpegProcess.kill('SIGKILL');
            cleanup();
          });
        }
      } else {
        // Direct stream download for combined format (no FFmpeg needed)
        const tempPath = path.join(tempDir, `yt_combined_${videoId}_${Date.now()}.mp4`);
        console.log(`Downloading combined video stream via youtubei.js`);
        const videoStream = await info.download({ type: 'video', quality: `${quality}p` });
        await saveStreamToFile(videoStream, tempPath, request.signal);

        const readStream = fs.createReadStream(tempPath);
        webStream = Readable.toWeb(readStream);
        contentType = 'video/mp4';
        extension = 'mp4';

        readStream.on('close', () => {
          try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch (e) {}
        });

        if (request.signal) {
          request.signal.addEventListener('abort', () => {
            console.log('Client aborted download, cleaning up...');
            readStream.destroy();
            try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch (e) {}
          });
        }
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
