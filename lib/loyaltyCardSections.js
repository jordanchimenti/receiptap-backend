// lib/loyaltyCardSections.js
//
// Splits a customer's loyalty cards into the ones they can act on and the
// ones they're still filling.
//
// A full card is the only one with something to do -- there's a Redeem button
// on it and a code to get from the cashier. Mixed into a list ordered by most
// recently stamped, a full card sinks below cards that are three stamps in,
// and the customer has to scan every card to find the reward they've already
// earned. Ready cards come first for that reason.
//
// Order inside each group is left exactly as it arrived (the route sorts by
// updatedAt desc), so the most recently used card still leads its section.

/**
 * @param {Array<{stamps:number, stampsRequired:number}>} cards
 * @returns {{ready: Array, inProgress: Array}}
 */
function splitLoyaltyCards(cards) {
  const ready = [];
  const inProgress = [];

  for (const card of cards || []) {
    // Defensive >=, not ===: a program whose stampsRequired was lowered after
    // a card was stamped leaves cards holding MORE stamps than the target, and
    // those are unquestionably redeemable. Matches the same >= test the view
    // and POST /loyalty/:cardId/redeem already use.
    if (isCardFull(card)) ready.push(card);
    else inProgress.push(card);
  }

  return { ready, inProgress };
}

function isCardFull(card) {
  const stamps = Number(card && card.stamps);
  const required = Number(card && card.stampsRequired);
  if (!Number.isFinite(stamps) || !Number.isFinite(required)) return false;
  // A zero-stamp program would otherwise mark every card full, including a
  // brand-new one with nothing on it.
  if (required <= 0) return false;
  return stamps >= required;
}

module.exports = { splitLoyaltyCards, isCardFull };
