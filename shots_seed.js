require('dotenv').config();
const prisma = require('./lib/prisma');
const { hashIdentifier } = require('./lib/hashIdentifier');
(async () => {
  const A = await prisma.merchant.create({ data:{ ownerName:'Sam', businessName:'The Corner Café', email:'demoA-tmp@example.invalid',
    subscriptionStatus:'ACTIVE', addressLine1:'412 Crown St', addressCity:'Niagara Falls', addressRegion:'ON' } });
  const B = await prisma.merchant.create({ data:{ ownerName:'Ana', businessName:'Bloom Bakery', email:'demoB-tmp@example.invalid',
    subscriptionStatus:'ACTIVE', addressLine1:'88 Queen St', addressCity:'Niagara Falls', addressRegion:'ON' } });
  for (const m of [A, B]) {
    await prisma.receiptTheme.create({ data:{ merchantId:m.id, phone:'(905) 555-0142', taxLabel:'HST',
      headerText:'Thanks for stopping by!', footerText:'See you next time', showPartnerProgram:true, showWalletSave:true } });
  }
  // receipt 1: the first tap, at the Café (has a card fingerprint -> consent box shows)
  await prisma.transaction.create({ data:{ id:'demo_first', merchantId:A.id, posProvider:'square', orderNumber:'A-1042',
    lineItems:[{name:'Flat White',quantity:1,unitPrice:520,total:520},{name:'Sourdough Toast',quantity:1,unitPrice:850,total:850}],
    subtotal:1370, tax:178, total:1548, cardBrand:'Visa', cardLast4:'4242', authCode:'04X219',
    cardFingerprintHash: hashIdentifier('sq_demo_card') } });
  // receipt 2: a later tap at the Bakery
  await prisma.transaction.create({ data:{ id:'demo_second', merchantId:B.id, posProvider:'square', orderNumber:'B-0317',
    lineItems:[{name:'Almond Croissant',quantity:2,unitPrice:475,total:950}],
    subtotal:950, tax:124, total:1074, cardBrand:'Visa', cardLast4:'4242',
    cardFingerprintHash: hashIdentifier('sq_demo_card') } });
  console.log('seeded');
  process.exit(0);
})();
