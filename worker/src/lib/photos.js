/*
 * Photograph uploads.
 *
 * These go to an R2 bucket, never to the site's assets/homes folder, and the
 * reason is the deploy workflow. `.github/workflows/pages.yml` copies the whole
 * assets folder into the published site with `cp -R assets`, so an image written
 * there would be live on the internet the moment it was saved - before anyone
 * had approved the listing it belongs to. R2 is private, and the office copies a
 * photo across only when it approves the submission.
 *
 * What is accepted is decided by the bytes, not by the filename or the
 * Content-Type header, both of which the sender controls. A JPEG, a PNG and a
 * WebP each begin with a short fixed signature; anything that does not begin
 * with one of those is refused. That is what stops a .html or .svg carrying
 * script being stored and later served back as an image.
 */

/** Longest edge of a stored photo, and the byte ceiling for one upload. */
export const MAX_BYTES = 8 * 1024 * 1024;
export const MAX_PHOTOS = 8;

const SIGNATURES = [
  { ext: 'jpg', mime: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    ext: 'png',
    mime: 'image/png',
    test: (b) =>
      b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d &&
      b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a
  },
  {
    ext: 'webp',
    mime: 'image/webp',
    // "RIFF" .... "WEBP" - the four size bytes in between are not checked.
    test: (b) =>
      b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  }
];

/**
 * Identify a photo from its first bytes, or return null.
 *
 * Only the head is examined. The whole buffer is already in hand - it arrived
 * in the request - so checking more of it would cost time without adding
 * confidence: the point is to refuse things that are obviously not images, not
 * to prove a file is safe to decode.
 */
export function identify(bytes) {
  const head = new Uint8Array(bytes.slice(0, 12));
  if (head.length < 12) return null;
  return SIGNATURES.find((candidate) => candidate.test(head)) ?? null;
}

/**
 * Store one photo and return its key.
 *
 * The key is built from values this function controls - the submission id, a
 * fresh random id and the detected extension - and never from the filename the
 * sender supplied. A key is what ends up in a path the office later writes to
 * disk, so a key that carried `../../` or a `.php` from the request body would be
 * a way out of the image folder and onto something that can execute.
 */
export async function storePhoto(bucket, submissionId, file) {
  if (!bucket) {
    return { error: 'Photo storage is not configured. Ask the office to set up the R2 bucket.' };
  }
  if (!file || typeof file.arrayBuffer !== 'function') {
    return { error: 'That file could not be read.' };
  }

  const buffer = await file.arrayBuffer();
  if (!buffer.byteLength) return { error: 'That file is empty.' };
  if (buffer.byteLength > MAX_BYTES) {
    return { error: 'Each photo must be under 8 MB.' };
  }

  const kind = identify(buffer);
  if (!kind) {
    return { error: 'Photos must be a JPEG, PNG or WebP image.' };
  }

  const key = `submissions/${submissionId}/${crypto.randomUUID()}.${kind.ext}`;
  await bucket.put(key, buffer, {
    httpMetadata: { contentType: kind.mime }
  });

  return { key, mime: kind.mime, bytes: buffer.byteLength };
}

/** Read one photo back, for the agent's own preview and the office's review. */
export async function readPhoto(bucket, key) {
  const object = await bucket.get(key);
  if (!object) return null;
  return {
    body: object.body,
    mime: object.httpMetadata?.contentType ?? 'application/octet-stream'
  };
}

export async function deletePhoto(bucket, key) {
  if (bucket) await bucket.delete(key);
}
