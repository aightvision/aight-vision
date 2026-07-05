import { keyExtension } from '../_slug.js';

// Public slug resolver. No auth. Accepts:
//   /f/abc123
//   /f/abc123.mp4
// Extension is optional — if provided, it must match the source file's actual
// extension, otherwise we 404 (prevents URLs from misrepresenting content).
export async function onRequest({ request, env, params }) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405 });
  }

  const raw = String(params.slug || '');
  const dot = raw.lastIndexOf('.');
  const slug = dot > 0 ? raw.substring(0, dot) : raw;
  const requestedExt = dot > 0 ? raw.substring(dot + 1).toLowerCase() : '';

  if (!slug || !/^[a-z0-9-]+$/.test(slug)) return notFound();
  if (!env.SLUGS) return new Response('Slug store not configured', { status: 500 });

  const raw2 = await env.SLUGS.get('slug:' + slug);
  if (!raw2) return notFound();

  let mapping;
  try { mapping = JSON.parse(raw2); } catch { return notFound(); }
  const r2Key = mapping.r2Key;
  if (!r2Key) return notFound();

  const actualExt = keyExtension(r2Key);
  if (requestedExt && requestedExt !== actualExt) return notFound();

  // Head-only response for HEAD requests / CORS preflights
  if (request.method === 'HEAD') {
    const head = await env.VIDEOS.head(r2Key);
    if (!head) return notFound();
    return new Response(null, { status: 200, headers: buildHeaders(head, mapping, r2Key, null) });
  }

  // Optional range request handling for video scrubbing
  const rangeHeader = request.headers.get('Range');
  let rangeOpts;
  if (rangeHeader) {
    const m = rangeHeader.match(/bytes=(\d+)-(\d*)/);
    if (m) {
      const start = parseInt(m[1], 10);
      const end = m[2] ? parseInt(m[2], 10) : undefined;
      rangeOpts = end != null ? { offset: start, length: end - start + 1 } : { offset: start };
    }
  }

  const obj = await env.VIDEOS.get(r2Key, rangeOpts ? { range: rangeOpts } : undefined);
  if (!obj) return notFound();

  const totalSize = obj.size;
  const headers = buildHeaders(obj, mapping, r2Key, null);

  if (rangeOpts) {
    const start = rangeOpts.offset;
    const length = rangeOpts.length != null ? rangeOpts.length : (totalSize - start);
    const end = start + length - 1;
    headers['Content-Range'] = `bytes ${start}-${end}/${totalSize}`;
    headers['Content-Length'] = String(length);
    return new Response(obj.body, { status: 206, headers });
  }

  return new Response(obj.body, { status: 200, headers });
}

function buildHeaders(obj, mapping, r2Key, _range) {
  const displayName = r2Key.replace(/^\d+_/, '') || r2Key;
  const safeName = displayName.replace(/"/g, '');
  return {
    'Content-Type': mapping.contentType || obj.httpMetadata?.contentType || 'video/mp4',
    'Content-Disposition': `inline; filename="${safeName}"`,
    'Content-Length': String(obj.size),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=3600',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Range',
  };
}

function notFound() { return new Response('Not found', { status: 404 }); }
