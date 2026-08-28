import { authorize } from '../_auth.js';

// /swill staging collection API. Separate viewer key from the admin secret:
// viewers present SWILL_KEY (Pages env var; falls back to a staging default
// so the page works before the var is set — replace before wider sharing).
// Assets live in R2 under swill/ (artdata.json + img/SERIAL.jpg), uploaded
// via the admin PUT below so no wrangler is needed.

const STAGING_KEY = 'swill-staging';
const FILE_RE = /^[A-Z]{1,4}\d{2,4}(_\d+)?\.jpg$/;

function viewerOk(request, env) {
  const url = new URL(request.url);
  const key = request.headers.get('x-swill-key') || url.searchParams.get('s');
  return key && key === (env.SWILL_KEY || STAGING_KEY);
}

export async function onRequest({ request, env }) {
  const url = new URL(request.url);

  // Admin upload: PUT /api/swill?put=<file> streams body to R2 swill/…
  if (request.method === 'PUT') {
    const auth = authorize(request, env);
    if (!auth.ok) return auth.response;
    const name = url.searchParams.get('put') || '';
    if (name !== 'artdata.json' && !FILE_RE.test(name)) {
      return new Response('Bad filename', { status: 400 });
    }
    const key = name === 'artdata.json' ? 'swill/artdata.json' : 'swill/img/' + name;
    await env.VIDEOS.put(key, request.body, {
      httpMetadata: {
        contentType: name.endsWith('.json') ? 'application/json' : 'image/jpeg',
      },
    });
    return Response.json({ ok: true, key });
  }

  if (request.method !== 'GET') {
    return new Response('Method not allowed', { status: 405 });
  }

  if (!viewerOk(request, env)) {
    return new Response('Unauthorized', { status: 401 });
  }

  if (url.searchParams.has('verify')) {
    return Response.json({ ok: true });
  }

  if (url.searchParams.has('data')) {
    const obj = await env.VIDEOS.get('swill/artdata.json');
    if (!obj) return new Response('Not found', { status: 404 });
    return new Response(obj.body, {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'private, max-age=300',
      },
    });
  }

  const img = url.searchParams.get('img') || '';
  if (FILE_RE.test(img)) {
    const obj = await env.VIDEOS.get('swill/img/' + img);
    if (!obj) return new Response('Not found', { status: 404 });
    return new Response(obj.body, {
      headers: {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'private, max-age=86400',
      },
    });
  }

  return new Response('Bad request', { status: 400 });
}
