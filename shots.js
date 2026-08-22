const { chromium } = require('playwright');
const BASE = 'http://localhost:3000';
const PHONE = { width: 420, height: 900, deviceScaleFactor: 2 };

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const shot = async (name, opts = {}) => {
    await page.screenshot({ path: `/tmp/shots/${name}.png`, ...opts });
    console.log('  captured', name);
  };

  // 1 — first tap, anonymous: the receipt itself
  await page.goto(`${BASE}/receipt/demo_first`, { waitUntil: 'networkidle' });
  await shot('1-receipt');

  // 2 — the save modal, which is where a first-timer signs up
  await page.click('.action-button');           // "Save to Photos"
  await page.waitForSelector('.modal-overlay.open', { timeout: 5000 });
  await shot('2-save-modal');

  // 3 — fill it in and continue: creates the wallet, saves the receipt
  await page.fill('#modal-name-input', 'Sam Rivera');
  await page.fill('#modal-email-input', 'sam-tmp@example.invalid');
  await page.check('#cross-merchant-opt-in');   // opt into card recognition
  await shot('3-modal-filled');
  await page.click('.modal-box button.primary');
  await page.waitForURL('**/account/welcome', { timeout: 15000 });
  await shot('4-thank-you');

  // 5 — a LATER tap at a different shop: saves with no click at all
  await page.goto(`${BASE}/receipt/demo_second`, { waitUntil: 'networkidle' });
  await shot('5-second-tap');

  // 6 — the wallet, now holding both
  await page.goto(`${BASE}/account/receipts`, { waitUntil: 'networkidle' });
  await shot('6-wallet', { fullPage: true });

  // 7 — the two switches that control all of this
  await page.goto(`${BASE}/account/settings`, { waitUntil: 'networkidle' });
  await shot('7-settings', { fullPage: true });

  await browser.close();
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
