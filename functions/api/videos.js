export async function onRequest({ request, env }) {
  const secret = request.headers.get('x-upload-secret');
  if (!env.UPLOAD_SECRET || secret !== env.UPLOAD_SECRET) {
    return new Response('Unauthorized', { status: 401 });
  }

  if (request.method === 'GET') {
    const items = [];
    let cursor;
    const base = (env.VIDEO_BASE_URL || '').replace(/\/$/, '');

    do {
      const result = await env.VIDEOS.list({ cursor, limit: 1000 });
      for (const obj of result.objects) {
        items.push({
          key: obj.key,
          url: `${base}/${encodeURIComponent(obj.key)}`,
          size: obj.size,
          uploaded: obj.uploaded,
        });
      }
      cursor = result.truncated ? result.cursor : null;
    } while (cursor);

    // Newest first
    items.sort((a, b) => new Date(b.uploaded) - new Date(a.uploaded));

    return Response.json({ items });
  }

  if (request.method === 'DELETE') {
    const url = new URL(request.url);
    const key = url.searchParams.get('key');
    if (!key) return new Response('Missing key parameter', { status: 400 });

    await env.VIDEOS.delete(key);
    return Response.json({ success: true });
  }

  return new Response('Method not allowed', { status: 405 });
}
