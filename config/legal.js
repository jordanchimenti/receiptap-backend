// config/legal.js
// Single source of truth for every legal-document and consent-wording
// version this app tracks. The stub legal pages, the signup checkboxes, the
// LegalAcceptance rows written on signup, the re-acceptance interstitial,
// and the tap-screen ShopperConsent rows ALL read their version strings
// from here -- nowhere else is allowed to hardcode one. That's what makes
// "the version shown on a page" and "the version recorded against an
// acceptance row" structurally unable to drift apart.
//
// VERSION-BUMP RULE: any change to the wording of a legal document, or to
// the tap-screen consent strings below, requires bumping that item's
// version string in this file. See CLAUDE.md.
//
// Version format: "YYYY-MM-DD.N" -- the date this version was published,
// plus a same-day sequence number (starts at 1) for same-day revisions.

const LEGAL_DOCUMENTS = {
  TERMS: {
    version: '2026-08-07.1',
    lastUpdated: '2026-08-07',
    label: 'Terms of Service',
  },
  PRIVACY: {
    version: '2026-08-18.1',
    lastUpdated: '2026-08-18',
    label: 'Privacy Policy',
  },
  DPA: {
    version: '2026-08-18.1',
    lastUpdated: '2026-08-18',
    label: 'Data Processing Agreement',
  },
  // The two documents above are written for the business that creates a
  // ReceipTap merchant account (see legal-terms-content.ejs's own intro
  // paragraph). SHOPPER_TERMS/SHOPPER_PRIVACY below are the separate pair
  // for an individual who creates a ReceipTap Wallet account (the customer-
  // facing login/signup/settings pages) -- different relationship, so
  // different documents, versioned completely independently of TERMS/
  // PRIVACY/DPA. There's no shopper-side DPA: a DPA governs a
  // controller/processor relationship, and an individual wallet holder
  // isn't a data controller the way a merchant is.
  SHOPPER_TERMS: {
    version: '2026-08-19.1',
    lastUpdated: '2026-08-19',
    label: 'Wallet Terms of Service',
  },
  SHOPPER_PRIVACY: {
    version: '2026-08-19.1',
    lastUpdated: '2026-08-19',
    label: 'Wallet Privacy Policy',
  },
};

// The LegalAcceptance table (see prisma/schema.prisma's LegalDocumentType
// enum) only ever stores merchant-side acceptances -- TERMS/PRIVACY/DPA.
// SHOPPER_TERMS/SHOPPER_PRIVACY above are never written there (wallet
// signup uses passive "By continuing..." text, not a checkbox -- see
// docs/LEGAL_REVIEW_NOTES.md item 26). services/legalAcceptanceService.js
// must use this list, NOT Object.keys(LEGAL_DOCUMENTS), anywhere it
// defaults to "every document a merchant accepts" -- looping over literally
// every key in LEGAL_DOCUMENTS would try to write/query a documentType the
// Prisma enum doesn't have, and crash.
const MERCHANT_DOCUMENT_TYPES = ['TERMS', 'PRIVACY', 'DPA'];

// The tap-screen shopper-consent wording -- versioned separately from the
// documents above, since this can change on its own schedule and isn't
// itself a legal document.
const SHOPPER_CONSENT = {
  // 2026-08-21.1 — the previous wording said "we'll use your email to send you
  // this receipt", which was never true: nothing in this app emails a shopper
  // a receipt (services/emailService.js only sends password resets and merchant
  // verification). The email creates their wallet, which is where the receipt
  // actually goes, and it's also visible to the business on their customer-
  // emails list -- so both real uses are now stated.
  version: '2026-08-21.2',
  transactionalText: "We'll use your email to save this receipt to your ReceipTap wallet. The business you bought from can see it too.",
  marketingLabel: 'Also send me deals and updates by email. I can unsubscribe anytime.',
  // 2026-08-21.2 — added for cross-merchant recognition. Deliberately its own
  // string, its own checkbox and its own stored flag: recognising a returning
  // shopper is a DIFFERENT PURPOSE from delivering their receipt, and under
  // PIPEDA a separate purpose needs separate, un-bundled consent. Worded to
  // say what actually happens (the card is recognised, not identified) and
  // left unchecked by default -- pre-ticking it would not be consent.
  crossMerchantLabel:
    'Recognise me at other ReceipTap businesses so my receipts save automatically, without tapping. Uses your card, never your card number. I can turn this off anytime.',
};

// Versions look like "2026-08-05.1" -- compare the date part first, then
// the trailing sequence number as a tiebreaker for same-day revisions.
// Used by the re-acceptance interstitial to decide whether a merchant's
// most recent LegalAcceptance for a document is behind the current one.
function isNewerVersion(a, b) {
  const [aDate, aSeq] = a.split('.');
  const [bDate, bSeq] = b.split('.');
  if (aDate !== bDate) return aDate > bDate;
  return Number(aSeq) > Number(bSeq);
}

module.exports = { LEGAL_DOCUMENTS, MERCHANT_DOCUMENT_TYPES, SHOPPER_CONSENT, isNewerVersion };
