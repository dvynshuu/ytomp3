import { getInnertube } from '../../lib/innertube-cache';

export const prerender = false;

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
    const yt = await getInnertube();
    const info = await yt.getBasicInfo(videoId);

    if (info.playability_status && info.playability_status.status !== 'OK') {
      return new Response(JSON.stringify({ 
        error: info.playability_status.reason || 'This YouTube video is restricted or unplayable.'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const title = info.basic_info.title || 'YouTube Video';
    const author = info.basic_info.author || 'Unknown Creator';
    const durationSeconds = info.basic_info.duration || 0;
    const durationFormatted = formatDuration(durationSeconds);
    
    // Extract high res thumbnail if possible
    const thumbnails = info.basic_info.thumbnail || [];
    const thumbnail = thumbnails.length > 0 ? thumbnails[thumbnails.length - 1].url : `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;

    // Return metadata
    return new Response(JSON.stringify({
      success: true,
      videoId,
      title,
      author,
      durationSeconds,
      durationFormatted,
      thumbnail
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=3600'
      }
    });
  } catch (error: any) {
    console.error('Error fetching YouTube info:', error);
    return new Response(JSON.stringify({ 
      error: 'Failed to retrieve video metadata. YouTube might be blocking the request or the video could be private/restricted.',
      details: error?.message || String(error)
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
