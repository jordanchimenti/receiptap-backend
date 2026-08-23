-- Fields a scanned receipt needs to actually support a tax claim.
--   taxNumber2       second registration number (Canadian receipts print
--                    GST/HST *and* QST/PST; one slot dropped the second)
--   buyerName        CRA requires the recipient be named for an input tax
--                    credit on purchases of $150 or more
--   purchaseTimeText time of day as printed; IRS 274(d) substantiation
--   businessPurpose  the taxpayer's own note -- never on the paper, and
--                    mandatory for US travel/meals/gifts/listed property
ALTER TABLE "ScannedReceipt" ADD COLUMN "taxNumber2" TEXT;
ALTER TABLE "ScannedReceipt" ADD COLUMN "buyerName" TEXT;
ALTER TABLE "ScannedReceipt" ADD COLUMN "purchaseTimeText" TEXT;
ALTER TABLE "ScannedReceipt" ADD COLUMN "businessPurpose" TEXT;
