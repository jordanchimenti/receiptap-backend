// scripts/generate-batch.js
//
// Run this every time you place a new hardware order.
// Usage: node generate-batch.js 5000
//
// Outputs:
//   output/nfc-manifest.csv       -> send to your NFC supplier (chip encoding)
//   output/insert-card-data.csv   -> send to your print shop / packaging supplier
//   + inserts every puck as UNCLAIMED directly into your database

const { customAlphabet } = require('nanoid');
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const BASE_URL = 'https://receiptap.com';

// Excludes visually ambiguous characters: 0/O, 1/I/l
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz';
const generatePuckId = customAlphabet(ALPHABET, 10);   // long, never typed by a human — read via NFC only
const generateClaimCode = customAlphabet(ALPHABET, 6); // short, may be typed manually

async function generateBatch(count) {
  const batch = [];
  const seenIds = new Set();
  const seenCodes = new Set();

  while (batch.length < count) {
    const id = generatePuckId();
    if (seenIds.has(id)) continue;

    // Also check against existing DB records in case of a prior batch collision
    const idExists = await prisma.puck.findUnique({ where: { id } });
    if (idExists) continue;

    let claimCode = generateClaimCode();
    while (seenCodes.has(claimCode)) claimCode = generateClaimCode();

    seenIds.add(id);
    seenCodes.add(claimCode);

    batch.push({
      id,
      claimCode,
      nfcUrl: `${BASE_URL}/r/${id}`,
    });
  }

  return batch;
}

async function insertBatchIntoDb(batch) {
  await prisma.puck.createMany({
    data: batch.map((p) => ({
      id: p.id,
      claimCode: p.claimCode,
      status: 'UNCLAIMED',
    })),
  });
}

function exportNfcManifest(batch, outDir) {
  const csv = 'puck_id,nfc_url\n' + batch.map((p) => `${p.id},${p.nfcUrl}`).join('\n');
  fs.writeFileSync(path.join(outDir, 'nfc-manifest.csv'), csv);
}

function exportInsertCardData(batch, outDir) {
  const csv =
    'puck_id,claim_code\n' +
    batch.map((p) => `${p.id},${p.claimCode}`).join('\n');
  fs.writeFileSync(path.join(outDir, 'insert-card-data.csv'), csv);
}

async function main() {
  const count = parseInt(process.argv[2], 10);
  if (!count || count <= 0) {
    console.error('Usage: node generate-batch.js <count>');
    process.exit(1);
  }

  const outDir = path.join(__dirname, '..', 'output');
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`Generating ${count} unique puck IDs + claim codes...`);
  const batch = await generateBatch(count);

  console.log('Inserting into database as UNCLAIMED...');
  await insertBatchIntoDb(batch);

  console.log('Writing NFC manifest for supplier...');
  exportNfcManifest(batch, outDir);

  console.log('Writing insert card data...');
  exportInsertCardData(batch, outDir);

  console.log(`\nDone. ${batch.length} pucks generated and saved to the database.`);
  console.log(`Files written to: ${outDir}`);
  console.log('  - nfc-manifest.csv       (send to NFC supplier)');
  console.log('  - insert-card-data.csv   (send to print/packaging supplier)');

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
