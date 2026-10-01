// /swill — artist archive API (front viewers + {back} portal). Routed by
// functions/api/swill.js and functions/swill/f/[slug].js.
//
// Everything lives in the swill-only R2 bucket (binding SWILL):
//   catalog.json              single source of truth: works, order, category
//                             tree, param names. Written with etag-conditional
//                             puts so two tabs can't clobber each other.
//   files/<fid>/o_<name>      original upload, never modified
//   files/<fid>/web.jpg       display image (made in the browser)
//   files/<fid>/thumb.jpg     grid thumbnail
//   slugs/<slug>              → { k, type } for public slug links /swill/f/<slug>
//   archive/master.csv        every archived work, regenerated on change
//
// Work states: 'unpublished' | 'published' | 'archived'. /swill shows
// published, /swill/archive shows archived.
//
// Legacy: the August staging set (artdata.json + img/) sits in the shared
// VIDEOS bucket under swill/. import-legacy copies it here in batches and
// purge-legacy deletes it from VIDEOS once every serial is accounted for.
//
// Auth: viewers send SWILL_KEY (x-swill-key or ?s=). {back} sends SWILL_ADMIN
// (x-swill-admin or ?a=). Slug links are public, like aight.vision /f/.

const CAT = 'catalog.json';
const CSV_KEY = 'archive/master.csv';
const STATES = ['unpublished', 'published', 'archived'];
const KINDS = ['image', 'video', 'audio', 'doc'];

const FILE_KEY_RE = /^files\/[a-z0-9]{12}\/(web\.jpg|thumb\.jpg|o_[A-Za-z0-9._-]{1,180})$/;
const ID_RE = /^[a-z0-9]{12}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;

// ── auth ────────────────────────────────────────────────────────

function adminOk(request, env) {
  const url = new URL(request.url);
  const secret = request.headers.get('x-swill-admin') || url.searchParams.get('a');
  return !!env.SWILL_ADMIN && secret === env.SWILL_ADMIN;
}

function viewerOk(request, env) {
  if (adminOk(request, env)) return true;
  const url = new URL(request.url);
  const key = request.headers.get('x-swill-key') || url.searchParams.get('s');
  return !!env.SWILL_KEY && key === env.SWILL_KEY;
}

const unauthorized = () => new Response('Unauthorized', { status: 401 });
const bad = msg => new Response(msg, { status: 400 });
const json = v => (v instanceof Response ? v : Response.json(v));

// ── helpers ─────────────────────────────────────────────────────

const str = (v, max) => String(v ?? '').slice(0, max);

function randomString(len, chars) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, b => chars[b % chars.length]).join('');
}
const newId = () => randomString(12, 'abcdefghijklmnopqrstuvwxyz0123456789');
const newSlug = () => randomString(8, 'abcdefghjkmnpqrstuvwxyz23456789');

// ── catalog ─────────────────────────────────────────────────────

function emptyCatalog() {
  return { v: 2, works: {}, order: [], categories: [], params: [], updated: '' };
}

async function readCatalog(env) {
  const obj = await env.SWILL.get(CAT);
  if (!obj) return { cat: emptyCatalog(), etag: null };
  return { cat: await obj.json(), etag: obj.etag };
}

// Read-modify-write with optimistic concurrency. fn mutates cat in place and
// returns the value to send back (or a Response to abort). Side effects that
// must only happen once (R2 deletes, slug writes) go in fn's returned
// `after` callback, run after the catalog write lands.
async function mutate(env, fn) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const { cat, etag } = await readCatalog(env);
    const out = await fn(cat);
    if (out instanceof Response) return out;
    cat.updated = new Date().toISOString();
    const res = await env.SWILL.put(CAT, JSON.stringify(cat), {
      httpMetadata: { contentType: 'application/json' },
      ...(etag ? { onlyIf: { etagMatches: etag } } : {}),
    });
    if (res) {
      if (out && typeof out.after === 'function') {
        await out.after();
        delete out.after;
      }
      return out;
    }
  }
  return new Response('Catalog busy, try again', { status: 409 });
}

function allFileSlugs(cat, exceptFileId) {
  const s = new Set();
  Object.values(cat.works).forEach(w => w.files.forEach(f => {
    if (f.slug && f.id !== exceptFileId) s.add(f.slug);
  }));
  return s;
}

function cleanFile(f) {
  if (!f || typeof f !== 'object') return null;
  const okKey = k => !k || FILE_KEY_RE.test(k);
  if (!f.k || !okKey(f.k) || !okKey(f.web) || !okKey(f.thumb)) return null;
  return {
    id: ID_RE.test(f.id || '') ? f.id : f.k.split('/')[1],
    k: f.k,
    web: f.web || '',
    thumb: f.thumb || '',
    slug: str(f.slug, 48).toLowerCase(),
    name: str(f.name, 200),
    type: str(f.type, 100),
    kind: KINDS.includes(f.kind) ? f.kind : 'doc',
    bytes: Number(f.bytes) || 0,
    w: Number(f.w) || 0,
    h: Number(f.h) || 0,
    dur: Number(f.dur) || 0,
  };
}

// Whitelist every field the client may set. created is server-owned.
function cleanWork(input, prev, cat) {
  const catIds = new Set(cat.categories.map(c => c.id));
  return {
    id: input.id,
    state: STATES.includes(input.state) ? input.state : 'unpublished',
    title: str(input.title, 300),
    serial: str(input.serial, 60),
    mediaType: str(input.mediaType, 120),
    size: str(input.size, 200),
    materials: str(input.materials, 500),
    params: (Array.isArray(input.params) ? input.params : [])
      .slice(0, 60)
      .map(p => ({ name: str(p?.name, 80).trim(), value: str(p?.value, 2000) }))
      .filter(p => p.name),
    notes: str(input.notes, 50000),
    cats: [...new Set((Array.isArray(input.cats) ? input.cats : []).filter(id => catIds.has(id)))],
    files: (Array.isArray(input.files) ? input.files : []).map(cleanFile).filter(Boolean).slice(0, 200),
    created: prev?.created || input.created || new Date().toISOString(),
    updated: new Date().toISOString(),
  };
}

const fileKeys = f => [f.k, f.web, f.thumb].filter(k => k && FILE_KEY_RE.test(k));

// Assigns slugs to files that lack one, validates renamed ones, and returns
// { error } or { slugWrites, slugDeletes, keyDeletes } relative to prevFiles.
function reconcileFiles(cat, work, prevFiles) {
  const taken = new Set();
  Object.values(cat.works).forEach(w => {
    if (w.id === work.id) return;
    w.files.forEach(f => f.slug && taken.add(f.slug));
  });
  for (const f of work.files) {
    if (!f.slug) {
      do { f.slug = newSlug(); } while (taken.has(f.slug));
    } else if (!SLUG_RE.test(f.slug)) {
      return { error: new Response('Bad link name', { status: 400 }) };
    } else if (taken.has(f.slug)) {
      return { error: new Response('Link name taken', { status: 409 }) };
    }
    taken.add(f.slug);
  }
  const prevBySlug = new Map(prevFiles.map(f => [f.slug, f]));
  const nowSlugs = new Set(work.files.map(f => f.slug));
  const nowKeys = new Set(work.files.flatMap(fileKeys));
  return {
    slugWrites: work.files.filter(f => {
      const p = prevBySlug.get(f.slug);
      return !p || p.k !== f.k;
    }),
    slugDeletes: prevFiles.filter(f => f.slug && !nowSlugs.has(f.slug)).map(f => f.slug),
    keyDeletes: prevFiles.flatMap(fileKeys).filter(k => !nowKeys.has(k)),
  };
}

async function applyFileEffects(env, fx, keepKeys = new Set()) {
  await Promise.all(fx.slugWrites.map(f =>
    env.SWILL.put('slugs/' + f.slug, JSON.stringify({ k: f.k, type: f.type }), {
      httpMetadata: { contentType: 'application/json' },
    })));
  const del = [
    ...fx.slugDeletes.map(s => 'slugs/' + s),
    ...fx.keyDeletes.filter(k => !keepKeys.has(k)),
  ];
  if (del.length) await env.SWILL.delete(del);
}

// Public projection for one state: public fields only, plus the category
// subtree actually used (ancestors kept so the tree stays connected).
function feedOf(cat, state) {
  const works = cat.order
    .map(id => cat.works[id])
    .filter(w => w && w.state === state)
    .map(w => ({
      id: w.id, title: w.title, serial: w.serial,
      mediaType: w.mediaType, size: w.size, materials: w.materials,
      params: w.params.filter(p => p.value), notes: w.notes, cats: w.cats,
      files: w.files.map(f => ({ k: f.k, web: f.web, thumb: f.thumb, kind: f.kind, type: f.type, name: f.name })),
    }));
  const byId = new Map(cat.categories.map(c => [c.id, c]));
  const used = new Set();
  works.forEach(w => w.cats.forEach(id => {
    for (let c = byId.get(id); c && !used.has(c.id); c = byId.get(c.parent)) used.add(c.id);
  }));
  return { works, categories: cat.categories.filter(c => used.has(c.id)) };
}

// ── master CSV of archived works ────────────────────────────────

const CSV_COLS = [
  'id', 'serial', 'title', 'media_type', 'size', 'materials', 'categories',
  'parameters', 'notes', 'files', 'slug_links', 'created', 'updated',
];

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function categoryPath(cat, id) {
  const byId = new Map(cat.categories.map(c => [c.id, c]));
  const parts = [];
  for (let c = byId.get(id); c; c = byId.get(c.parent)) parts.unshift(c.name);
  return parts.join(' > ');
}

function buildCsv(cat, origin) {
  const rows = cat.order.map(id => cat.works[id]).filter(w => w && w.state === 'archived').map(w => ({
    id: w.id, serial: w.serial, title: w.title, media_type: w.mediaType,
    size: w.size, materials: w.materials,
    categories: w.cats.map(id => categoryPath(cat, id)).join('; '),
    parameters: w.params.map(p => `${p.name}: ${p.value}`).join('; '),
    notes: w.notes,
    files: w.files.map(f => f.k).join(' | '),
    slug_links: w.files.map(f => `${origin}/swill/f/${f.slug}`).join(' | '),
    created: w.created, updated: w.updated,
  }));
  return [CSV_COLS.join(','), ...rows.map(r => CSV_COLS.map(c => csvCell(r[c])).join(','))].join('\n') + '\n';
}

async function writeCsv(env, cat, origin) {
  await env.SWILL.put(CSV_KEY, buildCsv(cat, origin), { httpMetadata: { contentType: 'text/csv' } });
}

// ── file streaming (Range aware, for video/audio scrubbing) ─────

async function serveFile(request, env, key, opts = {}) {
  const rangeHeader = request.headers.get('Range');
  let range;
  const m = rangeHeader && rangeHeader.match(/bytes=(\d+)-(\d*)/);
  if (m) {
    const start = parseInt(m[1], 10);
    range = m[2] ? { offset: start, length: parseInt(m[2], 10) - start + 1 } : { offset: start };
  }
  const obj = await env.SWILL.get(key, range ? { range } : undefined);
  if (!obj) return new Response('Not found', { status: 404 });

  const name = key.split('/').pop().replace(/^o_/, '').replace(/"/g, '');
  const headers = {
    'Content-Type': obj.httpMetadata?.contentType || 'application/octet-stream',
    'Content-Disposition': `${opts.download ? 'attachment' : 'inline'}; filename="${name}"`,
    'Accept-Ranges': 'bytes',
    'Cache-Control': opts.public ? 'public, max-age=3600' : 'private, max-age=86400',
  };
  if (opts.public) {
    headers['Access-Control-Allow-Origin'] = '*';
    headers['Access-Control-Allow-Headers'] = 'Range';
  }
  if (range) {
    const length = range.length ?? obj.size - range.offset;
    headers['Content-Range'] = `bytes ${range.offset}-${range.offset + length - 1}/${obj.size}`;
    headers['Content-Length'] = String(length);
    return new Response(obj.body, { status: 206, headers });
  }
  headers['Content-Length'] = String(obj.size);
  return new Response(obj.body, { status: 200, headers });
}

export async function serveSlug(request, env, raw) {
  const dot = raw.lastIndexOf('.');
  const slug = (dot > 0 ? raw.slice(0, dot) : raw).toLowerCase();
  const ext = dot > 0 ? raw.slice(dot + 1).toLowerCase() : '';
  if (!SLUG_RE.test(slug)) return new Response('Not found', { status: 404 });
  const obj = await env.SWILL.get('slugs/' + slug);
  if (!obj) return new Response('Not found', { status: 404 });
  const { k } = await obj.json();
  const actualExt = (k.split('.').pop() || '').toLowerCase();
  if (ext && ext !== actualExt) return new Response('Not found', { status: 404 });
  return serveFile(request, env, k, { public: true });
}

// ── legacy import from the shared VIDEOS bucket ─────────────────

const LEGACY_PREFIX = 'swill/';
const IMPORT_BATCH = 8;

function legacyPlan(data) {
  const inOrder = new Set(data.order);
  const relatedOnly = new Set();
  data.order.forEach(s => (data.works[s]?.related || []).forEach(r => {
    if (!inOrder.has(r)) relatedOnly.add(r);
  }));
  const serials = [
    ...data.order,
    ...Object.keys(data.works).filter(s => !inOrder.has(s) && !relatedOnly.has(s)),
  ];
  return { serials, inOrder, relatedOnly };
}

// Deterministic file id per legacy image so a retried batch overwrites
// instead of orphaning copies.
const legacyFid = img => ('lg' + img.toLowerCase().replace(/\.jpg$/, '').replace(/[^a-z0-9]/g, '')).padEnd(12, '0').slice(0, 12);

async function importLegacyBatch(env, start, origin) {
  if (!env.VIDEOS) return new Response('VIDEOS binding missing', { status: 500 });
  const obj = await env.VIDEOS.get(LEGACY_PREFIX + 'artdata.json');
  if (!obj) return new Response('No legacy data', { status: 404 });
  const data = await obj.json();
  const { serials, inOrder, relatedOnly } = legacyPlan(data);
  const batch = serials.slice(start, start + IMPORT_BATCH);

  // Copy images first (idempotent), then register works in one catalog write.
  const prepared = [];
  for (const serial of batch) {
    const w = data.works[serial];
    if (!w) continue;
    const imgs = (w.images || []).map(f => [f, '']);
    (w.related || []).forEach(r => {
      if (relatedOnly.has(r)) (data.works[r]?.images || []).forEach(f => imgs.push([f, r]));
    });
    const files = [];
    for (const [img, label] of imgs) {
      const src = await env.VIDEOS.get(LEGACY_PREFIX + 'img/' + img);
      if (!src) continue;
      const fid = legacyFid(img);
      const k = `files/${fid}/o_${img}`;
      await env.SWILL.put(k, await src.arrayBuffer(), { httpMetadata: { contentType: 'image/jpeg' } });
      files.push({ id: fid, k, web: k, thumb: '', name: label || img, type: 'image/jpeg', kind: 'image' });
    }
    prepared.push({ serial, w, files });
  }

  return mutate(env, cat => {
    const have = new Set(Object.values(cat.works).map(x => x.serial).filter(Boolean));
    const addedIds = [];
    let fx = { slugWrites: [], slugDeletes: [], keyDeletes: [] };
    for (const { serial, w, files } of prepared) {
      if (have.has(serial)) continue;
      let catId = '';
      if (w.category) {
        let c = cat.categories.find(x => !x.parent && x.name.toLowerCase() === w.category.toLowerCase());
        if (!c) { c = { id: newId(), name: w.category, parent: '' }; cat.categories.push(c); }
        catId = c.id;
      }
      const params = [
        ['Description', w.description], ['Date', w.approx_date], ['Condition', w.condition],
        ['Canvas', w.stretched_or_unstretched], ['Exhibited', w.past_exhibition],
      ];
      if (w.caption && w.theme_title && w.caption !== w.theme_title) params.unshift(['Caption', w.caption]);
      const id = newId();
      const work = cleanWork({
        id, serial,
        state: inOrder.has(serial) ? 'published' : 'unpublished',
        title: w.theme_title || w.caption || '',
        mediaType: w.category || '',
        size: w.dimensions || '',
        materials: w.material || '',
        params: params.filter(([, v]) => v).map(([name, value]) => ({ name, value: String(value) })),
        notes: w.notes || '',
        cats: catId ? [catId] : [],
        files,
      }, null, cat);
      // Legacy slugs read like the serial: stm110, stm110-2 …
      const taken = allFileSlugs(cat, null);
      work.files.forEach((f, i) => {
        let s = serial.toLowerCase() + (i ? '-' + (i + 1) : '');
        while (taken.has(s)) s += '-x';
        f.slug = s;
        taken.add(s);
      });
      const r = reconcileFiles(cat, work, []);
      if (r.error) return r.error;
      fx.slugWrites.push(...r.slugWrites);
      cat.works[id] = work;
      addedIds.push(id);
    }
    ['Caption', 'Description', 'Date', 'Condition', 'Canvas', 'Exhibited']
      .forEach(n => { if (!cat.params.includes(n)) cat.params.push(n); });
    // Keep the staging feed's order: legacy works sit after anything newer.
    cat.order = [...cat.order, ...addedIds];
    const next = start + IMPORT_BATCH;
    return {
      imported: addedIds.length,
      next: next < serials.length ? next : null,
      total: serials.length,
      after: () => applyFileEffects(env, fx),
    };
  });
}

// Deletes swill/ from the shared VIDEOS bucket, but only once every legacy
// serial is present in the swill catalog.
async function purgeLegacy(env) {
  if (!env.VIDEOS) return new Response('VIDEOS binding missing', { status: 500 });
  const obj = await env.VIDEOS.get(LEGACY_PREFIX + 'artdata.json');
  if (obj) {
    const data = await obj.json();
    const { serials } = legacyPlan(data);
    const { cat } = await readCatalog(env);
    const have = new Set(Object.values(cat.works).map(w => w.serial));
    const missing = serials.filter(s => !have.has(s));
    if (missing.length) return new Response('Not purged — missing ' + missing.join(', '), { status: 409 });
  }
  let deleted = 0;
  let cursor;
  do {
    const res = await env.VIDEOS.list({ prefix: LEGACY_PREFIX, cursor, limit: 1000 });
    const keys = res.objects.map(o => o.key);
    if (keys.length) { await env.VIDEOS.delete(keys); deleted += keys.length; }
    cursor = res.truncated ? res.cursor : null;
  } while (cursor);
  return { deleted };
}

// ── router ──────────────────────────────────────────────────────

export async function onRequest({ request, env }) {
  if (!env.SWILL) return new Response('SWILL bucket binding missing', { status: 500 });
  const url = new URL(request.url);
  const op = url.searchParams.get('op') || '';
  const method = request.method;

  if (method === 'GET') {
    if (op === 'verify') return viewerOk(request, env) ? json({ ok: true }) : unauthorized();
    if (op === 'admin-verify') return adminOk(request, env) ? json({ ok: true }) : unauthorized();

    if (op === 'feed') {
      if (!viewerOk(request, env)) return unauthorized();
      const state = url.searchParams.get('set') === 'archive' ? 'archived' : 'published';
      const { cat } = await readCatalog(env);
      return Response.json(feedOf(cat, state), { headers: { 'Cache-Control': 'private, no-cache' } });
    }

    if (op === 'file') {
      if (!viewerOk(request, env)) return unauthorized();
      const k = url.searchParams.get('k') || '';
      if (!FILE_KEY_RE.test(k)) return bad('Bad key');
      return serveFile(request, env, k, { download: url.searchParams.has('dl') });
    }

    if (!adminOk(request, env)) return unauthorized();

    if (op === 'catalog') {
      const { cat } = await readCatalog(env);
      const legacy = env.VIDEOS ? !!(await env.VIDEOS.head(LEGACY_PREFIX + 'artdata.json')) : false;
      return Response.json({ ...cat, legacyAvailable: legacy }, { headers: { 'Cache-Control': 'no-store' } });
    }
    if (op === 'csv') {
      const { cat } = await readCatalog(env);
      return new Response(buildCsv(cat, url.origin), {
        headers: { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="swill-master.csv"' },
      });
    }
    return bad('Unknown op');
  }

  if (!adminOk(request, env)) return unauthorized();

  // ── uploads: single-shot PUT (< 80 MB) or R2 multipart ──
  if (op === 'put' || op.startsWith('mpu-')) {
    const k = url.searchParams.get('k') || '';
    if (!FILE_KEY_RE.test(k)) return bad('Bad key');
    const contentType = request.headers.get('x-file-type') || 'application/octet-stream';

    if (op === 'put' && method === 'PUT') {
      if (!request.body) return bad('No body');
      await env.SWILL.put(k, request.body, { httpMetadata: { contentType } });
      return json({ ok: true, k });
    }
    if (op === 'mpu-init' && method === 'POST') {
      const mpu = await env.SWILL.createMultipartUpload(k, { httpMetadata: { contentType } });
      return json({ uploadId: mpu.uploadId });
    }
    const uploadId = url.searchParams.get('u') || '';
    if (!uploadId) return bad('Missing upload id');
    if (op === 'mpu-part' && method === 'PUT') {
      const n = parseInt(url.searchParams.get('n') || '', 10);
      if (!Number.isInteger(n) || n < 1 || n > 10000) return bad('Bad part number');
      const part = await env.SWILL.resumeMultipartUpload(k, uploadId).uploadPart(n, request.body);
      return json({ partNumber: part.partNumber, etag: part.etag });
    }
    if (op === 'mpu-done' && method === 'POST') {
      const { parts } = await request.json();
      if (!Array.isArray(parts) || !parts.length) return bad('Missing parts');
      parts.sort((a, b) => a.partNumber - b.partNumber);
      await env.SWILL.resumeMultipartUpload(k, uploadId).complete(parts);
      return json({ ok: true, k });
    }
    return bad('Bad upload op');
  }

  if (method !== 'POST') return new Response('Method not allowed', { status: 405 });
  let body = {};
  try { body = await request.json(); } catch { /* ops without a body */ }

  // Upsert a whole work record.
  if (op === 'work') {
    const input = body.work || {};
    if (!ID_RE.test(input.id || '')) return bad('Bad id');
    return json(await mutate(env, cat => {
      const prev = cat.works[input.id];
      const work = cleanWork(input, prev, cat);
      const fx = reconcileFiles(cat, work, prev ? prev.files : []);
      if (fx.error) return fx.error;
      const archivedChanged = (prev?.state === 'archived') !== (work.state === 'archived') || work.state === 'archived';
      cat.works[work.id] = work;
      if (!prev) cat.order.unshift(work.id);
      return {
        work,
        after: async () => {
          await applyFileEffects(env, fx);
          if (archivedChanged) await writeCsv(env, cat, url.origin);
        },
      };
    }).then(out => (out instanceof Response ? out : out.work)));
  }

  // Move every file from the `from` works into `into`; the emptied works are
  // removed (nothing is duplicated). Files keep their slugs.
  if (op === 'merge') {
    const from = Array.isArray(body.from) ? body.from.filter(id => ID_RE.test(id) && id !== body.into) : [];
    if (!ID_RE.test(body.into || '') || !from.length) return bad('Bad merge');
    return json(await mutate(env, cat => {
      const target = cat.works[body.into];
      if (!target) return new Response('Not found', { status: 404 });
      from.forEach(id => {
        const w = cat.works[id];
        if (!w) return;
        target.files.push(...w.files);
        delete cat.works[id];
      });
      cat.order = cat.order.filter(id => cat.works[id]);
      target.updated = new Date().toISOString();
      return { work: target, removed: from };
    }).then(out => (out instanceof Response ? out : { work: out.work, removed: out.removed })));
  }

  if (op === 'delete') {
    return json(await mutate(env, cat => {
      const w = cat.works[body.id];
      if (!w) return new Response('Not found', { status: 404 });
      delete cat.works[body.id];
      cat.order = cat.order.filter(x => x !== body.id);
      const fx = { slugWrites: [], slugDeletes: w.files.map(f => f.slug).filter(Boolean), keyDeletes: w.files.flatMap(fileKeys) };
      return {
        ok: true,
        after: async () => {
          await applyFileEffects(env, fx);
          if (w.state === 'archived') await writeCsv(env, cat, url.origin);
        },
      };
    }));
  }

  // Category tree + param names. Categories are a flat list of
  // { id, name, parent } (parent '' = top level), any depth.
  if (op === 'meta') {
    return json(await mutate(env, cat => {
      if (Array.isArray(body.categories)) {
        const list = body.categories.slice(0, 1000).map(c => ({
          id: ID_RE.test(c?.id || '') ? c.id : newId(),
          name: str(c?.name, 80).trim(),
          parent: str(c?.parent, 12),
        })).filter(c => c.name);
        const ids = new Set(list.map(c => c.id));
        list.forEach(c => { if (!ids.has(c.parent) || c.parent === c.id) c.parent = ''; });
        cat.categories = list;
        Object.values(cat.works).forEach(w => { w.cats = w.cats.filter(id => ids.has(id)); });
      }
      if (Array.isArray(body.params)) {
        cat.params = [...new Set(body.params.map(p => str(p, 80).trim()).filter(Boolean))].slice(0, 300);
      }
      return { categories: cat.categories, params: cat.params };
    }));
  }

  if (op === 'import-legacy') {
    const start = Math.max(0, parseInt(url.searchParams.get('start') || '0', 10) || 0);
    return json(await importLegacyBatch(env, start, url.origin));
  }
  if (op === 'purge-legacy') return json(await purgeLegacy(env));

  return bad('Unknown op');
}

// Exposed for tests.
export const _internal = { cleanWork, reconcileFiles, feedOf, buildCsv, legacyPlan, legacyFid, emptyCatalog };
