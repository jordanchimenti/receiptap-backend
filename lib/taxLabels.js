// lib/taxLabels.js
// The tax line's name on a receipt. A dropdown rather than free text so the
// common cases are one tap and spelled consistently -- but "Custom" stays,
// because no fixed list survives contact with every county and municipality.
//
// Grouped by country: ReceipTap sells into Canada and the US, and the same
// receipt line is called very different things in each. The US entries cover
// the states that don't call it "sales tax" at all -- Hawaii charges a
// General Excise Tax, New Mexico a Gross Receipts Tax, Arizona a Transaction
// Privilege Tax -- plus the state/local splits that show up on receipts in
// jurisdictions where both apply.
//
// Shared by the Receipt design pages and saveReceiptSettings, so the list a
// merchant picks from and the list the server accepts can't drift apart.
const TAX_LABEL_GROUPS = [
  {
    region: 'General',
    labels: ['Tax', 'Sales Tax'],
  },
  {
    // No "GST/HST + PST": HST *replaces* GST+PST in the harmonised provinces,
    // so no Canadian jurisdiction charges HST and PST together. Manitoba's tax
    // is legally Retail Sales Tax (RST), not PST. TPS/TVQ are the French names
    // for GST/QST -- Quebec receipts are commonly issued in French.
    region: 'Canada',
    labels: [
      'GST',           // 5% federal -- AB, BC, SK, MB, QC and the territories
      'HST',           // ON 13%; NS, NB, NL, PEI 15%
      'GST/HST',
      'PST',           // BC, SK
      'RST',           // Manitoba
      'QST',           // Quebec
      'GST + PST',
      'GST + RST',
      'GST + QST',
      'TPS',           // GST, in French
      'TVQ',           // QST, in French
      'TPS + TVQ',
    ],
  },
  {
    region: 'United States',
    labels: [
      'State Sales Tax',
      'State & Local Tax',
      'Sales & Use Tax',
      'Local Tax',
      'City Tax',
      'County Tax',
      // Three states don't call it sales tax at all. Both the full name and
      // the abbreviation are offered -- the short form is what actually fits
      // on an 80mm thermal receipt, and is what locals recognise.
      'General Excise Tax',        // Hawaii
      'GET',
      'Gross Receipts Tax',        // New Mexico
      'GRT',
      'Transaction Privilege Tax', // Arizona
      'TPT',
      'Excise Tax',
      'Meals Tax',                 // prepared-food surcharges, e.g. VA, MA
      'Occupancy Tax',             // lodging
    ],
  },
  {
    region: 'Other',
    labels: ['VAT'],
  },
];

// Flat list, for validating what came back from the form.
const TAX_LABEL_OPTIONS = TAX_LABEL_GROUPS.flatMap((g) => g.labels);

const CUSTOM_TAX_LABEL = '__custom__';

/** True when a saved label isn't one of the presets -- the dropdown then
 *  opens on "Custom" with the merchant's own wording still in the box. */
function isCustomTaxLabel(label) {
  return Boolean(label) && !TAX_LABEL_OPTIONS.includes(label);
}

/**
 * Resolves what the form submitted into the label to store. Falls back to
 * "Tax" rather than an empty tax line, matching the previous free-text
 * behaviour where a blank submission kept a sane default.
 */
function resolveTaxLabel(selected, customValue) {
  if (selected === CUSTOM_TAX_LABEL) return (customValue || '').trim() || 'Tax';
  if (TAX_LABEL_OPTIONS.includes(selected)) return selected;
  return (selected || '').trim() || 'Tax';
}

module.exports = {
  TAX_LABEL_GROUPS,
  TAX_LABEL_OPTIONS,
  CUSTOM_TAX_LABEL,
  isCustomTaxLabel,
  resolveTaxLabel,
};
