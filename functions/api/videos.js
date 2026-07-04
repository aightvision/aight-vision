export async function onRequest({ request, env }) {
  const secret = request.headers.get('x-upload-secret');
  if (!env.UPLOAD_SECRET || secret !== env.UPLOAD_SECRET) {
    return new Response('Unauthorized', { status: 401 });
  }

  if (request.method === 'GET') return listVideos(env);
  if (request.method === 'DELETE') return deleteVideo(request, env);
  if (request.method === 'PATCH') return updateVideo(request, env);

  return new Response('Method not allowed', { status: 405 });
}

function parseTags(str) {
  if (!str) return [];
  return str.split(',').map(t => t.trim()).filter(Boolean);
}

function normalizeTag(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase()
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
      items.push({
        key: obj.key,
        url: `${base}/${encodeURIComponent(obj.key)}`,
        size: obj.size,
        uploaded: obj.uploaded,
        contentType: obj.httpMetadata?.contentType || 'video/mp4',
        tags: parseTags(obj.customMetadata?.tags),
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

  await env.VIDEOS.delete(key);
  return Response.json({ success: true });
}

// PATCH accepts: { key, newKey?, tags? }
// - If newKey is provided, the object is copied to that key and the old one deleted.
// - If tags is provided, the object is re-put in place with the new tags.
// (Both operations rewrite the object because R2 has no metadata-only update.)
async function updateVideo(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response('Invalid JSON body', { status: 400 });
  }

  const key = body.key;
  if (!key) return new Response('Missing key', { status: 400 });

  // Figure out target key first — do the collision check up front, before
  // we open the source read stream.
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

  // Compute the resulting metadata
  const existingTags = parseTags(source.customMetadata?.tags);
  let tags = existingTags;
  if (Array.isArray(body.tags)) {
    tags = Array.from(new Set(body.tags.map(normalizeTag).filter(Boolean)));
  }
  const newCustomMetadata = { ...(source.customMetadata || {}), tags: tags.join(',') };

  await env.VIDEOS.put(targetKey, source.body, {
    httpMetadata: source.httpMetadata,
    customMetadata: newCustomMetadata,
  });

  if (targetKey !== key) {
    await env.VIDEOS.delete(key);
  }

  const base = (env.VIDEO_BASE_URL || '').replace(/\/$/, '');
  return Response.json({
    success: true,
    key: targetKey,
    url: `${base}/${encodeURIComponent(targetKey)}`,
    tags,
  });
}
