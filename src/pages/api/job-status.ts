import { conversionQueue, mp3Dir, mp4Dir } from '../../lib/queue';
import * as fs from 'fs';
import * as path from 'path';

export const prerender = false;

export async function GET({ request }: { request: Request }) {
  const urlParams = new URL(request.url).searchParams;
  const jobId = urlParams.get('jobId');

  if (!jobId) {
    return new Response(JSON.stringify({ error: 'Missing jobId parameter' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    // Parse jobId (format: ${format}_${videoId}_${quality})
    const firstUnderscore = jobId.indexOf('_');
    const lastUnderscore = jobId.lastIndexOf('_');
    
    if (firstUnderscore === -1 || lastUnderscore === -1 || firstUnderscore === lastUnderscore) {
      return new Response(JSON.stringify({ error: 'Invalid jobId format' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const format = jobId.substring(0, firstUnderscore);
    const videoId = jobId.substring(firstUnderscore + 1, lastUnderscore);
    const quality = jobId.substring(lastUnderscore + 1);

    const cacheFilename = `${videoId}_${quality}.${format}`;
    const cacheDir = format === 'mp3' ? mp3Dir : mp4Dir;
    const cacheFilePath = path.join(cacheDir, cacheFilename);
    const relativeDownloadKey = `${format}/${cacheFilename}`;

    // 1. Check if the file is already cached on disk (e.g. if the job was cleaned up on completion)
    if (fs.existsSync(cacheFilePath)) {
      return new Response(JSON.stringify({
        status: 'completed',
        progress: 100,
        downloadUrl: `/api/download?key=${encodeURIComponent(relativeDownloadKey)}`
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 2. Look up the active/failed job in BullMQ
    const job = await conversionQueue.getJob(jobId);

    if (!job) {
      return new Response(JSON.stringify({
        status: 'failed',
        error: 'Job not found. It may have expired or failed. Please try converting again.'
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const state = await job.getState();

    if (state === 'completed') {
      return new Response(JSON.stringify({
        status: 'completed',
        progress: 100,
        downloadUrl: `/api/download?key=${encodeURIComponent(relativeDownloadKey)}`
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (state === 'failed') {
      return new Response(JSON.stringify({
        status: 'failed',
        error: job.failedReason || 'An unknown error occurred during conversion.'
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Active, waiting (queued), or delayed
    return new Response(JSON.stringify({
      status: 'processing',
      progress: job.progress || 0
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: any) {
    console.error('[API-JobStatus] Error:', error);
    return new Response(JSON.stringify({
      error: 'Failed to retrieve job status.',
      details: error?.message || String(error)
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
