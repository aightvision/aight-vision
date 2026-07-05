import { authorize } from '../_auth.js';
import { generateUniqueSlug } from '../_slug.js';

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

  const rawDur = request.headers.get('x-video-duration');
  const duration = rawDur && isFinite(parseFloat(rawDur)) ? String(Math.round(parseFloat(rawDur) * 100) / 100) : '';

  // Generate a random slug for this upload (skip gracefully if KV isn't bound)
  let slug = '';
  if (env.SLUGS) {
    try { slug = await generateUniqueSlug(env, 8); }
    catch (e) { console.error('slug generation failed:', e); slug = ''; }
  }

  await env.VIDEOS.put(key, request.body, {
    httpMetadata: { contentType },
    customMetadata: { tags: '', duration, slug },
  });

  if (slug && env.SLUGS) {
    try {
      await env.SLUGS.put('slug:' + slug, JSON.stringify({ r2Key: key, contentType }));
    } catch (e) { console.error('slug KV write failed:', e); }
  }

  return Response.json({ success: true, key, slug: slug || null }, { status: 201 });
}
