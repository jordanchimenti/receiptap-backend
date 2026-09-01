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
  // 2026-09-01 -- ENTITY.registeredAddress (routes/legal.js) filled in for
  // the first time on all five documents below, replacing the literal
  // "[[REVIEW: address pending]]" placeholder every one of them was
  // rendering. That's a change to what the page actually shows, so every
  // document gets the same version bump per the rule above, which is also
  // what puts every merchant who already accepted the old (placeholder)
  // wording through /legal/reaccept on their next dashboard visit.
  // 2026-09-01.2/.3 (TERMS/PRIVACY/DPA/SHOPPER_PRIVACY) -- softened the
  // retention-window paragraphs from stating deletion as something that
  // already happens on schedule to stating it as policy/commitment, since
  // RETENTION_PURGE_ENABLED has never been set and nothing has ever
  // actually auto-deleted on this schedule. Each paragraph now points to
  // a real, working manual-deletion contact instead of implying live
  // enforcement. TERMS only picks up this one bump today (.1 -> .2); the
  // other three already had a same-day bump from the Railway/subprocessor
  // disclosure, so they go to .3.
  // 2026-09-01.3/.4 (TERMS/DPA/SHOPPER_TERMS) -- found while checking for
  // more instances of the "Unsubscribe from marketing" bug (a [[REVIEW]]
  // marker as the ONLY content of its element, which strip() then hides
  // in production, leaving an empty heading or a broken sentence): Terms'
  // "Taxes" section, DPA's "Demonstrating compliance" and "Liability"
  // sections, and the Wallet Terms' liability sentence ("...capped at .")
  // were all live and empty/broken this way. Patched with honest,
  // non-committal real copy -- not the actual decisions, which still need
  // the founder/a lawyer -- so nothing on the live site reads as broken.
  // 2026-09-01.4 (TERMS only) -- the "Taxes" section's non-committal
  // placeholder from .3 above was itself replaced with the real founder
  // decision (tax-inclusive pricing, no Stripe Tax) minutes later -- a
  // second content change past .3 that needed its own bump.
  // 2026-09-01.5 (TERMS only) -- "Price changes" specifically promised to
  // *email* a price-increase notice, but the mechanism built for it
  // (/admin/announce) only ever delivers in-app -- reworded to promise
  // what the mechanism actually does, rather than leaving the two
  // disagreeing with each other.
  TERMS: {
    version: '2026-09-01.5',
    lastUpdated: '2026-09-01',
    label: 'Terms of Service',
  },
  // 2026-09-01.4 (PRIVACY only) -- the "Unsubscribe from marketing" bullet
  // was entirely inside a [[REVIEW: ...]] marker, which the strip() helper
  // in views/legal-document.ejs hides in production -- so real visitors
  // saw the bullet's label with nothing after it. Replaced with the real
  // customer-facing copy the marker already described.
  PRIVACY: {
    version: '2026-09-01.4',
    lastUpdated: '2026-09-01',
    label: 'Privacy Policy',
  },
  DPA: {
    version: '2026-09-01.4',
    lastUpdated: '2026-09-01',
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
  // 2026-09-01.3 (SHOPPER_TERMS only) -- same pattern as TERMS above: the
  // broken-sentence fix at .2 was itself replaced with the real founder
  // decision (no additional dollar cap, relying on the legal minimum)
  // minutes later, which needed its own bump.
  SHOPPER_TERMS: {
    version: '2026-09-01.3',
    lastUpdated: '2026-09-01',
    label: 'Wallet Terms of Service',
  },
  // 2026-09-01.4 (SHOPPER_PRIVACY only) -- founder decision: scanned
  // receipts now age out on the same SHOPPER_RECEIPT_MONTHS schedule as
  // tapped ones (purgeExpiredScannedReceipts in dataRetentionService.js),
  // instead of being kept until account deletion. Wording updated to match.
  SHOPPER_PRIVACY: {
    version: '2026-09-01.4',
    lastUpdated: '2026-09-01',
    label: 'Wallet Privacy Policy',
  },
};

// The LegalAcceptance table (see prisma/schema.prisma's LegalDocumentType
// enum) only ever stores merchant-side acceptances -- TERMS/PRIVACY/DPA.
// services/legalAcceptanceService.js must use this list, NOT
// Object.keys(LEGAL_DOCUMENTS), anywhere it defaults to "every document a
// merchant accepts" -- looping over literally every key in LEGAL_DOCUMENTS
// would try to write/query a documentType the Prisma enum doesn't have,
// and crash.
const MERCHANT_DOCUMENT_TYPES = ['TERMS', 'PRIVACY', 'DPA'];

// The wallet-side mirror -- SHOPPER_TERMS/SHOPPER_PRIVACY, stored in the
// separate ShopperLegalAcceptance table (its own enum, since a shopper's
// acceptance is a different relationship with no DPA equivalent -- see
// that model's schema comment). Signup still uses passive "By
// continuing..." text, not a checkbox (docs/LEGAL_REVIEW_NOTES.md item
// 26), but a row is now written at account creation regardless -- same
// "the continue action IS the consent" reasoning the merchant side's
// Google/Apple/Microsoft sign-in already relies on, just extended to
// every wallet signup path.
const SHOPPER_DOCUMENT_TYPES = ['SHOPPER_TERMS', 'SHOPPER_PRIVACY'];

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
  version: '2026-08-22.2',
  transactionalText: "We'll use your email to save this receipt to your ReceipTap wallet. The business you bought from can see it too.",
  marketingLabel: 'Also send me deals and updates by email. I can unsubscribe anytime.',
  // 2026-08-21.2 — added for cross-merchant recognition. Deliberately its own
  // string, its own checkbox and its own stored flag: recognising a returning
  // shopper is a DIFFERENT PURPOSE from delivering their receipt, and under
  // PIPEDA a separate purpose needs separate, un-bundled consent. Worded to
  // say what actually happens (the card is recognised, not identified) and
  // left unchecked by default -- pre-ticking it would not be consent.
  // 2026-08-22.2 — cut to one line. The detail it used to carry (Square-only,
  // never the card number) now lives on the Settings card, where there's room
  // to explain and where someone goes to change it -- rather than as a
  // paragraph nobody reads at the till.
  //
  // What stayed, deliberately: "using my card". Without it this is
  // indistinguishable from the save-on-tap switch, and the thing being
  // consented to IS the card being recognised. A consent line that doesn't
  // name what's used isn't consent to it.
  crossMerchantLabel: 'Auto-save my receipts at other ReceipTap businesses, using my card.',
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

module.exports = { LEGAL_DOCUMENTS, MERCHANT_DOCUMENT_TYPES, SHOPPER_DOCUMENT_TYPES, SHOPPER_CONSENT, isNewerVersion };
