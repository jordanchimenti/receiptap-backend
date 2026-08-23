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

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'uploads';

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
  if (process.env.NODE_ENV === 'production' && !isRemote()) {
    logger.error(
      '[fileStorage] WARNING: uploads are being written to local disk in production. ' +
      'This container\'s filesystem does not survive a redeploy, so every scanned ' +
      'receipt photo, logo and profile photo will be destroyed by the next deploy ' +
      'while the database still references them. Set SUPABASE_URL and ' +
      'SUPABASE_SERVICE_KEY to store them durably.'
    );
    return false;
  }
  return true;
}

/** A collision-proof name that keeps the original extension. */
function buildKey(folder, originalName, prefix = '') {
  const ext = (path.extname(originalName || '') || '').toLowerCase();
  const stamp = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
  return `${folder}/${prefix ? prefix + '-' : ''}${stamp}${ext}`;
}

/**
 * Store a buffer and return the public path to reference it by.
 * Both backends return a `/uploads/...`-shaped path so nothing downstream --
 * templates, the receipt renderer, the retention purge -- has to know or care
 * which one is in use.
 */
async function put(folder, file, { prefix = '' } = {}) {
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
  });
  if (error) throw new Error(`upload failed: ${error.message}`);

  const { data } = sb.storage.from(BUCKET).getPublicUrl(key);
  return data.publicUrl;
}

/**
 * Remove a stored file. Best-effort by design: a missing file is not worth
 * failing a retention purge or a delete request over, and the row pointing at
 * it is the thing that actually has to go.
 */
async function remove(storedPath) {
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

module.exports = { put, remove, isRemote, assertProductionStorage, buildKey, BUCKET };
