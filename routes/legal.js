// routes/legal.js
// Stub pages so the signup checkboxes link somewhere real instead of a dead
// link (no policy text lives here -- that's a separate, deliberate task),
// plus the re-acceptance interstitial the dashboard redirects to when
// middleware/legalReacceptance.js finds a stale acceptance. Both the stub
// pages and this form read their version/label from config/legal.js, the
// single source of truth.
const express = require('express');
const router = express.Router();
const { LEGAL_DOCUMENTS } = require('../config/legal');
const { recordLegalAcceptances } = require('../services/legalAcceptanceService');
const { safeNextPath } = require('../lib/safeRedirect');

function requireAuth(req, res, next) {
  if (!req.session?.merchantId) return res.redirect('/login');
  next();
}

// NOTE: must be registered before GET /legal/:slug below, or that wildcard
// route would swallow this path first and 404 it ("reaccept" isn't a known
// document slug).
router.get('/legal/reaccept', requireAuth, (req, res) => {
  res.render('legal-reaccept', {
    error: null,
    next: safeNextPath(req.query.next),
    documents: LEGAL_DOCUMENTS,
  });
});

router.post('/legal/reaccept', requireAuth, async (req, res) => {
  const { acceptTerms, acceptPrivacy, acceptDpa, next } = req.body;
  const safeNext = safeNextPath(next);

  if (!acceptTerms || !acceptPrivacy || !acceptDpa) {
    return res.render('legal-reaccept', {
      error: 'You must accept all three to continue.',
      next: safeNext,
      documents: LEGAL_DOCUMENTS,
    });
  }

  await recordLegalAcceptances(req.session.merchantId, req);
  res.redirect(safeNext);
});

const SLUG_TO_TYPE = { terms: 'TERMS', privacy: 'PRIVACY', dpa: 'DPA' };

router.get('/legal/:slug', (req, res) => {
  const documentType = SLUG_TO_TYPE[req.params.slug];
  if (!documentType) return res.status(404).send('Not found');
  res.render('legal-document', { doc: LEGAL_DOCUMENTS[documentType] });
});

module.exports = router;
