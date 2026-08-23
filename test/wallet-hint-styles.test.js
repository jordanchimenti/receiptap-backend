// A `class="hint"` in views/business-settings.ejs was defined nowhere -- not
// in the file, not in partials/wallet-dark-theme.ejs -- so it fell back to
// default body text (white, full size) while every neighbouring hint was
// small and grey. The next element's `.field-hint { margin-top: -8px }` then
// pulled its text up into the oversized paragraph, and the two overlapped.
//
// Hint classes are the ones that go wrong this way: they carry no layout of
// their own, so an undefined one still renders, just at the wrong size --
// it looks like a content bug rather than a missing style.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const VIEWS_DIR = path.join(__dirname, '..', 'views');
const SHARED_THEME = path.join(VIEWS_DIR, 'partials', 'wallet-dark-theme.ejs');

function definedClasses(css) {
  const found = new Set();
  const rule = /\.([a-zA-Z][\w-]*)\s*(?=[{,:.\s])/g;
  let m;
  while ((m = rule.exec(css)) !== null) found.add(m[1]);
  return found;
}

test('every hint class a wallet page uses is actually styled', () => {
  const shared = definedClasses(fs.readFileSync(SHARED_THEME, 'utf8'));
  const offenders = [];

  const views = fs
    .readdirSync(VIEWS_DIR)
    .filter((f) => f.startsWith('business-') && f.endsWith('.ejs'));

  for (const file of views) {
    const src = fs.readFileSync(path.join(VIEWS_DIR, file), 'utf8');
    const local = definedClasses(src);

    const used = /class="([^"<>]*)"/g;
    let m;
    while ((m = used.exec(src)) !== null) {
      for (const cls of m[1].split(/\s+/).filter(Boolean)) {
        if (!/hint$/.test(cls)) continue; // hint-family only
        if (local.has(cls) || shared.has(cls)) continue;
        const line = src.slice(0, m.index).split('\n').length;
        offenders.push(`${file}:${line} -> class="${cls}" is never defined`);
      }
    }
  }

  assert.deepStrictEqual(offenders, [], 'undefined hint classes:\n  ' + offenders.join('\n  '));
});

test('the detector actually catches an undefined hint class', () => {
  // Guards the test above from silently passing because the regex stopped
  // matching anything -- the failure mode that makes a green suite worthless.
  const css = definedClasses('.field-hint { color: red; } .banner.success { }');
  assert.ok(css.has('field-hint'));
  assert.ok(css.has('banner'));
  assert.ok(!css.has('hint'));
});
