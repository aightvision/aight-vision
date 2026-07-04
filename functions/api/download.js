// Streams a video from R2 back to the browser with a Content-Disposition:
// attachment header so it downloads instead of playing. Auth is accepted
// via the `s` query param (so it works with a plain <a> tag) or the
// x-upload-secret header (so fetch-based callers work too).
export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const key = url.searchParams.get('key');
  const secret = url.searchParams.get('s') || request.headers.get('x-upload-secret');

  if (!env.UPLOAD_SECRET || secret !== env.UPLOAD_SECRET) {
    return new Response('Unauthorized', { status: 401 });
  }
  if (!key) return new Response('Missing key', { status: 400 });

  const obj = await env.VIDEOS.get(key);
  if (!obj) return new Response('Not found', { status: 404 });

  // Strip the leading timestamp (e.g. 1783153589362_foo.mp4 → foo.mp4)
  const displayName = key.replace(/^\d+_/, '') || key;
  // Escape any quotes in the filename for the header
  const safeName = displayName.replace(/"/g, '');

  return new Response(obj.body, {
    headers: {
      'Content-Type': obj.httpMetadata?.contentType || 'video/mp4',
      'Content-Disposition': `attachment; filename="${safeName}"`,
      'Content-Length': String(obj.size),
    },
  });
}
