// lib/csvCell.js
// Quote one CSV field so a value containing a comma, a quote or a newline
// can't break the row apart.
//
// The wallet export interpolated business names straight into the line, so a
// merchant called "Bob, Inc." shifted every later column by one for that row.
// In a tax export that isn't cosmetic: the total lands in the category column
// and the row reads as a different amount.
//
// RFC 4180: wrap in double quotes, and double any double-quote inside.
function csvCell(value) {
  const text = value == null ? '' : String(value);
  if (!/[",\r\n]/.test(text)) return text;
  return '"' + text.replace(/"/g, '""') + '"';
}

module.exports = { csvCell };
