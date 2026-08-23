// Brute-force guard for claiming a ReceipTap by activation code alone.
//
// The original flow (tap the puck -> /claim/:puckId -> type the code) needed
// BOTH the 10-character puck ID and the 6-character code, so guessing was
// never realistic. Claiming by code alone drops that to 32^6 -- still large,
// but now it's the only secret standing between an attacker and someone
// else's hardware, and every guess is a cheap HTTP request.
//
// Deliberately in-memory: attempts reset when the process restarts, and each
// instance counts on its own. That's the right trade for a single-instance
// deployment and it adds no dependency -- but if ReceipTap ever runs more
// than one instance, this needs to move to the database or Redis to mean
// anything.
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 10;

const attempts = new Map(); // key -> { count, firstAt }

function prune(now) {
  for (const [key, rec] of attempts) {
    if (now - rec.firstAt > WINDOW_MS) attempts.delete(key);
  }
}

/** True when this key has burned through its allowance and should be refused. */
function isLockedOut(key) {
  const now = Date.now();
  prune(now);
  const rec = attempts.get(key);
  if (!rec) return false;
  if (now - rec.firstAt > WINDOW_MS) {
    attempts.delete(key);
    return false;
  }
  return rec.count >= MAX_FAILURES;
}

/** Call on a WRONG code. Correct codes should call clear() instead. */
function recordFailure(key) {
  const now = Date.now();
  const rec = attempts.get(key);
  if (!rec || now - rec.firstAt > WINDOW_MS) {
    attempts.set(key, { count: 1, firstAt: now });
    return;
  }
  rec.count += 1;
}

/** A successful claim wipes the slate -- a merchant who fat-fingered a few
 *  codes before getting it right shouldn't stay penalised. */
function clear(key) {
  attempts.delete(key);
}

function _reset() {
  attempts.clear();
}

module.exports = { isLockedOut, recordFailure, clear, MAX_FAILURES, WINDOW_MS, _reset };
