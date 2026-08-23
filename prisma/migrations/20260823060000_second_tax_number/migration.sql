-- A second tax registration number on issued receipts, plus a label for each.
-- Canadian merchants in Quebec (GST/HST + QST) and BC/SK/MB (GST + PST) are
-- registered for two taxes and must show both; one field meant their customers
-- could never recover the provincial half. The label was hardcoded "GST/HST"
-- in every layout, which is wrong outside most of Canada.
ALTER TABLE "ReceiptTheme" ADD COLUMN "taxNumberLabel" TEXT;
ALTER TABLE "ReceiptTheme" ADD COLUMN "taxNumber2" TEXT;
ALTER TABLE "ReceiptTheme" ADD COLUMN "taxNumber2Label" TEXT;
