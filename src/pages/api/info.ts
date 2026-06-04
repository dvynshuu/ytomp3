import { getInfoWithFallback, findVideoFormat } from '../../lib/innertube-cache';
import { redisConnection } from '../../lib/redis';

export const prerender = false;

const MAX_DURATION = 60 * 60; // 60 minutes

function getYouTubeID(url: string) {
  const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|\&v=)([^#\&\?]*).*/;
  const match = url.match(regExp);
  return (match && match[2].length === 11) ? match[2] : null;
}

function formatDuration(seconds?: number) {
  if (!seconds || isNaN(seconds) || seconds < 0) return '--:--';
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  
  if (hrs > 0) {
    return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

export async function GET({ request }: { request: Request }) {
  const urlParams = new URL(request.url).searchParams;
  const videoUrl = urlParams.get('url');

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
    // 1. Check Redis cache first
    const cacheKey = `ytomp3:meta:${videoId}`;
    const cachedMeta = await redisConnection.get(cacheKey);

    if (cachedMeta) {
      const metadata = JSON.parse(cachedMeta);
      
      // Enforce duration limit on cache hits
      if (metadata.durationSeconds > MAX_DURATION) {
        return new Response(JSON.stringify({
          error: `Video duration exceeds the maximum limit of 60 minutes (${formatDuration(metadata.durationSeconds)})`
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      return new Response(JSON.stringify({
        success: true,
        ...metadata
      }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=3600'
        }
      });
    }

    // 2. Cache miss: fetch from YouTube
    const { info } = await getInfoWithFallback(videoId);

    const title = info.basic_info.title || 'YouTube Video';
    const author = info.basic_info.author || 'Unknown Creator';
    const durationSeconds = info.basic_info.duration || 0;
    const durationFormatted = formatDuration(durationSeconds);
    
    // Enforce duration limit on cache misses
    if (durationSeconds > MAX_DURATION) {
      return new Response(JSON.stringify({
        error: `Video duration exceeds the maximum limit of 60 minutes (${durationFormatted})`
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Extract high res thumbnail if possible
    const thumbnails = info.basic_info.thumbnail || [];
    const thumbnail = thumbnails.length > 0 ? thumbnails[thumbnails.length - 1].url : `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;

    // Calculate actual format sizes
    const getFormatSizeMB = (format: any) => {
      if (!format) return 0;
      if (format.content_length) {
        return Number(format.content_length) / (1024 * 1024);
      }
      if (format.bitrate && durationSeconds) {
        return (Number(format.bitrate) * durationSeconds) / (8 * 1024 * 1024);
      }
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

      if (!videoFormat) {
        videoFormat = findVideoFormat(info, q);
      }

      if (videoFormat) {
        const videoSizeMB = getFormatSizeMB(videoFormat);
        sizes[q] = needsMuxing ? (videoSizeMB + audioSizeMB) : videoSizeMB;
      }
    }

    const responseData = {
      videoId,
      title,
      author,
      durationSeconds,
      durationFormatted,
      thumbnail,
      sizes
    };

    // Store in Redis with 24h TTL
    await redisConnection.setex(cacheKey, 24 * 60 * 60, JSON.stringify(responseData));

    // Return metadata
    return new Response(JSON.stringify({
      success: true,
      ...responseData
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=3600'
      }
    });
  } catch (error: any) {
    console.error('Error fetching YouTube info:', error);
    let details = error?.message || String(error);
    if (details.includes('timed out') || details.includes('fetch failed')) {
      details += '. Tip: Deployed servers (like Render) are often blocked by YouTube. Please verify that YOUTUBE_COOKIE and PO_TOKEN are set correctly in your environment variables.';
    } else if (details.includes('Redis connection') || details.includes('redis')) {
      details += '. Tip: Please check your Redis configuration (REDIS_URL). Ensure your Redis service is running and accessible.';
    }
    return new Response(JSON.stringify({ 
      error: 'Failed to retrieve video metadata. YouTube might be blocking the request or the video could be private/restricted.',
      details: details
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
