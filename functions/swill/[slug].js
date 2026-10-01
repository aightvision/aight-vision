// /swill/back serves {back}; /swill/archive serves the viewer in archive mode
// (it reads location.pathname). No _redirects rule: rewriting /swill itself
// caused a 308 loop — see 2798c2b.
export async function onRequestGet({ request, env, params, next }) {
  const page = { back: '/swill-back', archive: '/swill' }[params.slug];
  if (!page) return next();
  const res = await env.ASSETS.fetch(new URL(page, request.url));
  return new Response(res.body, { status: res.status, headers: res.headers });
}
