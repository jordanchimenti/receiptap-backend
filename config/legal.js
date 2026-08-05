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
    version: '2026-08-05.1',
    lastUpdated: '2026-08-05',
    label: 'Terms of Service',
  },
  PRIVACY: {
    version: '2026-08-05.1',
    lastUpdated: '2026-08-05',
    label: 'Privacy Policy',
  },
  DPA: {
    version: '2026-08-05.1',
    lastUpdated: '2026-08-05',
    label: 'Data Processing Agreement',
  },
};

// The tap-screen shopper-consent wording -- versioned separately from the
// documents above, since this can change on its own schedule and isn't
// itself a legal document.
const SHOPPER_CONSENT = {
  version: '2026-08-05.1',
  transactionalText: "We'll use your email to send you this receipt.",
  marketingLabel: 'Also send me deals and updates by email. I can unsubscribe anytime.',
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

module.exports = { LEGAL_DOCUMENTS, SHOPPER_CONSENT, isNewerVersion };
