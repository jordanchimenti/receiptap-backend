// Loads every route and service, and asserts the exports other files import.
//
// This exists because of a real bug: routes/webhooks.js imported
// `categorizeInBackground` from services/categorize-receipt, which never
// exported it -- the name lived as two private copies inside route files.
// Square card recognition silently skipped AI categorisation for a full
// commit, swallowed by a best-effort try/catch. Nothing failed loudly.
//
// A missing export only surfaces when the line actually runs, which for
// webhook and background paths can be never in development. Requiring every
// module here turns that into an immediate, obvious failure.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const listJs = (dir) =>
  fs.readdirSync(path.join(ROOT, dir))
    .filter((f) => f.endsWith('.js'))
    .map((f) => `${dir}/${f}`);

const MODULES = [...listJs('routes'), ...listJs('services'), ...listJs('lib'), ...listJs('middleware')];

for (const mod of MODULES) {
  test(`${mod} loads and its imports resolve`, () => {
    assert.doesNotThrow(() => require(path.join(ROOT, mod)));
  });
}

// The exports other modules actually depend on. Each entry is a real import
// site elsewhere in the codebase; if one is renamed, this fails here rather
// than at 2am inside a webhook.
const CONTRACTS = {
  'services/categorize-receipt.js': ['categorizeTransaction', 'categorizeInBackground', 'CATEGORIES'],
  'services/shopperIdentity.js': [
    'recordIdentifier', 'recordIdentifierByHash',
    'findShopperByIdentifier', 'findShopperByIdentifierHash',
    'revokeIdentifier', 'revokeIdentifierByHash', 'listIdentifiersForShopper',
  ],
  'services/receiptAutoSave.js': ['autoSaveReceiptForKnownShopper'],
  'services/claimReceipt.js': ['claimReceiptForShopper'],
  'services/shopperConsentService.js': ['recordShopperConsent'],
  'services/dataRetentionService.js': ['purgeExpiredReceipts', 'deleteShopperByEmail', 'deleteShopperEverywhere'],
  'services/affiliateRates.js': ['MERCHANT_AFFILIATE_RATE', 'REGULAR_AFFILIATE_RATE'],
  'lib/hashIdentifier.js': ['hashIdentifier'],
  'lib/normalizeEmail.js': ['normalizeEmail'],
  'lib/code128.js': ['toSvg', 'isEncodable'],
  'lib/barcodeValue.js': ['resolveBarcodeValue', 'normalizeBarcodeValue'],
  'lib/taxLabels.js': ['TAX_LABEL_GROUPS', 'TAX_LABEL_OPTIONS', 'resolveTaxLabel', 'isCustomTaxLabel'],
  'lib/referralAttribution.js': ['resolveReferrer', 'attributeCustomerToMerchant', 'readReferralCookie'],
  'lib/safeRedirect.js': ['safeNextPath'],
  'routes/loyalty.js': ['awardLoyaltyStamps'],
  'routes/affiliates.js': ['ensureMerchantAffiliate', 'getCurrentAffiliate', 'buildAffiliateView'],
  'routes/theme-settings.js': ['computeReceiptSettingsData', 'saveReceiptSettings', 'handleLogoUpload'],
};

for (const [mod, names] of Object.entries(CONTRACTS)) {
  test(`${mod} exports what other modules import`, () => {
    const m = require(path.join(ROOT, mod));
    for (const name of names) {
      assert.notEqual(m[name], undefined, `${mod} is missing export "${name}"`);
    }
  });
}

test('every EJS template compiles', () => {
  const ejs = require('ejs');
  const viewsDir = path.join(ROOT, 'views');
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(d, e.name)) : (e.name.endsWith('.ejs') ? [path.join(d, e.name)] : []));
  for (const file of walk(viewsDir)) {
    assert.doesNotThrow(
      () => ejs.compile(fs.readFileSync(file, 'utf8'), { filename: file }),
      `${path.relative(ROOT, file)} failed to compile`
    );
  }
});
