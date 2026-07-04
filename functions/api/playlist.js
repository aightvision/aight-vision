export async function onRequestGet({ env }) {
  const keys = [];
  let cursor;

  // paginate through all objects (R2 list returns max 1000 per call)
  do {
    const result = await env.VIDEOS.list({ cursor, limit: 1000 });
    for (const obj of result.objects) keys.push(obj.key);
    cursor = result.truncated ? result.cursor : null;
  } while (cursor);

  const base = (env.VIDEO_BASE_URL || '').replace(/\/$/, '');
  const urls = keys.map(k => `${base}/${encodeURIComponent(k)}`);

  return new Response(JSON.stringify(urls), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=30',
    },
  });
}
