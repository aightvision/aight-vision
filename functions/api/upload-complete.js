import { authorize } from '../_auth.js';

// Step 3 (final) of multipart upload.
// Client sends the list of uploaded parts (from /api/upload-part responses)
// as JSON. Server finalizes the R2 multipart upload and, only on success,
// writes the slug KV entry so failed uploads don't leave dead slugs.
export async function onRequestPost({ request, env }) {
  const auth = authorize(request, env);
  if (!auth.ok) return auth.response;

  const uploadId = request.headers.get('x-upload-id');
  const key = request.headers.get('x-upload-key');
  if (!uploadId || !key) {
    return new Response('Missing x-upload-id or x-upload-key', { status: 400 });
  }
  let decodedKey;
  try { decodedKey = decodeURIComponent(key); }
  catch { return new Response('Invalid x-upload-key encoding', { status: 400 }); }

  let body;
  try { body = await request.json(); }
  catch { return new Response('Invalid JSON body', { status: 400 }); }

  const parts = Array.isArray(body?.parts) ? body.parts : null;
  if (!parts || !parts.length) return new Response('Missing parts', { status: 400 });

  // Validate part shape
  for (const p of parts) {
    if (!Number.isInteger(p.partNumber) || !p.etag) {
      return new Response('Invalid part in list', { status: 400 });
    }
  }
  // Sort by partNumber just to be safe; R2 expects them in order.
  parts.sort((a, b) => a.partNumber - b.partNumber);

  const multipart = env.VIDEOS.resumeMultipartUpload(decodedKey, uploadId);

  let obj;
  try {
    obj = await multipart.complete(parts);
  } catch (e) {
    return new Response('R2 complete failed: ' + (e.message || String(e)), { status: 500 });
  }

  // Write slug KV entry now that we know the upload succeeded.
  // The slug was baked into customMetadata during init; read it back off the
  // completed object for the KV mapping.
  const slug = obj?.customMetadata?.slug || '';
  const contentType = obj?.httpMetadata?.contentType || 'video/mp4';
  if (slug && env.SLUGS) {
    try {
      await env.SLUGS.put('slug:' + slug, JSON.stringify({ r2Key: decodedKey, contentType }));
    } catch (e) { console.error('slug KV write failed:', e); }
  }

  return Response.json({
    success: true,
    key: decodedKey,
    slug: slug || null,
    published: false,
  }, { status: 201 });
}
