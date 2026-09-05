// services/toastPoller.js
// Polling is the ONLY way this app can learn about a Toast sale -- unlike
// Lightspeed, where polling is a backstop for a webhook that mostly works,
// Toast's Standard API access tier has no documented webhook mechanism at
// all (webhook registration appears to require the Partner Integration
// Program, which this app doesn't have). This is the primary path, run on
// an interval from server.js, same non-distributed setInterval pattern as
// the retention purge and Lightspeed poller.
const prisma = require('../lib/prisma');
const { getValidAccessToken, fetchOrdersBulk } = require('./toastService');
const { processToastOrder } = require('./toastSaleSync');

const PAGE_SIZE = 100;
const WINDOW_MS = 60 * 60 * 1000; // Toast's own documented max startDate/endDate span
const INITIAL_LOOKBACK_MS = 60 * 60 * 1000; // first-ever poll for a merchant: look back 1 hour
// Caps how much backlog one poll tick will chew through -- if a merchant's
// been disconnected from polling for days (app downtime, a long-expired
// token finally fixed, etc.), this bounds one run to ~1 day of catch-up
// rather than blocking the shared setInterval for a very long time; the
// next tick continues from wherever this one stopped.
const MAX_WINDOWS_PER_RUN = 24;

// One merchant's worth of catching up, walking forward from where the last
// successful poll left off in <=1-hour chunks (Toast's own limit on
// startDate/endDate). Each chunk is paginated fully before advancing.
async function pollToastMerchant(merchant) {
  const accessToken = await getValidAccessToken(merchant);
  const now = new Date();
  let windowStart = merchant.toastLastPollAt || new Date(now.getTime() - INITIAL_LOOKBACK_MS);

  let caught = 0;
  let windows = 0;
  while (windowStart < now && windows < MAX_WINDOWS_PER_RUN) {
    const windowEnd = new Date(Math.min(windowStart.getTime() + WINDOW_MS, now.getTime()));

    let page = 1;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const orders = await fetchOrdersBulk(merchant.toastRestaurantGuid, accessToken, {
        startDate: windowStart,
        endDate: windowEnd,
        page,
        pageSize: PAGE_SIZE,
      });
      for (const order of orders) {
        caught += await processToastOrder(merchant, merchant.toastRestaurantGuid, order);
      }
      if (orders.length < PAGE_SIZE) break; // last page
      page += 1;
    }

    windowStart = windowEnd;
    windows += 1;
    // Persisted after every chunk, not just at the end -- if a later chunk
    // in a long catch-up run throws, this run's progress so far isn't lost;
    // the next tick resumes from here instead of redoing it.
    await prisma.merchant.update({ where: { id: merchant.id }, data: { toastLastPollAt: windowStart } });
  }

  if (caught > 0) {
    console.log(`[toast poller] Saved ${caught} check(s) for merchant ${merchant.id}`);
  }
  if (windows >= MAX_WINDOWS_PER_RUN && windowStart < now) {
    console.warn(`[toast poller] Merchant ${merchant.id} still has backlog after ${MAX_WINDOWS_PER_RUN} windows -- will continue next tick`);
  }
}

async function pollAllToastMerchants() {
  const merchants = await prisma.merchant.findMany({
    where: { toastRestaurantGuid: { not: null } },
    include: { receiptTheme: true },
  });

  for (const merchant of merchants) {
    try {
      await pollToastMerchant(merchant);
    } catch (err) {
      console.error(`[toast poller] Failed for merchant ${merchant.id}:`, err.message);
    }
  }
}

module.exports = { pollAllToastMerchants };
