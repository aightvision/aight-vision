import { authorize } from '../_auth.js';

// Step 2 of multipart upload.
// Client streams one chunk (≤ ~90 MB to stay under the 100 MB Cloudflare
// Worker body limit) with uploadId/key/partNumber in headers. Server
// forwards the body to R2 as a single part and returns { partNumber, etag }
// for the client to collect and pass to /api/upload-complete.
export async function onRequestPost({ request, env }) {
  const auth = authorize(request, env);
  if (!auth.ok) return auth.response;

  const uploadId = request.headers.get('x-upload-id');
  const key = request.headers.get('x-upload-key');
  const partNumberStr = request.headers.get('x-part-number');

  if (!uploadId || !key || !partNumberStr) {
    return new Response('Missing x-upload-id, x-upload-key, or x-part-number', { status: 400 });
  }
  const partNumber = parseInt(partNumberStr, 10);
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) {
    return new Response('Invalid x-part-number', { status: 400 });
  }
  if (!request.body) return new Response('No body', { status: 400 });

  let decodedKey;
  try { decodedKey = decodeURIComponent(key); }
  catch { return new Response('Invalid x-upload-key encoding', { status: 400 }); }

  const multipart = env.VIDEOS.resumeMultipartUpload(decodedKey, uploadId);
  const result = await multipart.uploadPart(partNumber, request.body);

  return Response.json({ partNumber: result.partNumber, etag: result.etag });
}
