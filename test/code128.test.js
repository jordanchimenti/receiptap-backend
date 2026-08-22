// Code 128 is hand-implemented (lib/code128.js, no dependency), so it gets
// checked against the spec rather than eyeballed: this decodes our own SVG
// geometry back into code values and verifies the start code, the data, the
// CHECKSUM and the stop. The checksum is the part a scanner rejects, and a
// wrong one looks identical to a right one on screen.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { toSvg, isEncodable } = require('../lib/code128');

const PATTERNS = fs.readFileSync(require.resolve('../lib/code128.js'), 'utf8')
  .match(/const PATTERNS = \[([\s\S]*?)\];/)[1]
  .match(/'(\d+)'/g).map((s) => s.replace(/'/g, ''));

function decode(value, moduleWidth = 2) {
  const svg = toSvg(value, { moduleWidth });
  const rects = [...svg.matchAll(/<rect x="(\d+)" y="0" width="(\d+)"/g)].map((m) => ({ x: +m[1], w: +m[2] }));
  const els = [];
  let cursor = 10 * moduleWidth; // quiet zone
  for (const r of rects) {
    if (r.x > cursor) els.push((r.x - cursor) / moduleWidth);
    els.push(r.w / moduleWidth);
    cursor = r.x + r.w;
  }
  const codes = [];
  for (let i = 0; i < els.length; ) {
    const len = els.length - i === 7 ? 7 : 6; // STOP is 7 elements
    codes.push(PATTERNS.indexOf(els.slice(i, i + len).join('')));
    i += len;
  }
  return codes;
}

function expected(value) {
  const codes = [104, ...[...value].map((c) => c.charCodeAt(0) - 32)]; // 104 = Start B
  let sum = 104;
  for (let i = 1; i < codes.length; i++) sum += codes[i] * i;
  return [...codes, sum % 103, 106]; // checksum, STOP
}

for (const value of ['A-1042', 'PREVIEW-0001', '12345', 'txn_abc_123', 'a', 'Z']) {
  test(`Code 128 encodes ${value} exactly to spec`, () => {
    const got = decode(value);
    assert.ok(!got.includes(-1), 'every chunk maps to a real pattern');
    assert.deepEqual(got, expected(value));
  });
}

test('refuses anything subset B cannot encode, rather than mangling it', () => {
  assert.equal(isEncodable('café'), false);
  assert.equal(toSvg('café'), null);
  assert.equal(toSvg(''), null);
  assert.equal(toSvg(null), null);
});

test('emits self-contained SVG with a quiet zone, not a raster image', () => {
  const svg = toSvg('A-1042');
  assert.match(svg, /^<svg /);
  assert.ok(!svg.includes('data:image'));
  assert.match(svg, /viewBox="0 0 \d+ \d+"/);
});
