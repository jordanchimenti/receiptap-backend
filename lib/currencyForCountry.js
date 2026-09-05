// lib/currencyForCountry.js
// A fallback for the two POS providers (Clover, Lightspeed) whose payloads
// carry no per-order currency field at all -- see the "currency: null"
// comments in routes/webhooks.js this replaces. That null wasn't a bug, it
// was "don't invent a currency the POS never actually reported" -- this
// helper is different in kind, not a walk-back of that reasoning: a
// merchant's own registered country (Merchant.addressCountry, filled in on
// Business Settings) is real account data, not a guess, and this app only
// ever sells into Canada and the US (see lib/taxLabels.js), so the mapping
// is unambiguous for the two countries it actually needs to cover.
//
// Deliberately narrow: any country outside these two stays null rather than
// defaulting to something that might be wrong, same "don't guess" spirit as
// before -- there's no third market this app currently serves to infer for.
const COUNTRY_TO_CURRENCY = {
  CA: 'CAD',
  US: 'USD',
};

function currencyForCountry(countryCode) {
  return COUNTRY_TO_CURRENCY[countryCode] || null;
}

module.exports = { currencyForCountry };
