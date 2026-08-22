// lib/code128.js
// Renders a real, scanner-readable Code 128 (subset B) barcode as inline SVG.
//
// Inline SVG rather than a raster image on purpose: it stays crisp at any
// size, needs no image host or data-URI bloat, and survives the Playwright
// PDF export the same way the rest of the receipt markup does. Subset B
// covers printable ASCII 32-126, which is every receipt/order number a POS
// has ever handed us; anything outside that range is refused rather than
// silently mangled into a barcode that scans as the wrong value.
//
// No dependency: the 107-entry pattern table below IS the Code 128 spec.
// Each entry is six (seven for STOP) element widths in modules, alternating
// bar, space, bar, space... starting with a bar.

const PATTERNS = [
  '212222','222122','222221','121223','121322','131222','122213','122312','132212','221213',
  '221312','231212','112232','122132','122231','113222','123122','123221','223211','221132',
  '221231','213212','223112','312131','311222','321122','321221','312212','322112','322211',
  '212123','212321','232121','111323','131123','131321','112313','132113','132311','211313',
  '231113','231311','112133','112331','132131','113123','113321','133121','313121','211331',
  '231131','213113','213311','213131','311123','311321','331121','312113','312311','332111',
  '314111','221411','431111','111224','111422','121124','121421','141122','141221','112214',
  '112412','122114','122411','142112','142211','241211','221114','413111','241112','134111',
  '111242','121142','121241','114212','124112','124211','411212','421112','421211','212141',
  '214121','412121','111143','111341','131141','114113','114311','411113','411311','113141',
  '114131','311141','411131','211412','211214','211232','2331112',
];

const START_B = 104;
const STOP = 106;
const QUIET_MODULES = 10; // spec requires >= 10 modules of clear space each side

/** True if every character can be encoded in subset B. */
function isEncodable(value) {
  return typeof value === 'string' && value.length > 0 &&
    [...value].every((ch) => { const c = ch.charCodeAt(0); return c >= 32 && c <= 126; });
}

/**
 * Returns an <svg> string, or null when the value can't be encoded --
 * callers render their own empty state rather than an unscannable image.
 */
function toSvg(value, { moduleWidth = 2, height = 56 } = {}) {
  if (!isEncodable(value)) return null;

  const codes = [START_B, ...[...value].map((ch) => ch.charCodeAt(0) - 32)];
  // Checksum is the weighted sum of the data codes, start value included at
  // weight 1, each subsequent code weighted by its 1-based position.
  let checksum = START_B;
  for (let i = 1; i < codes.length; i++) checksum += codes[i] * i;
  codes.push(checksum % 103, STOP);

  let x = QUIET_MODULES;
  const bars = [];
  for (const code of codes) {
    let isBar = true; // every pattern starts with a bar
    for (const widthChar of PATTERNS[code]) {
      const w = Number(widthChar);
      if (isBar) bars.push(`<rect x="${x * moduleWidth}" y="0" width="${w * moduleWidth}" height="${height}" fill="#111"/>`);
      x += w;
      isBar = !isBar;
    }
  }
  const totalWidth = (x + QUIET_MODULES) * moduleWidth;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalWidth} ${height}" ` +
    `width="100%" height="${height}" preserveAspectRatio="xMidYMid meet" role="img" ` +
    `aria-label="Barcode ${value.replace(/[<>&"]/g, '')}">` +
    `<rect width="${totalWidth}" height="${height}" fill="#fff"/>${bars.join('')}</svg>`;
}

module.exports = { toSvg, isEncodable };
