import { serveSlug } from '../../_swill.js';

// Public slug links: /swill/f/<slug> or /swill/f/<slug>.<ext> stream the file
// inline (Range aware), no key — same model as aight.vision /f/.
export async function onRequestGet({ request, env, params }) {
  if (!env.SWILL) return new Response('Not found', { status: 404 });
  return serveSlug(request, env, String(params.slug || ''));
}
