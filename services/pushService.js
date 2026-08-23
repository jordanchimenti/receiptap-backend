// services/pushService.js
// Web push to a customer's phone, using VAPID. Guarded the same way Stripe and
// Resend are (see services/stripeService.js): with no keys configured, push is
// simply off and every other channel still works -- an unset key must never
// throw at startup and take the server down.
//
// iOS caveat worth knowing: Safari only allows push for a site the user has
// added to their Home Screen. isPushConfigured() being true does not mean a
// given phone can actually receive one.

const webpush = require('web-push');
const prisma = require('../lib/prisma');

const PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const SUBJECT = process.env.VAPID_SUBJECT || 'mailto:support@receiptap.com';

const configured = Boolean(PUBLIC_KEY && PRIVATE_KEY);
if (configured) webpush.setVapidDetails(SUBJECT, PUBLIC_KEY, PRIVATE_KEY);

function isPushConfigured() {
  return configured;
}

function publicKey() {
  return PUBLIC_KEY;
}

// The browser hands us the whole subscription object; store only the three
// fields needed to send. Keyed on endpoint so re-subscribing the same browser
// updates rather than duplicating -- browsers reissue endpoints freely.
async function saveSubscription(customerId, subscription) {
  const endpoint = subscription?.endpoint;
  const p256dh = subscription?.keys?.p256dh;
  const auth = subscription?.keys?.auth;
  if (!endpoint || !p256dh || !auth) return null;

  return prisma.pushSubscription.upsert({
    where: { endpoint },
    create: { customerId, endpoint, p256dh, auth },
    // An endpoint can change hands if a shared device is signed into a second
    // account, so reassign it rather than leaving it pointed at the old one.
    update: { customerId, p256dh, auth },
  });
}

async function removeSubscription(endpoint) {
  if (!endpoint) return;
  await prisma.pushSubscription.deleteMany({ where: { endpoint } });
}

async function countSubscriptions(customerId) {
  return prisma.pushSubscription.count({ where: { customerId } });
}

// Fans out to every browser this customer registered. Failures are per-device
// and never thrown: one dead phone must not stop the others, and nothing here
// is allowed to fail the request that triggered it.
async function sendToCustomer(customerId, { title, body, url, tag }) {
  if (!configured) return { sent: 0, removed: 0, skipped: 'not-configured' };

  const subscriptions = await prisma.pushSubscription.findMany({ where: { customerId } });
  if (subscriptions.length === 0) return { sent: 0, removed: 0 };

  const payload = JSON.stringify({ title, body, url, tag });
  let sent = 0;
  let removed = 0;

  await Promise.all(
    subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload,
        );
        sent += 1;
        await prisma.pushSubscription.update({ where: { id: sub.id }, data: { lastUsedAt: new Date() } });
      } catch (err) {
        // 404/410 is the push service telling us this subscription is dead --
        // app uninstalled, permission revoked, site data cleared. Anything else
        // (a timeout, a 5xx) might be temporary, so keep the row and retry next
        // time rather than silently unsubscribing someone.
        if (err.statusCode === 404 || err.statusCode === 410) {
          await prisma.pushSubscription.delete({ where: { id: sub.id } }).catch(() => {});
          removed += 1;
        } else {
          console.error(`[pushService] send to ${sub.endpoint.slice(0, 40)}... failed:`, err.statusCode || err.message);
        }
      }
    }),
  );

  return { sent, removed };
}

module.exports = { isPushConfigured, publicKey, saveSubscription, removeSubscription, countSubscriptions, sendToCustomer };
