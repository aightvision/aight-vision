export async function onRequestPost({ request, env }) {
  const secret = request.headers.get('x-upload-secret');
  if (!env.UPLOAD_SECRET || secret !== env.UPLOAD_SECRET) {
    return new Response('Unauthorized', { status: 401 });
  }

  const rawName = request.headers.get('x-file-name');
  if (!rawName) {
    return new Response('Missing x-file-name header', { status: 400 });
  }

  let filename;
  try {
    filename = decodeURIComponent(rawName);
  } catch {
    return new Response('Invalid x-file-name encoding', { status: 400 });
  }

  if (!request.body) {
    return new Response('No file body', { status: 400 });
  }

  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  const key = `${Date.now()}_${safeName}`;
  const contentType = request.headers.get('x-file-type') || 'video/mp4';

  // Stream the request body straight to R2 — no memory buffering
  await env.VIDEOS.put(key, request.body, {
    httpMetadata: { contentType },
  });

  return Response.json({ success: true, key }, { status: 201 });
}
