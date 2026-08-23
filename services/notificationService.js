// services/notificationService.js
// Everything a customer gets told about, in one place.
//
// A notification is written to the database first and always -- that row is
// the record of record, and it's what the Alerts tab reads. Email and web push
// are best-effort copies of it: if Resend is down, or the customer turned
// loyalty email off, or their address is suppressed for that merchant, or no
// phone has ever accepted push, the in-app notification still lands. Delivery
// failures are logged and swallowed for the same reason receipt linking
// swallows them -- a customer's purchase must never fail because a
// notification couldn't be sent.

const prisma = require('../lib/prisma');
const { sendLoyaltyRewardReadyEmail } = require('./emailService');
const { isEmailSuppressed } = require('./emailSuppressionService');
const { sendToCustomer } = require('./pushService');

// Fired the moment a stamp card reaches its target -- once per fill, from
// awardLoyaltyStamps (routes/loyalty.js). A card that's redeemed and filled
// again notifies again, which is correct: that's a second reward.
async function notifyLoyaltyCardFull({ merchantId, customerId, program }) {
  const [customer, merchant] = await Promise.all([
    prisma.customer.findUnique({ where: { id: customerId } }),
    prisma.merchant.findUnique({ where: { id: merchantId }, include: { receiptTheme: true } }),
  ]);
  if (!customer || !merchant) return;

  // The name the customer actually recognises -- the one printed on their
  // receipts, not the legal entity on the account.
  const merchantName = merchant.receiptTheme?.displayName || merchant.businessName || 'a shop you visit';
  const reward = program.rewardLabel;

  const notification = await prisma.notification.create({
    data: {
      customerId,
      merchantId,
      type: 'LOYALTY_REWARD_READY',
      title: `Your ${merchantName} card is full`,
      body: `${reward} is ready to claim on your next visit.`,
      linkUrl: '/account/loyalty',
    },
  });

  // Both channels, independently: a failing email must not cost them the push,
  // and vice versa.
  await Promise.all([
    sendLoyaltyRewardReadyEmailSafely({ customer, merchantId, merchantName, reward }),
    sendPushSafely(customerId, {
      title: notification.title,
      body: notification.body,
      url: '/account/loyalty',
      // One alert per merchant: a second full card at the same shop replaces
      // the first on the lock screen instead of stacking.
      tag: `loyalty-${merchantId}`,
    }),
  ]);

  return notification;
}

async function sendLoyaltyRewardReadyEmailSafely({ customer, merchantId, merchantName, reward }) {
  if (!customer.loyaltyEmails) return;

  // Respects the same suppression list a merchant's own emails do -- someone
  // who asked that merchant to stop emailing them meant this too.
  if (await isEmailSuppressed(customer.email, merchantId)) return;

  try {
    await sendLoyaltyRewardReadyEmail({
      email: customer.email,
      name: customer.name,
      merchantName,
      reward,
    });
  } catch (err) {
    console.error(`[notificationService] loyalty email to ${customer.email} failed:`, err.message);
  }
}

async function sendPushSafely(customerId, payload) {
  try {
    await sendToCustomer(customerId, payload);
  } catch (err) {
    console.error(`[notificationService] push to customer ${customerId} failed:`, err.message);
  }
}

// --- Receipt activity -------------------------------------------------------
// Deliberately in-app only: no email, no push. A loyalty card filling up is
// news the customer couldn't otherwise know. Saving or deleting a receipt is
// something they just did with their own hands a second ago -- buzzing their
// phone about it would be noise, not a service. The Alerts tab is the record
// of what happened to their wallet, and that's where these belong.

function money(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

async function notifyReceiptSaved({ customerId, merchantName, totalCents }) {
  return prisma.notification.create({
    data: {
      customerId,
      type: 'RECEIPT_SAVED',
      title: 'Receipt saved',
      body: `${money(totalCents)} at ${merchantName} is now in your wallet.`,
      linkUrl: '/account/receipts',
    },
  });
}

async function notifyReceiptDeleted({ customerId, merchantName, totalCents }) {
  return prisma.notification.create({
    data: {
      customerId,
      type: 'RECEIPT_DELETED',
      // Names the amount on purpose: this is the receipt's own record of
      // itself once the receipt is gone, and it's what explains the drop in
      // the month's total.
      title: 'Receipt deleted',
      body: `${money(totalCents)} at ${merchantName} was removed from your wallet, and from this month's total.`,
      linkUrl: '/account/receipts',
    },
  });
}

async function listNotifications(customerId) {
  return prisma.notification.findMany({
    where: { customerId },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
}

function countUnread(customerId) {
  return prisma.notification.count({ where: { customerId, readAt: null } });
}

async function markAllRead(customerId) {
  await prisma.notification.updateMany({
    where: { customerId, readAt: null },
    data: { readAt: new Date() },
  });
}

module.exports = {
  notifyLoyaltyCardFull,
  notifyReceiptSaved,
  notifyReceiptDeleted,
  listNotifications,
  countUnread,
  markAllRead,
};
