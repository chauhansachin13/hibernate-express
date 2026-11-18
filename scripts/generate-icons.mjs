/**
 * Renders the app icons and the link-preview image (og-image.png) from SVG.
 * Run with `npm run icons`; the outputs are committed, so this is only needed
 * when the artwork changes.
 */
import { Resvg } from '@resvg/resvg-js';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = (p) => join(root, 'public', p);
mkdirSync(out('icons'), { recursive: true });

const DEFS = `<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#13243b"/><stop offset="1" stop-color="#070f1c"/></linearGradient>
  <linearGradient id="fur" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5eead4"/><stop offset="1" stop-color="#14b8a6"/></linearGradient>
</defs>`;

const BEAR = `
  <circle cx="19" cy="25" r="7.5" fill="url(#fur)"/><circle cx="45" cy="25" r="7.5" fill="url(#fur)"/>
  <circle cx="19" cy="25" r="3.6" fill="#0f766e"/><circle cx="45" cy="25" r="3.6" fill="#0f766e"/>
  <ellipse cx="32" cy="39" rx="18" ry="16.5" fill="url(#fur)"/>
  <path d="M22.5 36.5q3 3 6 0M35.5 36.5q3 3 6 0" fill="none" stroke="#063b36" stroke-width="2.4" stroke-linecap="round"/>
  <ellipse cx="32" cy="45" rx="7.5" ry="5.8" fill="#ccfbf1"/>
  <ellipse cx="32" cy="42.6" rx="2.9" ry="2.1" fill="#063b36"/>
  <path d="M46 7h6l-6 6.5h6" fill="none" stroke="#fde68a" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M54.5 15h4l-4 4.4h4" fill="none" stroke="#fde68a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;

const LOGO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${DEFS}
  <rect width="64" height="64" rx="16" fill="url(#bg)"/>
  <rect x="1" y="1" width="62" height="62" rx="15" fill="none" stroke="#2dd4bf" stroke-opacity=".5" stroke-width="2"/>${BEAR}
</svg>`;

/** Full-bleed square (maskable / Apple) with the bear scaled into the safe zone. */
const square = (scale) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${DEFS}
  <rect width="64" height="64" fill="url(#bg)"/>
  <g transform="translate(32 33) scale(${scale}) translate(-32 -33)">${BEAR}</g>
</svg>`;

/** Android status-bar badge: white silhouette on transparent. */
const BADGE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <mask id="m"><rect width="64" height="64" fill="#fff"/>
    <path d="M22.5 36.5q3 3 6 0M35.5 36.5q3 3 6 0" fill="none" stroke="#000" stroke-width="3" stroke-linecap="round"/>
    <ellipse cx="32" cy="43" rx="3.4" ry="2.6" fill="#000"/></mask>
  <g fill="#fff" mask="url(#m)"><circle cx="19" cy="25" r="7.5"/><circle cx="45" cy="25" r="7.5"/><ellipse cx="32" cy="39" rx="18" ry="16.5"/></g>
</svg>`;

/** WOFF 1.0 -> TrueType, so resvg can use the app's own Barlow Condensed font. */
function woffToTtf(buf) {
  if (buf.readUInt32BE(0) !== 0x774f4646) throw new Error('Not a WOFF file');
  const flavor = buf.readUInt32BE(4);
  const count = buf.readUInt16BE(12);
  const tables = [];
  for (let i = 0; i < count; i++) {
    const o = 44 + i * 20;
    const t = {
      tag: buf.readUInt32BE(o),
      offset: buf.readUInt32BE(o + 4),
      compLength: buf.readUInt32BE(o + 8),
      origLength: buf.readUInt32BE(o + 12),
      checksum: buf.readUInt32BE(o + 16),
    };
    const raw = buf.subarray(t.offset, t.offset + t.compLength);
    t.data = t.compLength < t.origLength ? inflateSync(raw) : raw;
    tables.push(t);
  }
  const entrySelector = Math.floor(Math.log2(count));
  const searchRange = 2 ** entrySelector * 16;
  const headerSize = 12 + count * 16;
  const size = tables.reduce((s, t) => s + ((t.data.length + 3) & ~3), headerSize);
  const ttf = Buffer.alloc(size);
  ttf.writeUInt32BE(flavor, 0);
  ttf.writeUInt16BE(count, 4);
  ttf.writeUInt16BE(searchRange, 6);
  ttf.writeUInt16BE(entrySelector, 8);
  ttf.writeUInt16BE(count * 16 - searchRange, 10);
  let offset = headerSize;
  tables.forEach((t, i) => {
    const r = 12 + i * 16;
    ttf.writeUInt32BE(t.tag, r);
    ttf.writeUInt32BE(t.checksum, r + 4);
    ttf.writeUInt32BE(offset, r + 8);
    ttf.writeUInt32BE(t.data.length, r + 12);
    t.data.copy(ttf, offset);
    offset += (t.data.length + 3) & ~3;
  });
  return ttf;
}

const fontDir = join(root, 'node_modules', '.cache', 'hx-fonts');
mkdirSync(fontDir, { recursive: true });
const fontFiles = [600, 700, 800].map((w) => {
  const src = join(root, 'node_modules/@fontsource/barlow-condensed/files', `barlow-condensed-latin-${w}-normal.woff`);
  const dest = join(fontDir, `barlow-condensed-${w}.ttf`);
  writeFileSync(dest, woffToTtf(readFileSync(src)));
  return dest;
});

function png(svg, width, file, withFonts = false) {
  const opts = { fitTo: { mode: 'width', value: width } };
  if (withFonts) opts.font = { fontFiles, loadSystemFonts: false, defaultFontFamily: 'Barlow Condensed' };
  writeFileSync(out(file), new Resvg(svg, opts).render().asPng());
  console.log(`wrote public/${file}`);
}

const STARS = [
  [60, 40, 1.6], [180, 80, 1.2], [330, 34, 1.8], [470, 70, 1.2], [610, 28, 1.6], [740, 64, 1.3],
  [1060, 40, 1.7], [1150, 110, 1.2], [700, 590, 1.3], [980, 600, 1.5], [40, 600, 1.2], [560, 560, 1.1],
]
  .map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}" fill="#cbd5e1" opacity=".7"/>`)
  .join('');

const OG = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  ${DEFS}
  <defs>
    <radialGradient id="g1" cx="0.1" cy="0" r="0.75"><stop offset="0" stop-color="#2dd4bf" stop-opacity=".33"/><stop offset="1" stop-color="#2dd4bf" stop-opacity="0"/></radialGradient>
    <radialGradient id="g2" cx="0.95" cy="0.1" r="0.6"><stop offset="0" stop-color="#38bdf8" stop-opacity=".16"/><stop offset="1" stop-color="#38bdf8" stop-opacity="0"/></radialGradient>
    <linearGradient id="btn" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5eead4"/><stop offset="1" stop-color="#14b8a6"/></linearGradient>
  </defs>
  <rect width="1200" height="630" fill="#060b14"/>
  <rect width="1200" height="630" fill="url(#g1)"/>
  <rect width="1200" height="630" fill="url(#g2)"/>
  ${STARS}
  <g transform="translate(68 52) scale(1.3)">
    <rect width="64" height="64" rx="16" fill="url(#bg)"/>
    <rect x="1" y="1" width="62" height="62" rx="15" fill="none" stroke="#2dd4bf" stroke-opacity=".5" stroke-width="2"/>${BEAR}
  </g>
  <text x="172" y="120" font-family="Barlow Condensed" font-weight="800" font-size="56" fill="#e9eff8" letter-spacing="1">HIBERNATE <tspan fill="#2dd4bf">EXPRESS</tspan></text>
  <text x="72" y="208" font-family="Barlow Condensed" font-weight="800" font-size="27" fill="#2dd4bf" letter-spacing="6">NEVER MISS YOUR STOP</text>
  <text font-family="Barlow Condensed" font-weight="800" font-size="88" letter-spacing="1">
    <tspan x="68" y="294" fill="#e9eff8">SLEEP ON THE BUS,</tspan>
    <tspan x="68" y="380" fill="#2dd4bf">WE'LL WAKE YOU</tspan>
    <tspan x="68" y="466" fill="#2dd4bf">BEFORE YOUR STOP</tspan>
  </text>
  <text x="70" y="546" font-family="Barlow Condensed" font-weight="700" font-size="38" fill="#fde68a">“Even Kumbhakaran won’t miss his stop now”</text>
  <g transform="translate(812 104)">
    <rect width="320" height="440" rx="38" fill="#0d1726" stroke="#2dd4bf" stroke-opacity=".4" stroke-width="2"/>
    <text x="30" y="66" font-family="Barlow Condensed" font-weight="700" font-size="22" fill="#8193ab" letter-spacing="4">HEADING TO</text>
    <text x="30" y="106" font-family="Barlow Condensed" font-weight="800" font-size="40" fill="#e9eff8">NIT WARANGAL</text>
    <text x="28" y="222" font-family="Barlow Condensed" font-weight="800" font-size="124" fill="#e9eff8">2.0<tspan font-size="50" fill="#2dd4bf"> KM</tspan></text>
    <text x="30" y="262" font-family="Barlow Condensed" font-weight="600" font-size="25" fill="#8193ab">ROAD DISTANCE LEFT · ~5 MIN</text>
    <rect x="30" y="296" width="260" height="14" rx="7" fill="#192a42"/>
    <rect x="30" y="296" width="214" height="14" rx="7" fill="#2dd4bf"/>
    <circle cx="244" cy="303" r="15" fill="#fbbf24"/>
    <path d="M238.5 307.5h11M240 307c.8-.9 1.2-1.8 1.2-4.2a2.8 2.8 0 0 1 5.6 0c0 2.4.4 3.3 1.2 4.2M242.6 310a1.5 1.5 0 0 0 2.8 0" fill="none" stroke="#422006" stroke-width="1.8" stroke-linecap="round"/>
    <rect x="30" y="346" width="260" height="62" rx="20" fill="url(#btn)"/>
    <text x="160" y="388" text-anchor="middle" font-family="Barlow Condensed" font-weight="800" font-size="31" fill="#032824" letter-spacing="2">WAKE UP!</text>
  </g>
</svg>`;

writeFileSync(out('favicon.svg'), LOGO);
console.log('wrote public/favicon.svg');
png(LOGO, 192, 'icons/icon-192.png');
png(LOGO, 512, 'icons/icon-512.png');
png(square(0.78), 512, 'icons/maskable-512.png');
png(square(0.92), 180, 'icons/apple-touch-icon.png');
png(BADGE, 96, 'icons/badge-96.png');
png(OG, 1200, 'og-image.png', true);
