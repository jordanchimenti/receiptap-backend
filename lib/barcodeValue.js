// lib/barcodeValue.js
// Resolves which string a receipt's barcode should encode, from the
// merchant's `barcodeValue` choice in Receipt design.
//
// Returns null when there's nothing to encode -- e.g. "Receipt number" is
// selected but this particular sale came through without an order number.
// Callers show an empty state rather than inventing an identifier, since a
// barcode that scans as the wrong value is worse than no barcode at all.
const BARCODE_VALUE_OPTIONS = ['receiptNumber', 'transactionId', 'bestAvailable', 'custom'];

function normalizeBarcodeValue(choice) {
  return BARCODE_VALUE_OPTIONS.includes(choice) ? choice : 'receiptNumber';
}

function resolveBarcodeValue(theme, transaction) {
  const choice = normalizeBarcodeValue(theme && theme.barcodeValue);
  const orderNumber = transaction && transaction.orderNumber;
  const txnId = transaction && transaction.id;

  switch (choice) {
    case 'transactionId':
      return txnId || null;
    // Whatever identifier this sale actually has, preferring the one a
    // customer would recognise off their receipt over the internal id.
    case 'bestAvailable':
      return orderNumber || txnId || null;
    case 'custom':
      return (theme && theme.barcodeCustomValue) ? String(theme.barcodeCustomValue).trim() || null : null;
    case 'receiptNumber':
    default:
      return orderNumber || null;
  }
}

module.exports = { resolveBarcodeValue, normalizeBarcodeValue, BARCODE_VALUE_OPTIONS };
