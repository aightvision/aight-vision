// Centralized auth for all API endpoints. Files starting with _ are not
// exposed as routes by Cloudflare Pages Functions.
//
// Returns { ok: true, role } on success, or { ok: false, response } on failure.
// The `role` field is set to 'admin' for now — the single UPLOAD_SECRET grants
// full access. When we add tiered permissions later, this function grows to
// check ADMIN_SECRET / UPLOADER_SECRET / VIEWER_SECRET and returns the matching
// role. No other endpoint needs to change beyond adding role checks where
// appropriate.
export function authorize(request, env) {
  const url = new URL(request.url);
  const secret = request.headers.get('x-upload-secret') || url.searchParams.get('s');
  if (!env.UPLOAD_SECRET || secret !== env.UPLOAD_SECRET) {
    return { ok: false, response: new Response('Unauthorized', { status: 401 }) };
  }
  return { ok: true, role: 'admin' };
}
