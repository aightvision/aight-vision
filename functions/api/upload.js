import { authorize } from '../_auth.js';

export async function onRequestPost({ request, env }) {
  const auth = authorize(request, env);
  if (!auth.ok) return auth.response;

  const rawName = request.headers.get('x-file-name');
  if (!rawName) return new Response('Missing x-file-name header', { status: 400 });

  let filename;
  try { filename = decodeURIComponent(rawName); }
  catch { return new Response('Invalid x-file-name encoding', { status: 400 }); }

  if (!request.body) return new Response('No file body', { status: 400 });

  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  const key = `${Date.now()}_${safeName}`;
  const contentType = request.headers.get('x-file-type') || 'video/mp4';

  // Optional client-supplied duration (seconds)
  const rawDur = request.headers.get('x-video-duration');
  const duration = rawDur && isFinite(parseFloat(rawDur)) ? String(Math.round(parseFloat(rawDur) * 100) / 100) : '';

  await env.VIDEOS.put(key, request.body, {
    httpMetadata: { contentType },
    customMetadata: { tags: '', duration },
  });

  return Response.json({ success: true, key }, { status: 201 });
}
