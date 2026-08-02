// routes/loyalty.js
// Customer-facing punch card (join, earn punches, self-serve redeem).
//
// Flow: customer joins on a receipt (1st punch immediate) -> future receipts
// linked to their account add punches (see incrementLoyaltyPunch, called
// from email-capture.js and customer-account.js) -> once at 5, customer taps
// "Redeem", types in the merchant's redemption code (set by the merchant on
// their receipt design page, under Loyalty Program) -> if it matches, the
// reward is granted immediately and the card resets for the next cycle.

const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');

function requireCustomerAuth(req, res, next) {
  if (!req.session?.customerId) return res.status(401).json({ error: 'Not signed in' });
  next();
}

// Called after any transaction gets linked to a customer's account (joining
// the wallet, email capture, Google sign-in) -- adds a punch to that
// merchant's card if one already exists and isn't full.
// Exported so the three existing linking endpoints can call it without
// duplicating this logic.
async function incrementLoyaltyPunch(merchantId, customerId) {
  const card = await prisma.loyaltyCard.findUnique({ where: { merchantId_customerId: { merchantId, customerId } } });
  if (!card) return; // not enrolled in this merchant's program -- nothing to punch
  if (card.punches >= 5) return;

  await prisma.loyaltyCard.update({
    where: { id: card.id },
    data: { punches: card.punches + 1 },
  });
}

// --- Customer: join a merchant's loyalty program ----------------------------
router.post('/receipt/:transactionId/loyalty/join', requireCustomerAuth, async (req, res) => {
  const transaction = await prisma.transaction.findUnique({ where: { id: req.params.transactionId } });
  if (!transaction) return res.status(404).json({ error: 'Receipt not found' });

  const program = await prisma.loyaltyProgram.findUnique({ where: { merchantId: transaction.merchantId } });
  if (!program || !program.enabled) return res.status(400).json({ error: 'This merchant has no active loyalty program' });

  const card = await prisma.loyaltyCard.upsert({
    where: { merchantId_customerId: { merchantId: transaction.merchantId, customerId: req.session.customerId } },
    update: {}, // already enrolled -- joining again is a no-op, not a free extra punch
    create: { merchantId: transaction.merchantId, customerId: req.session.customerId, punches: 1 },
  });

  res.json({ success: true, cardId: card.id });
});

// --- Customer: redeem a full card by entering the merchant's code -----------
router.post('/loyalty/:cardId/redeem', requireCustomerAuth, async (req, res) => {
  const { code } = req.body;
  const card = await prisma.loyaltyCard.findUnique({ where: { id: req.params.cardId } });
  if (!card || card.customerId !== req.session.customerId) return res.status(404).json({ error: 'Not found' });
  if (card.punches < 5) return res.status(400).json({ error: 'Card is not full yet' });

  const program = await prisma.loyaltyProgram.findUnique({ where: { merchantId: card.merchantId } });
  const submitted = (code || '').trim().toLowerCase();
  if (!submitted || submitted !== program.redemptionCode.trim().toLowerCase()) {
    return res.status(400).json({ error: 'Incorrect code -- check with your cashier and try again.' });
  }

  await prisma.loyaltyCard.update({
    where: { id: card.id },
    data: { punches: 0, lastRedeemedAt: new Date() },
  });

  res.json({ success: true });
});

// --- Customer dashboard: every loyalty card across every merchant -----------
router.get('/account/loyalty', async (req, res) => {
  if (!req.session?.customerId) {
    return res.redirect(`/account/login?redirect=${encodeURIComponent('/account/loyalty')}`);
  }

  const [customer, cards] = await Promise.all([
    prisma.customer.findUnique({ where: { id: req.session.customerId } }),
    prisma.loyaltyCard.findMany({
      where: { customerId: req.session.customerId },
      include: { merchant: { include: { loyaltyProgram: true } } },
      orderBy: { updatedAt: 'desc' },
    }),
  ]);

  res.render('account-loyalty', {
    customerEmail: customer?.email || '',
    cards: cards
      .filter((c) => c.merchant.loyaltyProgram) // hide cards for a merchant that has since removed their program entirely
      .map((c) => ({
        id: c.id,
        merchantName: c.merchant.businessName,
        punches: c.punches,
        offerType: c.merchant.loyaltyProgram.offerType,
        offerValue: c.merchant.loyaltyProgram.offerValue,
      })),
  });
});

module.exports = router;
module.exports.incrementLoyaltyPunch = incrementLoyaltyPunch;
