export async function onRequestGet({ env }) {
  const items = [];
  let cursor;
  const base = (env.VIDEO_BASE_URL || '').replace(/\/$/, '');

  do {
    const result = await env.VIDEOS.list({
      cursor,
      limit: 1000,
      include: ['customMetadata'],
    });
    for (const obj of result.objects) {
      const tagStr = obj.customMetadata?.tags || '';
      const tags = tagStr ? tagStr.split(',').map(t => t.trim()).filter(Boolean) : [];
      items.push({
        url: `${base}/${encodeURIComponent(obj.key)}`,
        tags,
      });
    }
    cursor = result.truncated ? result.cursor : null;
  } while (cursor);

  return new Response(JSON.stringify(items), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=30',
    },
  });
}
