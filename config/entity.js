// config/entity.js
// Single source of truth for the legal entity behind ReceipTap -- shared by
// routes/legal.js (the legal documents) and services/easypostService.js
// (the hardware-return shipping label, which needs the same address as
// discrete fields rather than one printed string). Moved out of
// routes/legal.js, which used to define this inline, so a route file isn't
// something a service has to import from.
const ENTITY = {
  legalName: 'J.A.C. GLOBAL APPROACH LTD.',
  registeredAddress: '2150 Winston Park Drive, Unit 203, Oakville, Ontario, L6H 5V1, Canada',
  contactRole: 'Privacy Officer',
  contactEmail: 'privacy@receiptap.com',
  governingLaw: 'Ontario, Canada',
};

// Structured form of the same address above, for anything that needs
// discrete fields (shipping labels, carrier APIs) instead of one printed
// string -- kept in sync with registeredAddress by hand. There's only one
// address, changed rarely, so parsing one from the other isn't worth
// building.
const RETURN_ADDRESS = {
  name: ENTITY.legalName,
  street1: '2150 Winston Park Drive',
  street2: 'Unit 203',
  city: 'Oakville',
  state: 'ON',
  zip: 'L6H 5V1',
  country: 'CA',
};

module.exports = { ENTITY, RETURN_ADDRESS };
