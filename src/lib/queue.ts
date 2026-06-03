import { Queue, Worker } from 'bullmq';
import { redisConnection } from './redis';
import { downloadStreamWithFallback, getInfoWithFallback, findVideoFormat } from './innertube-cache';
import ffmpegPath from 'ffmpeg-static';
import { spawn } from 'child_process';
import { Readable } from 'stream';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const globalSymbols = globalThis as any;

const CACHE_DIR = process.env.CACHE_DIR || path.join(process.cwd(), '.cache', 'downloads');
export const mp3Dir = path.join(CACHE_DIR, 'mp3');
export const mp4Dir = path.join(CACHE_DIR, 'mp4');

// Ensure cache directories exist
try {
  fs.mkdirSync(mp3Dir, { recursive: true });
  fs.mkdirSync(mp4Dir, { recursive: true });
} catch (e) {
  console.error('[Queue] Failed to create cache directories:', e);
}

if (!globalSymbols.conversionQueue) {
  globalSymbols.conversionQueue = new Queue('conversion-queue', {
    connection: redisConnection,
    defaultJobOptions: {
      removeOnComplete: true,
      removeOnFail: false, // Keep failed jobs for logs/status
    }
  });
}

export const conversionQueue: Queue = globalSymbols.conversionQueue;

/**
 * Saves a stream to a file while updating progress.
 */
async function saveStreamWithProgress(
  stream: any,
  outputPath: string,
  totalBytes: number,
  onProgress: (bytesRead: number) => void
) {
  const writeStream = fs.createWriteStream(outputPath);
  const nodeStream = Readable.fromWeb(stream as any);
  let bytesRead = 0;

  return new Promise<void>((resolve, reject) => {
    nodeStream.pipe(writeStream);
    nodeStream.on('data', (chunk) => {
      bytesRead += chunk.length;
      onProgress(bytesRead);
    });
    writeStream.on('finish', () => resolve());
    writeStream.on('error', (err) => reject(err));
    nodeStream.on('error', (err) => reject(err));
  });
}

/**
 * Executes the conversion job inside the BullMQ worker context.
 */
async function runConversionJob(job: any, videoId: string, format: string, quality: string) {
  const tempFiles: string[] = [];

  const cleanup = () => {
    for (const file of tempFiles) {
      try {
        if (fs.existsSync(file)) {
          fs.unlinkSync(file);
        }
      } catch (e) {
        console.error(`[Worker] Failed to clean up temp file ${file}:`, e);
      }
    }
  };

  try {
    if (format === 'mp3') {
      const targetFilePath = path.join(mp3Dir, `${videoId}_${quality}.mp3`);
      const tempFilePath = path.join(os.tmpdir(), `yt_transcode_${videoId}_${quality}_${Date.now()}.mp3`);
      tempFiles.push(tempFilePath);

      console.log(`[Worker] Starting MP3 conversion for ${videoId} at ${quality}kbps`);
      job.updateProgress(5);

      const { stream: ytStream, info } = await downloadStreamWithFallback(videoId, { type: 'audio', quality: 'best' });
      job.updateProgress(15);

      // Find total bytes to report download progress
      const audioFormats = (info.streaming_data?.adaptive_formats || []).filter(
        (f: any) => f.has_audio && !f.has_video
      );
      const bestAudioFormat = audioFormats.sort((a: any, b: any) => (b.bitrate || 0) - (a.bitrate || 0))[0];
      const totalBytes = Number(bestAudioFormat?.content_length) || 0;

      const nodeStream = Readable.fromWeb(ytStream as any);

      // Spawn FFmpeg to transcode directly to the temp file
      const ffmpegProcess = spawn(ffmpegPath || 'ffmpeg', [
        '-hide_banner',
        '-loglevel', 'error',
        '-i', 'pipe:0',
        '-c:a', 'libmp3lame',
        '-b:a', `${quality}k`,
        '-f', 'mp3',
        '-y',
        tempFilePath
      ]);

      let bytesRead = 0;
      nodeStream.on('data', (chunk) => {
        bytesRead += chunk.length;
        if (totalBytes > 0) {
          // Download accounts for 15% to 80% progress
          const pct = 15 + Math.round((bytesRead / totalBytes) * 65);
          job.updateProgress(Math.min(80, pct));
        }
      });

      nodeStream.pipe(ffmpegProcess.stdin);

      nodeStream.on('error', (err) => {
        console.error('[Worker] YT Stream error:', err.message);
        ffmpegProcess.stdin.destroy();
      });

      ffmpegProcess.stdin.on('error', (err) => {
        if ((err as any).code !== 'EPIPE') {
          console.error('[Worker] FFmpeg stdin error:', err.message);
        }
        nodeStream.destroy();
      });

      let ffmpegStderr = '';
      ffmpegProcess.stderr.on('data', (chunk) => {
        ffmpegStderr += chunk.toString();
      });

      await new Promise<void>((resolve, reject) => {
        ffmpegProcess.on('close', (code) => {
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`FFmpeg exited with code ${code}. Stderr: ${ffmpegStderr}`));
          }
        });
        ffmpegProcess.on('error', (err) => reject(err));
      });

      job.updateProgress(90);
      
      // Move temp file to persistent cache path
      fs.renameSync(tempFilePath, targetFilePath);
      job.updateProgress(100);
      console.log(`[Worker] Completed MP3 conversion for ${videoId}`);

    } else {
      // MP4 Flow
      const targetFilePath = path.join(mp4Dir, `${videoId}_${quality}.mp4`);
      const tempFilePath = path.join(os.tmpdir(), `yt_mux_${videoId}_${quality}_${Date.now()}.mp4`);
      tempFiles.push(tempFilePath);

      console.log(`[Worker] Starting MP4 download/mux for ${videoId} at ${quality}p`);
      job.updateProgress(5);

      const { info } = await getInfoWithFallback(videoId);
      job.updateProgress(10);

      let videoFormat: any;
      let needsMuxing = false;

      if (quality === '1080' || quality === '720' || quality === '480' || quality === '360') {
        if (quality === '720') {
          videoFormat = info.streaming_data?.formats?.find((f: any) => f.itag === 22);
        } else if (quality === '360') {
          videoFormat = info.streaming_data?.formats?.find((f: any) => f.itag === 18);
        }

        if (videoFormat) {
          needsMuxing = false;
        } else {
          videoFormat = findVideoFormat(info, quality);
          needsMuxing = true;
        }
      }

      if (!videoFormat) {
        videoFormat = info.streaming_data?.formats?.find((f: any) => f.itag === 22) ||
                      info.streaming_data?.formats?.find((f: any) => f.itag === 18) ||
                      findVideoFormat(info, '1080') ||
                      findVideoFormat(info, '720') ||
                      findVideoFormat(info, '480') ||
                      findVideoFormat(info, '360');
        needsMuxing = !info.streaming_data?.formats?.find((f: any) => f.itag === videoFormat?.itag);
      }

      if (!videoFormat) {
        throw new Error(`Requested video quality ${quality}p is not available.`);
      }

      const targetQuality = videoFormat.quality_label || videoFormat.quality || `${quality}p`;

      if (needsMuxing) {
        const videoTempPath = path.join(os.tmpdir(), `yt_vid_${videoId}_${quality}_${Date.now()}.mp4`);
        const audioTempPath = path.join(os.tmpdir(), `yt_aud_${videoId}_${quality}_${Date.now()}.m4a`);
        tempFiles.push(videoTempPath, audioTempPath);

        console.log(`[Worker] Downloading tracks in parallel for muxing: video quality ${targetQuality}`);
        
        const [videoResult, audioResult] = await Promise.all([
          downloadStreamWithFallback(videoId, { type: 'video', quality: targetQuality }),
          downloadStreamWithFallback(videoId, { type: 'audio', quality: 'best' })
        ]);
        job.updateProgress(20);

        // Fetch format size parameters
        const audioFormats = (info.streaming_data?.adaptive_formats || []).filter(
          (f: any) => f.has_audio && !f.has_video
        );
        const bestAudioFormat = audioFormats.sort((a: any, b: any) => (b.bitrate || 0) - (a.bitrate || 0))[0];
        
        const videoTotalBytes = Number(videoFormat.content_length) || 0;
        const audioTotalBytes = Number(bestAudioFormat?.content_length) || 0;
        const totalCombinedBytes = videoTotalBytes + audioTotalBytes;

        let videoBytesRead = 0;
        let audioBytesRead = 0;

        const updateMuxProgress = () => {
          if (totalCombinedBytes > 0) {
            const currentCombined = videoBytesRead + audioBytesRead;
            // Download accounts for 20% to 85% progress
            const pct = 20 + Math.round((currentCombined / totalCombinedBytes) * 65);
            job.updateProgress(Math.min(85, pct));
          }
        };

        await Promise.all([
          saveStreamWithProgress(videoResult.stream, videoTempPath, videoTotalBytes, (bytes) => {
            videoBytesRead = bytes;
            updateMuxProgress();
          }),
          saveStreamWithProgress(audioResult.stream, audioTempPath, audioTotalBytes, (bytes) => {
            audioBytesRead = bytes;
            updateMuxProgress();
          })
        ]);

        console.log(`[Worker] Muxing video and audio tracks...`);
        job.updateProgress(90);

        const ffmpegProcess = spawn(ffmpegPath || 'ffmpeg', [
          '-hide_banner',
          '-loglevel', 'error',
          '-i', videoTempPath,
          '-i', audioTempPath,
          '-c:v', 'copy',
          '-c:a', 'copy',
          '-f', 'mp4',
          '-movflags', 'frag_keyframe+empty_moov',
          '-y',
          tempFilePath
        ]);

        let ffmpegStderr = '';
        ffmpegProcess.stderr.on('data', (chunk) => {
          ffmpegStderr += chunk.toString();
        });

        await new Promise<void>((resolve, reject) => {
          ffmpegProcess.on('close', (code) => {
            if (code === 0) {
              resolve();
            } else {
              reject(new Error(`FFmpeg muxing exited with code ${code}. Stderr: ${ffmpegStderr}`));
            }
          });
          ffmpegProcess.on('error', (err) => reject(err));
        });

      } else {
        // Direct Combined Format Stream
        console.log(`[Worker] Downloading combined video stream for ${videoId}`);
        const { stream: videoStream } = await downloadStreamWithFallback(videoId, { type: 'video+audio', quality: targetQuality });
        job.updateProgress(20);

        const totalBytes = Number(videoFormat.content_length) || 0;
        
        let bytesRead = 0;
        await saveStreamWithProgress(videoStream, tempFilePath, totalBytes, (bytes) => {
          bytesRead = bytes;
          if (totalBytes > 0) {
            const pct = 20 + Math.round((bytesRead / totalBytes) * 75);
            job.updateProgress(Math.min(95, pct));
          }
        });
      }

      job.updateProgress(98);
      // Rename temp file to final cached file path
      fs.renameSync(tempFilePath, targetFilePath);
      job.updateProgress(100);
      console.log(`[Worker] Completed MP4 conversion for ${videoId}`);
    }
  } finally {
    cleanup();
  }
}

if (!globalSymbols.conversionWorker) {
  console.log('[Queue] Initializing BullMQ Worker...');
  const worker = new Worker(
    'conversion-queue',
    async (job) => {
      const { videoId, format, quality } = job.data;
      await runConversionJob(job, videoId, format, quality);
    },
    {
      connection: redisConnection,
      concurrency: 5, // Restricts concurrent FFmpeg muxes/transcodes to 5
    }
  );

  worker.on('active', (job) => {
    console.log(`[Worker] Job ${job.id} started processing.`);
  });

  worker.on('completed', (job) => {
    console.log(`[Worker] Job ${job.id} completed successfully.`);
  });

  worker.on('failed', (job, err) => {
    console.error(`[Worker] Job ${job?.id} failed with error:`, err);
  });

  globalSymbols.conversionWorker = worker;
}

export const conversionWorker: Worker = globalSymbols.conversionWorker;
