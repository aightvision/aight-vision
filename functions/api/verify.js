import { authorize } from '../_auth.js';

// Lightweight endpoint used by the client to verify an access code without
// performing any action. Returns 200 { ok, role } on success, 401 otherwise.
// Reuses the same _auth helper as every other endpoint so if this passes,
// downstream write calls will also pass.
export async function onRequest({ request, env }) {
  const auth = authorize(request, env);
  if (!auth.ok) return auth.response;
  return Response.json({ ok: true, role: auth.role });
}
