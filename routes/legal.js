// routes/legal.js
// Serves the three real legal documents (Terms, Privacy, DPA -- their
// actual content lives in views/partials/legal-*-content.ejs), plus the
// re-acceptance interstitial the dashboard redirects to when
// middleware/legalReacceptance.js finds a stale acceptance. Both the
// documents and this form read their version/label from config/legal.js,
// the single source of truth.
const express = require('express');
const router = express.Router();
const { LEGAL_DOCUMENTS } = require('../config/legal');
const RETENTION = require('../config/retention');
const { ENTITY } = require('../config/entity');
const {
  recordLegalAcceptances,
  getStaleDocumentTypes,
  recordShopperLegalAcceptances,
  getStaleShopperDocumentTypes,
} = require('../services/legalAcceptanceService');
const { safeNextPath } = require('../lib/safeRedirect');

function requireAuth(req, res, next) {
  if (!req.session?.merchantId) return res.redirect('/login');
  next();
}

function requireShopperAuth(req, res, next) {
  if (!req.session?.customerId) return res.redirect('/account/login');
  next();
}

// Wallet's own allowlist, mirroring lib/safeRedirect.js's shape for the
// merchant flow -- only relative /account/* paths are honored, so a next=
// query param can never be crafted to send a shopper off-site.
function safeShopperNextPath(next, fallback = '/account/receipts') {
  if (typeof next !== 'string' || !next.startsWith('/account/')) return fallback;
  if (next.startsWith('//') || next.includes('://')) return fallback;
  return next;
}

// "Terms of Service" / "Terms of Service and Data Processing Agreement" /
// "Terms of Service, Privacy Policy, and Data Processing Agreement" -- turns
// the stale document type(s) into a plain-English sentence fragment for the
// interstitial's headline, always in TERMS/PRIVACY/DPA order.
function joinDocumentLabels(documentTypes) {
  const labels = documentTypes.map((type) => LEGAL_DOCUMENTS[type].label);
  if (labels.length === 1) return labels[0];
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(', ')}, and ${labels[labels.length - 1]}`;
}

// NOTE: must be registered before GET /legal/:slug below, or that wildcard
// route would swallow this path first and 404 it ("reaccept" isn't a known
// document slug).
router.get('/legal/reaccept', requireAuth, async (req, res) => {
  const safeNext = safeNextPath(req.query.next);
  const staleTypes = await getStaleDocumentTypes(req.session.merchantId);

  // Nothing actually stale (e.g. already re-accepted in another tab) --
  // nothing to show here, just continue on.
  if (staleTypes.length === 0) return res.redirect(safeNext);

  res.render('legal-reaccept', {
    error: null,
    next: safeNext,
    documents: LEGAL_DOCUMENTS,
    changedLabel: joinDocumentLabels(staleTypes),
  });
});

router.post('/legal/reaccept', requireAuth, async (req, res) => {
  const { acceptAll, next } = req.body;
  const safeNext = safeNextPath(next);
  const staleTypes = await getStaleDocumentTypes(req.session.merchantId);

  if (staleTypes.length === 0) return res.redirect(safeNext);

  if (!acceptAll) {
    return res.render('legal-reaccept', {
      error: 'You must agree to continue.',
      next: safeNext,
      documents: LEGAL_DOCUMENTS,
      changedLabel: joinDocumentLabels(staleTypes),
    });
  }

  // Only the document type(s) that were actually found stale get a fresh
  // row -- e.g. bumping only DPA.version means only a new DPA row is
  // written here; the merchant's existing, still-current TERMS and PRIVACY
  // rows are left exactly as they are. See recordLegalAcceptances()'s
  // docstring in services/legalAcceptanceService.js for why this differs
  // from the signup call site, which always writes all three.
  await recordLegalAcceptances(req.session.merchantId, req, staleTypes);
  res.redirect(safeNext);
});

// Wallet mirror of /legal/reaccept above -- same "must be registered before
// GET /legal/:slug" reasoning ("wallet-reaccept" isn't a document slug
// either).
router.get('/legal/wallet-reaccept', requireShopperAuth, async (req, res) => {
  const safeNext = safeShopperNextPath(req.query.next);
  const staleTypes = await getStaleShopperDocumentTypes(req.session.customerId);

  if (staleTypes.length === 0) return res.redirect(safeNext);

  res.render('legal-reaccept-wallet', {
    error: null,
    next: safeNext,
    documents: LEGAL_DOCUMENTS,
    changedLabel: joinDocumentLabels(staleTypes),
  });
});

router.post('/legal/wallet-reaccept', requireShopperAuth, async (req, res) => {
  const { acceptAll, next } = req.body;
  const safeNext = safeShopperNextPath(next);
  const staleTypes = await getStaleShopperDocumentTypes(req.session.customerId);

  if (staleTypes.length === 0) return res.redirect(safeNext);

  if (!acceptAll) {
    return res.render('legal-reaccept-wallet', {
      error: 'You must agree to continue.',
      next: safeNext,
      documents: LEGAL_DOCUMENTS,
      changedLabel: joinDocumentLabels(staleTypes),
    });
  }

  await recordShopperLegalAcceptances(req.session.customerId, req, staleTypes);
  res.redirect(safeNext);
});

const SLUG_TO_TYPE = {
  terms: 'TERMS',
  privacy: 'PRIVACY',
  dpa: 'DPA',
  'wallet-terms': 'SHOPPER_TERMS',
  'wallet-privacy': 'SHOPPER_PRIVACY',
};

router.get('/legal/:slug', (req, res) => {
  const documentType = SLUG_TO_TYPE[req.params.slug];
  if (!documentType) return res.status(404).send('Not found');

  res.render('legal-document', {
    doc: LEGAL_DOCUMENTS[documentType],
    documentType,
    entity: ENTITY,
    retention: RETENTION,
  });
});

module.exports = router;
