// lib/fileStorage.js
// Where uploaded files actually live.
//
// Every upload -- scanned receipt photos, merchant logos, profile photos --
// used to be written straight to public/uploads on the local filesystem. That
// works exactly until the first redeploy, because a container's disk does not
// survive one. On Railway that means every scanned receipt photo a customer
// has saved is destroyed by an ordinary deployment, silently, with the
// database still confidently pointing at files that no longer exist.
//
// It matters more here than in most apps: a receipt photo is not decoration.
// It is the record CRA and the IRS actually accept, and the thing the whole
// retention window exists to preserve (see config/retention.js). Losing it
// loses the evidence, not the thumbnail.
//
// So uploads go to Supabase Storage when it is configured, and fall back to
// local disk when it is not, so development keeps working with no setup. The
// fallback is deliberately loud in production -- see assertProductionStorage().
//
// Two destinations, not one, because "public" and "private" are properties of
// a Supabase bucket, not of an individual object -- there is no per-file flag
// to flip. putPublic()/removePublic() are the original behavior: logos and
// profile photos, meant to be reachable by a direct URL (some of them, like a
// receipt's merchant logo, on pages nobody is logged in to view). They keep
// writing to BUCKET ("uploads", public). putPrivate()/getPrivate()/
// removePrivate() are for scanned receipt photos, which must never be
// reachable except through an authenticated proxy route -- they write to
// PRIVATE_BUCKET, a separate bucket with its public flag off, and hand back a
// bare storage key instead of a URL, since a URL into a private bucket
// wouldn't resolve to anything anyway.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
// Deliberately outside public/, which server.js serves in full via
// express.static -- a private-bucket local fallback that landed under
// public/ would be publicly reachable by URL even in local dev, defeating
// the entire point and making the auth-gating impossible to test locally.
const PRIVATE_DIR = path.join(__dirname, '..', 'private-uploads');
const BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'uploads';
// No fallback default, unlike BUCKET above -- guessing a private bucket name
// that doesn't exist would just turn every upload into a runtime error, so a
// missing value should fail loudly (see putPrivate()) rather than silently
// point at the wrong bucket.
const PRIVATE_BUCKET = process.env.SUPABASE_PRIVATE_BUCKET;

let client = null;
function supabase() {
  if (client) return client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  const { createClient } = require('@supabase/supabase-js');
  // The service key, not the anon key: these writes happen server-side on
  // behalf of a user who must never be able to reach the bucket directly.
  client = createClient(url, key, { auth: { persistSession: false } });
  return client;
}

/** True when uploads will survive a redeploy. */
function isRemote() {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY);
}

/**
 * Shouted at boot rather than discovered after the first deploy wipes a
 * customer's receipts. Not fatal -- refusing to start would take a working
 * site down over a misconfiguration -- but impossible to miss in a log.
 */
function assertProductionStorage(logger = console) {
  if (process.env.NODE_ENV !== 'production') return true;

  let ok = true;
  if (!isRemote()) {
    logger.error(
      '[fileStorage] WARNING: uploads are being written to local disk in production. ' +
      'This container\'s filesystem does not survive a redeploy, so every scanned ' +
      'receipt photo, logo and profile photo will be destroyed by the next deploy ' +
      'while the database still references them. Set SUPABASE_URL and ' +
      'SUPABASE_SERVICE_KEY to store them durably.'
    );
    ok = false;
  } else if (!PRIVATE_BUCKET) {
    logger.error(
      '[fileStorage] WARNING: SUPABASE_PRIVATE_BUCKET is not set in production. ' +
      'Scanned receipt photos will fail to upload -- putPrivate() refuses to fall ' +
      'back to local disk when remote storage is otherwise configured, since that ' +
      'would silently recreate the exact "photo destroyed by the next deploy" ' +
      'problem this file exists to prevent. Set SUPABASE_PRIVATE_BUCKET to the ' +
      'private bucket\'s name.'
    );
    ok = false;
  }
  return ok;
}

/** A collision-proof name that keeps the original extension. */
function buildKey(folder, originalName, prefix = '') {
  const ext = (path.extname(originalName || '') || '').toLowerCase();
  const stamp = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
  return `${folder}/${prefix ? prefix + '-' : ''}${stamp}${ext}`;
}

/**
 * True only if `key` is exactly what buildKey('receipt-scans', ..., customerId)
 * could have produced for this customer. For validating a key that arrives
 * from outside the process -- a hidden form field, a query string -- before
 * it's ever handed to fs or Supabase. randomBytes(6).toString('hex') is
 * always exactly 12 lowercase hex characters; the extension is optional
 * because buildKey omits it when the uploaded file had none. Anchored at
 * both ends, so nothing -- including a "../" segment -- can smuggle itself in
 * around the parts that are supposed to be fixed.
 */
// Content-Type for anything streamed via getPrivate() -- a private-bucket
// download doesn't hand back a mimetype the way a public URL fetch would, so
// the extension on the key is all there is to go on. Shared by every route
// that streams a receipt-scan photo (the customer's own proxy/preview
// routes and the public share-link routes) so the mapping can't drift
// between them.
const SCAN_EXT_MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

function isValidScanKey(key, customerId) {
  if (typeof key !== 'string' || typeof customerId !== 'string' || !customerId) return false;
  const escapedId = customerId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^receipt-scans/${escapedId}-\\d+-[0-9a-f]{12}(\\.[a-z0-9]{1,5})?$`);
  return pattern.test(key);
}

/**
 * Store a buffer and return the public URL to reference it by. For logos and
 * profile photos -- assets meant to be reachable directly, some (a merchant's
 * receipt-page logo) on pages nobody is logged in to view. Both backends
 * return a `/uploads/...`-shaped or full-URL path so nothing downstream --
 * templates, the receipt renderer, the retention purge -- has to know or care
 * which one is in use.
 */
async function putPublic(folder, file, { prefix = '' } = {}) {
  const key = buildKey(folder, file.originalname, prefix);
  const sb = supabase();

  if (!sb) {
    const dest = path.join(PUBLIC_DIR, 'uploads', key);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, file.buffer);
    return `/uploads/${key}`;
  }

  const { error } = await sb.storage.from(BUCKET).upload(key, file.buffer, {
    contentType: file.mimetype,
    upsert: false,
    // Five minutes, not the one-hour default. Deleting an object removes it
    // from storage immediately, but the CDN keeps serving whatever it already
    // cached -- so the default left a deleted photo publicly readable at its
    // exact URL for an hour after someone asked for it to be gone. These
    // images are opened rarely, so a shorter cache costs almost nothing and
    // shrinks that window twelve-fold.
    cacheControl: '300',
  });
  if (error) throw new Error(`upload failed: ${error.message}`);

  const { data } = sb.storage.from(BUCKET).getPublicUrl(key);
  return data.publicUrl;
}

/**
 * Store a buffer in the private bucket and return the bare storage key --
 * never a URL, since a private bucket's objects have no public URL that
 * resolves. For scanned receipt photos only. Refuses to fall back to local
 * disk when remote storage is otherwise configured but PRIVATE_BUCKET isn't
 * set, rather than guessing a bucket name -- see assertProductionStorage().
 */
async function putPrivate(folder, file, { prefix = '' } = {}) {
  const key = buildKey(folder, file.originalname, prefix);
  const sb = supabase();

  if (!sb) {
    const dest = path.join(PRIVATE_DIR, key);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, file.buffer);
    return key;
  }

  if (!PRIVATE_BUCKET) throw new Error('SUPABASE_PRIVATE_BUCKET is not set');

  const { error } = await sb.storage.from(PRIVATE_BUCKET).upload(key, file.buffer, {
    contentType: file.mimetype,
    upsert: false,
    cacheControl: '300',
  });
  if (error) throw new Error(`private upload failed: ${error.message}`);
  return key;
}

/**
 * Stream a private object back by its bare key. Callers are expected to
 * validate `key` with isValidScanKey() before it reaches here -- this adds
 * one more check on the local-disk path regardless, since refusing a
 * resolved path outside PRIVATE_DIR is nearly free and a key is not always
 * guaranteed to have been checked upstream.
 */
async function getPrivate(key) {
  const sb = supabase();

  if (!sb) {
    const dest = path.join(PRIVATE_DIR, key);
    if (path.relative(PRIVATE_DIR, dest).startsWith('..')) {
      throw new Error('invalid key');
    }
    return fs.createReadStream(dest);
  }

  if (!PRIVATE_BUCKET) throw new Error('SUPABASE_PRIVATE_BUCKET is not set');

  const { data, error } = await sb.storage.from(PRIVATE_BUCKET).download(key);
  if (error) throw new Error(`private download failed: ${error.message}`);
  return Readable.fromWeb(data.stream());
}

/**
 * Remove a stored public file (logo, profile photo). Best-effort by design:
 * a missing file is not worth failing a retention purge or a delete request
 * over, and the row pointing at it is the thing that actually has to go.
 */
async function removePublic(storedPath) {
  if (!storedPath) return;
  const sb = supabase();

  // A local path, whether or not remote storage is configured now -- files
  // written before the switch still have to be deletable afterwards.
  if (storedPath.startsWith('/uploads/')) {
    try {
      fs.unlinkSync(path.join(PUBLIC_DIR, storedPath));
    } catch (err) {
      if (err.code !== 'ENOENT') console.error('[fileStorage] local delete failed:', storedPath, err.message);
    }
    return;
  }

  if (!sb) return;
  const marker = `/${BUCKET}/`;
  const i = storedPath.indexOf(marker);
  if (i === -1) return;
  const key = storedPath.slice(i + marker.length);
  const { error } = await sb.storage.from(BUCKET).remove([key]);
  if (error) console.error('[fileStorage] remote delete failed:', key, error.message);
}

/**
 * Remove a stored private file (a scanned receipt photo) by its bare key.
 * No URL-parsing branch needed, unlike removePublic() -- putPrivate() never
 * hands back anything other than a bare key, so there's no legacy shape to
 * guess at. Same best-effort reasoning as removePublic().
 */
async function removePrivate(key) {
  if (!key) return;
  const sb = supabase();

  if (!sb) {
    try {
      fs.unlinkSync(path.join(PRIVATE_DIR, key));
    } catch (err) {
      if (err.code !== 'ENOENT') console.error('[fileStorage] private local delete failed:', key, err.message);
    }
    return;
  }

  if (!PRIVATE_BUCKET) return;
  const { error } = await sb.storage.from(PRIVATE_BUCKET).remove([key]);
  if (error) console.error('[fileStorage] private remote delete failed:', key, error.message);
}

module.exports = {
  putPublic,
  putPrivate,
  getPrivate,
  removePublic,
  removePrivate,
  isValidScanKey,
  isRemote,
  assertProductionStorage,
  buildKey,
  BUCKET,
  PRIVATE_BUCKET,
  SCAN_EXT_MIME,
};
