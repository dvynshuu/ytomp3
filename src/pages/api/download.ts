import { Innertube, Platform } from 'youtubei.js';
import ffmpegPath from 'ffmpeg-static';
import { spawn } from 'child_process';
import { Readable } from 'stream';

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

async function getVerifiedStream(info: any, options: any) {
  const stream = await info.download(options);
  
  // Peek at the first chunk to force connection and verify signatures / HTTP status
  const reader = stream.getReader();
  let firstChunk: any;
  try {
    const { value } = await reader.read();
    firstChunk = value;
    reader.releaseLock();
  } catch (err) {
    reader.releaseLock();
    throw err;
  }
  
  // Reconstruct the Web ReadableStream by prepending the peeked first chunk
  return new ReadableStream({
    async start(controller) {
      if (firstChunk) {
        controller.enqueue(firstChunk);
      }
      const r = stream.getReader();
      try {
        while (true) {
          const { done, value } = await r.read();
          if (done) {
            controller.close();
            break;
          }
          controller.enqueue(value);
        }
      } catch (err) {
        controller.error(err);
      } finally {
        r.releaseLock();
      }
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
    const yt = await Innertube.create({ client_type: 'ANDROID_VR' });
    const info = await yt.getBasicInfo(videoId);
    const title = info.basic_info.title || 'YouTube Download';
    const safeTitle = sanitizeFilename(title);

    let webStream: any;
    let contentType = '';
    let extension = '';

    if (format === 'mp3') {
      // Find the absolute best audio-only stream (Opus or AAC)
      const audioFormat = info.chooseFormat({ type: 'audio', quality: 'best' });
      if (!audioFormat) {
        throw new Error('No audio format found for this video');
      }

      const audioUrl = await audioFormat.decipher(yt.session.actions.sig_helper);
      const targetBitrate = quality || '192';
      console.log(`Transcoding audio stream (itag: ${audioFormat.itag}) for video ${videoId} to MP3 at ${targetBitrate}kbps`);

      // Spawn FFmpeg to transcode to MP3 on-the-fly 
      const ffmpegProcess = spawn(ffmpegPath || 'ffmpeg', [
        '-hide_banner',
        '-loglevel', 'error',
        '-i', audioUrl,
        '-c:a', 'libmp3lame',
        '-b:a', `${targetBitrate}k`,
        '-f', 'mp3',
        'pipe:1'
      ]);

      webStream = Readable.toWeb(ffmpegProcess.stdout);
      contentType = 'audio/mpeg';
      extension = 'mp3';

      // Log ffmpeg errors
      let ffmpegStderr = '';
      ffmpegProcess.stderr.on('data', (chunk) => {
        ffmpegStderr += chunk.toString();
      });
      ffmpegProcess.on('close', (code) => {
        if (code !== 0) {
          console.error(`ffmpeg process exited with code ${code}. Stderr: ${ffmpegStderr}`);
        }
      });

      // Kill ffmpeg process on client abort
      if (request.signal) {
        request.signal.addEventListener('abort', () => {
          console.log('Client aborted download, killing ffmpeg process...');
          ffmpegProcess.kill('SIGKILL');
        });
      }
    } else {
      // MP4 Video format selection
      let videoFormat: any;
      let audioFormat: any;
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
        audioFormat = info.chooseFormat({ type: 'audio', quality: 'best', format: 'mp4' }) ||
                      info.chooseFormat({ type: 'audio', quality: 'best' });
        if (!audioFormat) {
          throw new Error('No audio track found to mux with video.');
        }

        const videoUrl = await videoFormat.decipher(yt.session.actions.sig_helper);
        const audioUrl = await audioFormat.decipher(yt.session.actions.sig_helper);

        console.log(`Muxing video (itag: ${videoFormat.itag}) and audio (itag: ${audioFormat.itag}) on-the-fly to MP4`);

        // Spawn FFmpeg to copy-mux streams on-the-fly
        const ffmpegProcess = spawn(ffmpegPath || 'ffmpeg', [
          '-hide_banner',
          '-loglevel', 'error',
          '-i', videoUrl,
          '-i', audioUrl,
          '-c:v', 'copy',
          '-c:a', 'copy',
          '-f', 'mp4',
          '-movflags', 'frag_keyframe+empty_moov',
          'pipe:1'
        ]);

        webStream = Readable.toWeb(ffmpegProcess.stdout);
        contentType = 'video/mp4';
        extension = 'mp4';

        // Log ffmpeg errors
        let ffmpegStderr = '';
        ffmpegProcess.stderr.on('data', (chunk) => {
          ffmpegStderr += chunk.toString();
        });
        ffmpegProcess.on('close', (code) => {
          if (code !== 0) {
            console.error(`ffmpeg process exited with code ${code}. Stderr: ${ffmpegStderr}`);
          }
        });

        // Kill ffmpeg process on client abort
        if (request.signal) {
          request.signal.addEventListener('abort', () => {
            console.log('Client aborted download, killing ffmpeg process...');
            ffmpegProcess.kill('SIGKILL');
          });
        }
      } else {
        // Direct stream download for combined format (no FFmpeg needed)
        console.log(`Direct streaming combined video (itag: ${videoFormat.itag})`);
        webStream = await getVerifiedStream(info, {
          itag: videoFormat.itag
        });
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
        'Cache-Control': 'no-store'
      }
    });
  } catch (error: any) {
    console.error('Download error:', error);
    return new Response(`Failed to initiate download stream: ${error?.message || error}`, { status: 500 });
  }
}
