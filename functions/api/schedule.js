// Cloud storage for /schedule — title-keyed saves in KV (SLUGS namespace,
// 'schedule:' prefix; deliberately NOT the R2 video bucket, where a stray JSON
// would surface in the stream's object listing).
//
// Auth: accepts SCHEDULE_SECRET (if configured) or UPLOAD_SECRET, so schedule
// access can later be granted separately from video-admin access without code
// changes. Same header/query convention as _auth.js.
//
//   GET    ?list=1        -> [{title, savedAt}]
//   GET    ?title=X       -> stored state JSON
//   PUT    ?title=X       -> save/overwrite (body = state JSON)
//   DELETE ?title=X       -> remove

function authorized(request, env) {
  const url = new URL(request.url);
  const secret = request.headers.get('x-upload-secret') || url.searchParams.get('s');
  if (!secret) return false;
  if (env.SCHEDULE_SECRET && secret === env.SCHEDULE_SECRET) return true;
  return !!env.UPLOAD_SECRET && secret === env.UPLOAD_SECRET;
}

const PREFIX = 'schedule:';

export async function onRequest({ request, env }) {
  if (!authorized(request, env)) return new Response('Unauthorized', { status: 401 });

  const url = new URL(request.url);
  const title = url.searchParams.get('title');
  const kv = env.SLUGS;

  if (request.method === 'GET') {
    if (url.searchParams.get('list')) {
      const out = [];
      let cursor;
      do {
        const res = await kv.list({ prefix: PREFIX, cursor });
        for (const k of res.keys) {
          out.push({ title: k.name.slice(PREFIX.length), savedAt: (k.metadata && k.metadata.savedAt) || null });
        }
        cursor = res.list_complete ? null : res.cursor;
      } while (cursor);
      out.sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || ''));
      return Response.json(out);
    }
    if (!title) return new Response('missing title', { status: 400 });
    const v = await kv.get(PREFIX + title);
    if (v === null) return new Response('not found', { status: 404 });
    return new Response(v, { headers: { 'Content-Type': 'application/json' } });
  }

  if (request.method === 'PUT' || request.method === 'POST') {
    if (!title) return new Response('missing title', { status: 400 });
    if (title.length > 30) return new Response('title too long', { status: 400 });
    const body = await request.text();
    if (body.length > 1000000) return new Response('too large', { status: 413 });
    try { JSON.parse(body); } catch (e) { return new Response('not json', { status: 400 }); }
    await kv.put(PREFIX + title, body, {
      metadata: { savedAt: new Date().toISOString().slice(0, 10) }
    });
    return Response.json({ ok: true });
  }

  if (request.method === 'DELETE') {
    if (!title) return new Response('missing title', { status: 400 });
    await kv.delete(PREFIX + title);
    return Response.json({ ok: true });
  }

  return new Response('method not allowed', { status: 405 });
}
