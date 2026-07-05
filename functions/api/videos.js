import { authorize } from '../_auth.js';
import { normalizeSlug, isValidSlug } from '../_slug.js';

export async function onRequest({ request, env }) {
  const auth = authorize(request, env);
  if (!auth.ok) return auth.response;

  if (request.method === 'GET')    return listVideos(env);
  if (request.method === 'DELETE') return deleteVideo(request, env);
  if (request.method === 'PATCH')  return updateVideo(request, env);

  return new Response('Method not allowed', { status: 405 });
}

function parseTags(str) {
  if (!str) return [];
  return str.split(',').map(t => t.trim()).filter(Boolean);
}

function normalizeTag(raw) {
  return String(raw || '')
    .trim().toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

async function listVideos(env) {
  const items = [];
  let cursor;
  const base = (env.VIDEO_BASE_URL || '').replace(/\/$/, '');

  do {
    const result = await env.VIDEOS.list({
      cursor,
      limit: 1000,
      include: ['customMetadata', 'httpMetadata'],
    });
    for (const obj of result.objects) {
      const durRaw = obj.customMetadata?.duration;
      const duration = durRaw && isFinite(parseFloat(durRaw)) ? parseFloat(durRaw) : null;
      items.push({
        key: obj.key,
        url: `${base}/${encodeURIComponent(obj.key)}`,
        size: obj.size,
        uploaded: obj.uploaded,
        contentType: obj.httpMetadata?.contentType || 'video/mp4',
        tags: parseTags(obj.customMetadata?.tags),
        duration,
        slug: obj.customMetadata?.slug || null,
      });
    }
    cursor = result.truncated ? result.cursor : null;
  } while (cursor);

  items.sort((a, b) => new Date(b.uploaded) - new Date(a.uploaded));
  return Response.json({ items });
}

async function deleteVideo(request, env) {
  const url = new URL(request.url);
  const key = url.searchParams.get('key');
  if (!key) return new Response('Missing key parameter', { status: 400 });

  // Remove associated slug from KV first (if any) so the link dies immediately
  if (env.SLUGS) {
    try {
      const head = await env.VIDEOS.head(key);
      const slug = head?.customMetadata?.slug;
      if (slug) await env.SLUGS.delete('slug:' + slug);
    } catch (e) { console.error('slug cleanup on delete failed:', e); }
  }

  await env.VIDEOS.delete(key);
  return Response.json({ success: true });
}

// PATCH accepts: { key, newKey?, tags?, duration?, slug? }
async function updateVideo(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return new Response('Invalid JSON body', { status: 400 }); }

  const key = body.key;
  if (!key) return new Response('Missing key', { status: 400 });

  // Rename target
  let targetKey = key;
  if (typeof body.newKey === 'string' && body.newKey && body.newKey !== key) {
    const origExt = (key.match(/\.[^.]+$/) || [''])[0];
    const desired = body.newKey.replace(/[^a-zA-Z0-9._-]/g, '_');
    targetKey = /\.[^.]+$/.test(desired) ? desired : desired + origExt;
    if (targetKey !== key) {
      const collision = await env.VIDEOS.head(targetKey);
      if (collision) return new Response('A video with that name already exists', { status: 409 });
    }
  }

  const source = await env.VIDEOS.get(key);
  if (!source) return new Response('Not found', { status: 404 });

  const existingTags = parseTags(source.customMetadata?.tags);
  let tags = existingTags;
  if (Array.isArray(body.tags)) {
    tags = Array.from(new Set(body.tags.map(normalizeTag).filter(Boolean)));
  }

  let duration = source.customMetadata?.duration || '';
  if (body.duration != null && isFinite(parseFloat(body.duration))) {
    duration = String(Math.round(parseFloat(body.duration) * 100) / 100);
  }

  // Slug handling. body.slug is a *desired* new slug (user-supplied or ''=clear).
  const oldSlug = source.customMetadata?.slug || '';
  let slug = oldSlug;

  if (body.slug !== undefined) {
    const desiredSlug = normalizeSlug(body.slug);
    if (desiredSlug === '') {
      slug = ''; // user wants to remove the slug
    } else if (!isValidSlug(desiredSlug)) {
      return new Response('Invalid slug (must be 3-64 chars, alphanumeric + hyphens)', { status: 400 });
    } else if (desiredSlug !== oldSlug) {
      // check availability
      if (env.SLUGS) {
        const existing = await env.SLUGS.get('slug:' + desiredSlug);
        if (existing) {
          const data = JSON.parse(existing);
          if (data.r2Key !== key && data.r2Key !== targetKey) {
            return new Response('Slug already taken', { status: 409 });
          }
        }
      }
      slug = desiredSlug;
    }
  }

  const newCustomMetadata = {
    ...(source.customMetadata || {}),
    tags: tags.join(','),
    duration,
    slug,
  };

  await env.VIDEOS.put(targetKey, source.body, {
    httpMetadata: source.httpMetadata,
    customMetadata: newCustomMetadata,
  });

  if (targetKey !== key) await env.VIDEOS.delete(key);

  // Sync KV: remove old slug entry if slug changed / cleared / key changed;
  // add new one if slug is set.
  if (env.SLUGS) {
    try {
      if (oldSlug && (oldSlug !== slug || targetKey !== key)) {
        await env.SLUGS.delete('slug:' + oldSlug);
      }
      if (slug) {
        const contentType = source.httpMetadata?.contentType || 'video/mp4';
        await env.SLUGS.put('slug:' + slug, JSON.stringify({ r2Key: targetKey, contentType }));
      }
    } catch (e) { console.error('slug KV sync failed:', e); }
  }

  const base = (env.VIDEO_BASE_URL || '').replace(/\/$/, '');
  return Response.json({
    success: true,
    key: targetKey,
    url: `${base}/${encodeURIComponent(targetKey)}`,
    tags,
    duration: duration ? parseFloat(duration) : null,
    slug: slug || null,
  });
}
