import { authorize } from '../_auth.js';
import { generateUniqueSlug } from '../_slug.js';

// Step 1 of multipart upload.
// Client sends filename + metadata as headers; server creates the R2
// multipart session and returns { uploadId, key, slug } for the client to
// use in subsequent /api/upload-part calls.
export async function onRequestPost({ request, env }) {
  const auth = authorize(request, env);
  if (!auth.ok) return auth.response;

  const rawName = request.headers.get('x-file-name');
  if (!rawName) return new Response('Missing x-file-name header', { status: 400 });

  let filename;
  try { filename = decodeURIComponent(rawName); }
  catch { return new Response('Invalid x-file-name encoding', { status: 400 }); }

  const contentType = request.headers.get('x-file-type') || 'video/mp4';
  const rawDur = request.headers.get('x-video-duration');
  const duration = rawDur && isFinite(parseFloat(rawDur))
    ? String(Math.round(parseFloat(rawDur) * 100) / 100)
    : '';

  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  const key = `${Date.now()}_${safeName}`;

  // Generate slug now so we can bake it into customMetadata on create.
  // We do NOT write the KV entry yet — that happens on successful complete().
  let slug = '';
  if (env.SLUGS) {
    try { slug = await generateUniqueSlug(env, 8); }
    catch (e) { console.error('slug generation failed:', e); slug = ''; }
  }

  const multipart = await env.VIDEOS.createMultipartUpload(key, {
    httpMetadata: { contentType },
    customMetadata: { tags: '', duration, slug, published: 'false' },
  });

  return Response.json({
    uploadId: multipart.uploadId,
    key,
    slug: slug || null,
  }, { status: 201 });
}
