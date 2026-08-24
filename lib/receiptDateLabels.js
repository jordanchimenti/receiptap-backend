// lib/receiptDateLabels.js
//
// The three labels a receipt row needs: the month it groups under, its own
// day, and the time of day when that's actually known.
//
// The wallet used to print the same full date twice -- once as the group
// heading, once under the merchant name. Grouping by month instead makes the
// heading say something the row doesn't.
//
// The subtlety is the timezone basis, and it has to be the SAME for the month
// and the day or a receipt lands under a heading its own date contradicts:
//
//   a tapped receipt   createdAt is a real instant -> local time
//   a scanned receipt  purchaseDate came from <input type="date"> and is
//                      stored as UTC midnight with no time-of-day meaning ->
//                      formatted in UTC, or a negative local offset rolls it
//                      back to the previous day (and, on the 1st, into the
//                      previous MONTH, which is what makes this worth a test)
//
// Time is only ever shown when it's real: a calendar-date-only receipt has no
// time to show, unless the photo itself printed one (ScannedReceipt.
// purchaseTimeText), which is what the paper actually said.

/**
 * @param {Date}    date         the instant or calendar date to label
 * @param {object}  opts
 * @param {boolean} opts.utc     format in UTC (a calendar date) vs local (an instant)
 * @param {string}  [opts.printedTime] time read off the receipt, used verbatim
 * @returns {{month: string, day: string, time: string|null}}
 */
function receiptDateLabels(date, { utc = false, printedTime = null } = {}) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return { month: '', day: '', time: null };
  }

  const zone = utc ? { timeZone: 'UTC' } : {};

  return {
    month: date.toLocaleDateString('en-US', { month: 'long', year: 'numeric', ...zone }),
    day: date.toLocaleDateString('en-US', { dateStyle: 'medium', ...zone }),
    // A UTC-midnight calendar date has no time worth printing -- "12:00 AM"
    // would be an artefact of how it's stored, not something that happened.
    time: utc
      ? (printedTime || '').trim() || null
      : date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
  };
}

module.exports = { receiptDateLabels };
