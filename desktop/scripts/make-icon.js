// ============================================================================
// make-icon.js - generates the Windows application icon.
//
//   npx electron scripts/make-icon.js
//
// WHY ELECTRON AND NOT A LIBRARY. The mark is an SVG, and turning an SVG into
// a PNG needs a rasteriser. Electron already carries the best one there is,
// so this adds no dependency at all: an offscreen BrowserWindow loads the
// mark and capturePage() hands back the pixels.
//
// EVERY SIZE IS RENDERED NATIVELY, not downscaled from one big bitmap. A 9px
// accent bar resampled down to 16x16 is a grey smear; the same bar drawn by
// the rasteriser at 16x16 is a crisp line. It also lets the mark HINT itself
// - below 32px the bar and the hairline are dropped entirely and the spade
// grows, because at 16px a taskbar icon is a silhouette and nothing else.
//
// THE ICO IS ASSEMBLED HERE rather than handed to a converter. The format is
// a 6-byte header, a 16-byte directory entry per image and then the image
// blobs; Vista and later accept PNG-compressed entries at every size. It is
// ~40 lines, it is deterministic, and verify-icon.js reads the result back
// and checks each declared offset actually lands on a PNG.
// ============================================================================

import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUILD_DIR = path.join(__dirname, '../build');
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bjicon-'));

// Windows reads these out of one file and picks per context: 16 in the title
// bar, 32 in the taskbar and alt-tab, 48 in Explorer's medium view, 256 in
// the large views and the installer.
const SIZES = [16, 24, 32, 48, 64, 128, 256];

// ---------------------------------------------------------------- the mark
//
// Graphite tile, ivory spade, jade rule. Jade rather than the mobile app's
// gold is the whole point: the desktop build reserves gold for MONEY and
// gives instrumentation its own colour, and the icon is the first place a
// player meets that distinction.

const GRAPHITE_HI = '#1b242a';
const GRAPHITE_LO = '#080b0d';
const IVORY = '#f2efe6';
const JADE = '#5fe3c0';
const GOLD = '#e3c16f';

const SPADE = [
    'M 50 9',
    'C 50 9, 14 38, 14 58',
    'C 14 71, 23 80, 34 80',
    'C 41 80, 47 77, 50 72',
    'C 53 77, 59 80, 66 80',
    'C 77 80, 86 71, 86 58',
    'C 86 38, 50 9, 50 9',
    'Z',
    'M 43 79',
    'C 45 87, 42 91, 34 95',
    'L 66 95',
    'C 58 91, 55 87, 57 79',
    'Z'
].join(' ');

/**
 * The mark at a given pixel size. `size` is not just a viewport - below 32px
 * the detail is deliberately stripped, because a bar that renders at half a
 * pixel is not a smaller bar, it is a grey blur across the silhouette.
 */
function markSVG(size) {
    const detailed = size >= 32;
    const radius = size >= 64 ? 21 : 18;          // % of the tile, kept optical
    const spadeScale = detailed ? 0.60 : 0.74;    // small sizes give it the room
    const spadeY = detailed ? 20 : 13;

    const tile = `
        <defs>
            <linearGradient id="field" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="${GRAPHITE_HI}"/>
                <stop offset="100%" stop-color="${GRAPHITE_LO}"/>
            </linearGradient>
            <radialGradient id="glow" cx="50%" cy="26%" r="72%">
                <stop offset="0%" stop-color="${JADE}" stop-opacity="0.16"/>
                <stop offset="100%" stop-color="${JADE}" stop-opacity="0"/>
            </radialGradient>
        </defs>
        <rect x="0" y="0" width="100" height="100" rx="${radius}" ry="${radius}" fill="url(#field)"/>
        <rect x="0" y="0" width="100" height="100" rx="${radius}" ry="${radius}" fill="url(#glow)"/>`;

    const hairline = detailed
        ? `<rect x="1.6" y="1.6" width="96.8" height="96.8" rx="${radius - 1.4}" ry="${radius - 1.4}"
                 fill="none" stroke="${JADE}" stroke-opacity="0.22" stroke-width="1.4"/>`
        : '';

    // The rule: jade for the instrument, a short gold segment for the money.
    // At 16px neither survives and both are omitted above - by design.
    const rule = detailed
        ? `<rect x="27" y="85.5" width="46" height="6.5" rx="3.25" fill="${JADE}"/>
           <rect x="27" y="85.5" width="17" height="6.5" rx="3.25" fill="${GOLD}"/>`
        : '';

    const spade = `
        <g transform="translate(50 ${spadeY}) scale(${spadeScale}) translate(-50 0)">
            <path d="${SPADE}" fill="${IVORY}"/>
        </g>`;

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100">
        ${tile}${hairline}${spade}${rule}
    </svg>`;
}

/**
 * Rasterises one size through Chromium and returns the PNG bytes.
 *
 * THE WINDOW IS ALWAYS 256x256 AND THE CAPTURE IS CROPPED. Asking for a
 * 24x24 window does not give you one: Windows enforces a minimum window
 * size, so the request is silently clamped and the load then fails outright
 * (ERR_FAILED), which reads like a bad URL rather than a bad size. Drawing
 * the mark at its true size in the corner of a normal window and cropping to
 * it keeps the native rasterisation - the SVG is still laid out at 24px, so
 * the hinting above is still what decides the pixels.
 */
async function renderPNG(win, size) {
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
        html,body{margin:0;padding:0;background:transparent;overflow:hidden}
        #m{position:fixed;top:0;left:0;width:${size}px;height:${size}px}
        svg{display:block}
    </style></head><body><div id="m">${markSVG(size)}</div></body></html>`;

    const file = path.join(TMP_DIR, `mark-${size}.html`);
    fs.writeFileSync(file, html, 'utf8');

    const painted = new Promise((resolve) => win.webContents.once('paint', resolve));
    await win.loadFile(file);
    // Offscreen rendering paints asynchronously; capturing before the first
    // frame lands gives a fully transparent image that looks like a broken
    // mark rather than a race.
    await painted;

    const image = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
    return image.toPNG();
}

/**
 * ICONDIR + one ICONDIRENTRY per image + the PNG blobs.
 * A width/height byte of 0 means 256 - the field is one byte and 256 does
 * not fit in it, which is the format's one genuine trap.
 */
function buildICO(images) {
    const header = Buffer.alloc(6);
    header.writeUInt16LE(0, 0);               // reserved
    header.writeUInt16LE(1, 2);               // type: 1 = icon
    header.writeUInt16LE(images.length, 4);

    const dir = Buffer.alloc(16 * images.length);
    let offset = header.length + dir.length;

    images.forEach((img, i) => {
        const at = i * 16;
        dir.writeUInt8(img.size >= 256 ? 0 : img.size, at + 0);
        dir.writeUInt8(img.size >= 256 ? 0 : img.size, at + 1);
        dir.writeUInt8(0, at + 2);            // palette size (0 = no palette)
        dir.writeUInt8(0, at + 3);            // reserved
        dir.writeUInt16LE(1, at + 4);         // colour planes
        dir.writeUInt16LE(32, at + 6);        // bits per pixel
        dir.writeUInt32LE(img.png.length, at + 8);
        dir.writeUInt32LE(offset, at + 12);
        offset += img.png.length;
    });

    return Buffer.concat([header, dir, ...images.map((i) => i.png)]);
}

app.whenReady().then(async () => {
    fs.mkdirSync(BUILD_DIR, { recursive: true });

    const win = new BrowserWindow({
        width: 256,
        height: 256,
        show: false,
        frame: false,
        transparent: true,
        backgroundColor: '#00000000',
        webPreferences: { offscreen: true, sandbox: true, contextIsolation: true }
    });

    const images = [];
    for (const size of SIZES) {
        images.push({ size, png: await renderPNG(win, size) });
        console.log(`  rendered ${size}x${size}`);
    }
    win.destroy();

    const ico = path.join(BUILD_DIR, 'icon.ico');
    fs.writeFileSync(ico, buildICO(images));
    console.log(`  wrote ${ico} (${fs.statSync(ico).size} bytes, ${images.length} sizes)`);

    // electron-builder wants the .ico; the BrowserWindow in dev and the
    // installer's sidebar art are happier with a plain PNG.
    const png = path.join(BUILD_DIR, 'icon.png');
    fs.writeFileSync(png, images[images.length - 1].png);
    console.log(`  wrote ${png} (256x256)`);

    try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* the OS will get it */ }
    app.exit(0);
}).catch((err) => {
    console.error('  FAILED: ' + (err && err.message ? err.message : String(err)));
    app.exit(1);
});
