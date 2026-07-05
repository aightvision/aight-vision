// Slug helpers shared across endpoints. Files starting with _ are not routed.
const SLUG_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const RESERVED = new Set(['api', 'assets', 'f', 'files', 'upload', 'admin', 'static']);

export function randomSlug(len = 8) {
  let s = '';
  const buf = new Uint8Array(len);
  crypto.getRandomValues(buf);
  for (let i = 0; i < len; i++) s += SLUG_ALPHABET[buf[i] % SLUG_ALPHABET.length];
  return s;
}

export function normalizeSlug(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export function isValidSlug(s) {
  if (!s || s.length < 3 || s.length > 64) return false;
  if (RESERVED.has(s)) return false;
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(s);
}

export async function generateUniqueSlug(env, len = 8) {
  for (let i = 0; i < 20; i++) {
    const s = randomSlug(len);
    const existing = await env.SLUGS.get('slug:' + s);
    if (!existing) return s;
  }
  // Extreme collision case — fall back to a longer slug
  return randomSlug(len + 4);
}

// Extract the file extension from an R2 key (e.g. "1234_video.mp4" -> "mp4"),
// lowercase, without the dot. Returns '' if none.
export function keyExtension(key) {
  const m = String(key || '').match(/\.([^.]+)$/);
  return m ? m[1].toLowerCase() : '';
}
