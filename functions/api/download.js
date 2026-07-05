import { authorize } from '../_auth.js';

// Streams a video from R2 with Content-Disposition: attachment. Auth accepted
// via header or ?s= query param (needed for plain <a download> links).
export async function onRequestGet({ request, env }) {
  const auth = authorize(request, env);
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const key = url.searchParams.get('key');
  if (!key) return new Response('Missing key', { status: 400 });

  const obj = await env.VIDEOS.get(key);
  if (!obj) return new Response('Not found', { status: 404 });

  const displayName = key.replace(/^\d+_/, '') || key;
  const safeName = displayName.replace(/"/g, '');

  return new Response(obj.body, {
    headers: {
      'Content-Type': obj.httpMetadata?.contentType || 'video/mp4',
      'Content-Disposition': `attachment; filename="${safeName}"`,
      'Content-Length': String(obj.size),
    },
  });
}
