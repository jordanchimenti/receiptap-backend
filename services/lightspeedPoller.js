// services/lightspeedPoller.js
// Backstop for Lightspeed's sale.update webhook. Lightspeed's own API docs
// say webhook delivery "cannot be guaranteed" and recommend polling to stay
// in sync -- confirmed directly: a real test sale on a real trial store,
// with a correctly registered and active webhook subscription, never
// arrived at routes/webhooks.js at all. This periodically asks Lightspeed
// directly for sales this app hasn't seen yet, so a missed webhook delivery
// doesn't mean a merchant's receipt is just gone.
//
// Run on an interval from server.js, same non-distributed setInterval
// pattern as the retention purge job -- see CLAUDE.md for that tradeoff.
const prisma = require('../lib/prisma');
const { getValidAccessToken, lightspeedApiBaseUrl, LIGHTSPEED_API_VERSION } = require('./lightspeedService');
const { processLightspeedSale } = require('./lightspeedSaleSync');

const PAGE_SIZE = 100;

// One merchant's worth of catching up. Cursor is Sale._metadata.version, a
// monotonically increasing per-retailer sequence -- not a timestamp, since
// Lightspeed's /sales endpoint has no date-range filter (confirmed against
// their own API reference). `after` excludes what's already been seen, so
// re-running this never reprocesses a sale twice on its own, but
// processLightspeedSale's own existing-transaction check is still the real
// guard, since the webhook could have already saved a sale this hasn't
// advanced past yet.
async function pollLightspeedMerchant(merchant) {
  const accessToken = await getValidAccessToken(merchant);
  const params = new URLSearchParams({ page_size: String(PAGE_SIZE) });
  if (merchant.lightspeedLastSaleVersion != null) {
    params.set('after', String(merchant.lightspeedLastSaleVersion));
  }

  const res = await fetch(
    `${lightspeedApiBaseUrl(merchant.lightspeedDomainPrefix)}/api/${LIGHTSPEED_API_VERSION}/sales?${params}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) throw new Error(`Failed to list Lightspeed sales: ${res.status} ${await res.text()}`);
  const body = await res.json();
  const sales = body.data || [];

  let caught = 0;
  for (const sale of sales) {
    try {
      const saved = await processLightspeedSale(merchant, merchant.lightspeedDomainPrefix, accessToken, sale);
      if (saved) caught += 1;
    } catch (err) {
      console.error(`[lightspeed poller] Failed to process sale ${sale.id} for merchant ${merchant.id}:`, err.message);
    }
  }

  // Advances even when nothing in this page was a new closed sale --
  // parked/pending sales still consume version numbers, and never moving
  // the cursor past them would mean re-fetching the same page forever.
  // JSON has no int64 type, so this arrives as a plain JS number -- BigInt()
  // on it is exact as long as it's still within Number's safe integer range
  // (real observed values so far: ~55 billion, nowhere close to unsafe).
  const maxVersion = body.version?.max != null ? BigInt(body.version.max) : null;
  if (maxVersion != null && maxVersion !== merchant.lightspeedLastSaleVersion) {
    await prisma.merchant.update({
      where: { id: merchant.id },
      data: { lightspeedLastSaleVersion: maxVersion },
    });
  }

  if (caught > 0) {
    console.log(`[lightspeed poller] Caught ${caught} sale(s) the webhook missed for merchant ${merchant.id}`);
  }
}

async function pollAllLightspeedMerchants() {
  const merchants = await prisma.merchant.findMany({
    where: { lightspeedDomainPrefix: { not: null } },
    include: { receiptTheme: true },
  });

  for (const merchant of merchants) {
    try {
      await pollLightspeedMerchant(merchant);
    } catch (err) {
      console.error(`[lightspeed poller] Failed for merchant ${merchant.id}:`, err.message);
    }
  }
}

module.exports = { pollAllLightspeedMerchants };
