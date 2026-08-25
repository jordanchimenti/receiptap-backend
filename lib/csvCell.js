// lib/csvCell.js
// Quote one CSV field so a value containing a comma, a quote or a newline
// can't break the row apart.
//
// The wallet export interpolated business names straight into the line, so a
// merchant called "Bob, Inc." shifted every later column by one for that row.
// In a tax export that isn't cosmetic: the total lands in the category column
// and the row reads as a different amount.
//
// A cell starting with =, +, - or @ is also neutralized with a leading
// apostrophe -- the standard CSV-injection mitigation. Excel/Sheets treats
// such a cell as a live formula on open, not text, and this export's fields
// (business names, tax numbers, a customer's own business-purpose note) are
// exactly the kind of free text a merchant or a photographed receipt could
// put that leading character into, deliberately or not.
//
// RFC 4180: wrap in double quotes, and double any double-quote inside.
function csvCell(value) {
  const text = value == null ? '' : String(value);
  const safe = /^[=+\-@]/.test(text) ? "'" + text : text;
  if (!/[",\r\n]/.test(safe)) return safe;
  return '"' + safe.replace(/"/g, '""') + '"';
}

module.exports = { csvCell };
