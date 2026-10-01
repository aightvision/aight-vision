// Playlist endpoint.
//
// Default behavior (no params): returns published videos only. This is what
// aight.vision main stream fetches.
//
// Tag-filtered behavior (?g=food+pizza,drinks&k=<TAG_LINK_KEY>): returns
// videos matching the tag groups REGARDLESS of publish state. Used by
// shared tag URLs. Key required — 401 if missing/wrong. Groups are
// comma-separated OR clauses; each group is plus-separated AND terms.
export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const groupsParam = url.searchParams.get('g') || '';
  const suppliedKey = url.searchParams.get('k') || '';

  // Are we in tag-filter mode?
  const tagMode = groupsParam.length > 0;

  if (tagMode) {
    if (!env.TAG_LINK_KEY || suppliedKey !== env.TAG_LINK_KEY) {
      return new Response('Invalid key', { status: 401 });
    }
  }

  const tagGroups = tagMode ? parseGroups(groupsParam) : null;

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
      if (obj.key.startsWith('swill/')) continue; // legacy swill staging set, not aight.vision media
      const published = obj.customMetadata?.published;
      const isDraft = published === 'false';

      // In default mode, hide drafts. In tag-filter mode, show everything.
      if (!tagMode && isDraft) continue;

      const tagStr = obj.customMetadata?.tags || '';
      const tags = tagStr ? tagStr.split(',').map(t => t.trim()).filter(Boolean) : [];

      // If tag-filter mode, video must match at least one group (AND within, OR across)
      if (tagMode) {
        let matched = false;
        for (const group of tagGroups) {
          let allIn = true;
          for (const t of group) {
            if (!tags.includes(t)) { allIn = false; break; }
          }
          if (allIn && group.length > 0) { matched = true; break; }
        }
        if (!matched) continue;
      }

      const durRaw = obj.customMetadata?.duration;
      const duration = durRaw && isFinite(parseFloat(durRaw)) ? parseFloat(durRaw) : null;

      items.push({
        url: `${base}/${encodeURIComponent(obj.key)}`,
        tags,
        duration,
        slug: obj.customMetadata?.slug || null,
      });
    }
    cursor = result.truncated ? result.cursor : null;
  } while (cursor);

  return new Response(JSON.stringify(items), {
    headers: {
      'Content-Type': 'application/json',
      // Tag-mode responses shouldn't be edge-cached since they're admin-gated
      'Cache-Control': tagMode ? 'no-store' : 'public, max-age=30',
    },
  });
}

// Parses "food+pizza,drinks" → [['food','pizza'], ['drinks']]
function parseGroups(s) {
  return decodeURIComponent(s).split(',')
    .map(g => g.split('+').map(t => t.trim().toLowerCase()).filter(Boolean))
    .filter(g => g.length > 0);
}
