import { getInfoWithFallback, findVideoFormat } from '../../lib/innertube-cache';
import { redisConnection } from '../../lib/redis';
import { conversionQueue, mp3Dir, mp4Dir } from '../../lib/queue';
import * as fs from 'fs';
import * as path from 'path';

export const prerender = false;

const MAX_DURATION = 60 * 60; // 60 minutes
const MAX_FILE_SIZE_MB = 2048; // 2GB

function getYouTubeID(url: string) {
  const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|\&v=)([^#\&\?]*).*/;
  const match = url.match(regExp);
  return (match && match[2].length === 11) ? match[2] : null;
}

export async function GET({ request }: { request: Request }) {
  const urlParams = new URL(request.url).searchParams;
  const videoUrl = urlParams.get('url');
  const format = urlParams.get('format') || 'mp3';
  const quality = urlParams.get('quality') || (format === 'mp3' ? '192' : '720');

  if (!videoUrl) {
    return new Response(JSON.stringify({ error: 'Missing YouTube URL' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const videoId = getYouTubeID(videoUrl);
  if (!videoId) {
    return new Response(JSON.stringify({ error: 'Invalid YouTube URL' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    // 1. Get metadata (from Redis cache or fetch and cache)
    const cacheKeyMeta = `ytomp3:meta:${videoId}`;
    let metadata: any = null;
    const cachedMeta = await redisConnection.get(cacheKeyMeta);

    if (cachedMeta) {
      metadata = JSON.parse(cachedMeta);
    } else {
      // Fetch metadata from YouTube and store in Redis for 24h
      const { info } = await getInfoWithFallback(videoId);
      
      const title = info.basic_info.title || 'YouTube Video';
      const author = info.basic_info.author || 'Unknown Creator';
      const durationSeconds = info.basic_info.duration || 0;
      const thumbnails = info.basic_info.thumbnail || [];
      const thumbnail = thumbnails.length > 0 ? thumbnails[thumbnails.length - 1].url : `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;

      // Helper to compute size
      const getFormatSizeMB = (f: any) => {
        if (!f) return 0;
        if (f.content_length) return Number(f.content_length) / (1024 * 1024);
        if (f.bitrate && durationSeconds) return (Number(f.bitrate) * durationSeconds) / (8 * 1024 * 1024);
        return 0;
      };

      const audioFormats = (info.streaming_data?.adaptive_formats || []).filter(
        (f: any) => f.has_audio && !f.has_video
      );
      const bestAudioFormat = audioFormats.sort((a: any, b: any) => (a.bitrate || 0) - (b.bitrate || 0))[0];
      const audioSizeMB = getFormatSizeMB(bestAudioFormat);

      const sizes: Record<string, number> = {};
      const qualities = ['1080', '720', '480', '360'];

      for (const q of qualities) {
        let videoFormat: any;
        let needsMuxing = true;

        if (q === '720') {
          videoFormat = info.streaming_data?.formats?.find((f: any) => f.itag === 22);
          if (videoFormat) needsMuxing = false;
        } else if (q === '360') {
          videoFormat = info.streaming_data?.formats?.find((f: any) => f.itag === 18);
          if (videoFormat) needsMuxing = false;
        }

        if (!videoFormat) videoFormat = findVideoFormat(info, q);

        if (videoFormat) {
          const videoSizeMB = getFormatSizeMB(videoFormat);
          sizes[q] = needsMuxing ? (videoSizeMB + audioSizeMB) : videoSizeMB;
        }
      }

      metadata = {
        videoId,
        title,
        author,
        durationSeconds,
        thumbnail,
        sizes
      };

      // Cache for 24h
      await redisConnection.setex(cacheKeyMeta, 24 * 60 * 60, JSON.stringify(metadata));
    }

    // 2. Enforce MAX_DURATION limit
    if (metadata.durationSeconds > MAX_DURATION) {
      return new Response(JSON.stringify({
        error: `Video duration exceeds the maximum limit of 60 minutes (${metadata.durationSeconds}s)`
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 3. Enforce MAX_FILE_SIZE limit
    let estimatedSizeMB = 0;
    if (format === 'mp3') {
      estimatedSizeMB = (metadata.durationSeconds * Number(quality)) / 8000;
    } else {
      estimatedSizeMB = metadata.sizes?.[quality] || (metadata.durationSeconds * 0.2); // Fallback: 200KB/s
    }

    if (estimatedSizeMB > MAX_FILE_SIZE_MB) {
      return new Response(JSON.stringify({
        error: `Estimated file size (${estimatedSizeMB.toFixed(1)} MB) exceeds the maximum limit of 2GB`
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 4. Check if already cached on disk
    const cacheFilename = `${videoId}_${quality}.${format}`;
    const cacheDir = format === 'mp3' ? mp3Dir : mp4Dir;
    const cacheFilePath = path.join(cacheDir, cacheFilename);
    const relativeDownloadKey = `${format}/${cacheFilename}`;

    if (fs.existsSync(cacheFilePath)) {
      return new Response(JSON.stringify({
        status: 'completed',
        progress: 100,
        downloadUrl: `/api/download?key=${encodeURIComponent(relativeDownloadKey)}`,
        info: metadata
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 5. Check if background job exists
    const jobId = `${format}_${videoId}_${quality}`;
    const existingJob = await conversionQueue.getJob(jobId);

    if (existingJob) {
      const state = await existingJob.getState();
      if (state === 'failed') {
        // Remove failed job so it can be retried
        await existingJob.remove();
      } else {
        // Return active job progress
        return new Response(JSON.stringify({
          status: state === 'completed' ? 'completed' : 'processing',
          progress: existingJob.progress || 0,
          jobId,
          downloadUrl: state === 'completed' ? `/api/download?key=${encodeURIComponent(relativeDownloadKey)}` : undefined,
          info: metadata
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    // 6. Enqueue new conversion job
    const newJob = await conversionQueue.add(
      'convert',
      { videoId, format, quality },
      { jobId }
    );

    return new Response(JSON.stringify({
      status: 'processing',
      progress: 0,
      jobId,
      info: metadata
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: any) {
    console.error('[API-Convert] Error:', error);
    let details = error?.message || String(error);
    if (details.includes('timed out') || details.includes('fetch failed')) {
      details += '. Tip: Deployed servers (like Render) are often blocked by YouTube. Please verify that YOUTUBE_COOKIE and PO_TOKEN are set correctly in your environment variables.';
    } else if (details.includes('Redis connection') || details.includes('redis') || details.includes('max retries') || details.includes('maxRetriesPerRequest')) {
      details += '. Tip: Please check your Redis configuration (REDIS_URL). Ensure your Redis service is running and accessible.';
    }
    return new Response(JSON.stringify({
      error: 'Failed to initiate video conversion.',
      details: details
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
