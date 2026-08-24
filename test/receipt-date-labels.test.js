// The wallet printed the same full date twice -- as the group heading and
// again under the merchant name. Grouping by month makes the heading say
// something the row doesn't.
//
// The part worth pinning is the timezone basis. A scanned receipt's
// purchaseDate is a calendar date stored as UTC midnight; formatted in local
// time from a negative-offset zone it moves back a day, and on the 1st of a
// month it moves into the PREVIOUS month -- putting a receipt under a heading
// its own date contradicts.

const { test } = require('node:test');
const assert = require('node:assert');
const { receiptDateLabels } = require('../lib/receiptDateLabels');

test('a real instant gets month, day and time', () => {
  const l = receiptDateLabels(new Date('2026-08-09T18:34:00Z'));
  assert.strictEqual(l.month, 'August 2026');
  assert.ok(/^Aug \d+, 2026$/.test(l.day), l.day);
  assert.ok(/\d:\d\d\s?(AM|PM)/.test(l.time), l.time);
});

test('a calendar date keeps its own day and month, whatever the local offset', () => {
  // UTC midnight on the 1st: the case that rolls back a month if formatted
  // locally west of Greenwich.
  const l = receiptDateLabels(new Date('2026-08-01T00:00:00Z'), { utc: true });
  assert.strictEqual(l.month, 'August 2026');
  assert.strictEqual(l.day, 'Aug 1, 2026');
});

test('the month and the day never disagree', () => {
  // Every month boundary, both bases. The heading is derived from the same
  // instant as the row, so they must always name the same month.
  for (let m = 0; m < 12; m++) {
    for (const utc of [true, false]) {
      const d = new Date(Date.UTC(2026, m, 1, 0, 0, 0));
      const l = receiptDateLabels(d, { utc });
      const monthName = l.month.split(' ')[0];
      assert.ok(
        l.day.startsWith(monthName.slice(0, 3)),
        `heading ${l.month} disagrees with row ${l.day} (utc=${utc})`
      );
    }
  }
});

test('a calendar-date receipt shows no invented time', () => {
  // Its stored time is UTC midnight -- an artefact of how it was saved, not
  // something that happened. "12:00 AM" would be a fabrication.
  assert.strictEqual(receiptDateLabels(new Date('2026-07-27T00:00:00Z'), { utc: true }).time, null);
});

test('a time printed on the paper is used as-is', () => {
  const l = receiptDateLabels(new Date('2026-07-27T00:00:00Z'), {
    utc: true,
    printedTime: '2:15 PM',
  });
  assert.strictEqual(l.time, '2:15 PM');
});

test('a blank or whitespace printed time is treated as absent', () => {
  for (const t of ['', '   ', null, undefined]) {
    assert.strictEqual(
      receiptDateLabels(new Date('2026-07-27T00:00:00Z'), { utc: true, printedTime: t }).time,
      null
    );
  }
});

test('a missing or invalid date yields empty labels rather than throwing', () => {
  for (const bad of [null, undefined, new Date('nonsense'), 'yesterday']) {
    const l = receiptDateLabels(bad);
    assert.deepStrictEqual(l, { month: '', day: '', time: null });
  }
});
