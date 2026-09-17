// ============================================================================
// verify-icon.js - the Windows icon actually is one.
//
// A hand-rolled ICO fails in exactly one way: it looks like a file. Explorer
// shows a blank page, the taskbar shows the Electron default, and nothing
// anywhere reports an error - the format has no checksum, so a wrong offset
// or a truncated blob is indistinguishable from a working icon until a human
// looks at a taskbar. So this reads the bytes back and walks the directory
// the way Windows does: every declared offset must land on a real PNG of the
// declared length, inside the file.
//
// It also checks the icon is WIRED, not merely present. An icon.ico nobody
// points at is the same blank taskbar with a tidier build folder.
//
// Run: node scripts/verify-icon.js
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUILD_DIR = path.join(__dirname, '../build');
const ICO = path.join(BUILD_DIR, 'icon.ico');
const PNG = path.join(BUILD_DIR, 'icon.png');

const EXPECTED_SIZES = [16, 24, 32, 48, 64, 128, 256];
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let failures = 0;
const ok = (m) => console.log('  OK   ' + m);
const fail = (m) => { console.log('  FAIL ' + m); failures++; };
const eq = (a, b, m) => (a === b ? ok(`${m} (${JSON.stringify(a)})`) : fail(`${m} — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`));

console.log('-- the icon file exists --');
if (!fs.existsSync(ICO)) {
    fail('build/icon.ico is missing — run: npx electron scripts/make-icon.js');
    console.log('\n1 FAILURE(S)');
    process.exit(1);
}
ok('build/icon.ico is present');
eq(fs.existsSync(PNG), true, 'build/icon.png is present');

const buf = fs.readFileSync(ICO);

console.log('\n-- the header is an ICONDIR --');
eq(buf.readUInt16LE(0), 0, 'reserved field is zero');
eq(buf.readUInt16LE(2), 1, 'type is 1 (icon, not cursor)');
const count = buf.readUInt16LE(4);
eq(count, EXPECTED_SIZES.length, 'the directory declares every size');

console.log('\n-- every directory entry lands on a real PNG --');
// This is the check that can actually fail for the real reason: an off-by-one
// in the offset arithmetic produces a file of exactly the right length whose
// entries point into the middle of the previous image.
const seen = [];
for (let i = 0; i < count; i++) {
    const at = 6 + i * 16;
    const wByte = buf.readUInt8(at + 0);
    const hByte = buf.readUInt8(at + 1);
    const bytes = buf.readUInt32LE(at + 8);
    const offset = buf.readUInt32LE(at + 12);
    // 0 means 256 — the field is one byte wide and 256 does not fit in it.
    const size = wByte === 0 ? 256 : wByte;
    seen.push(size);

    if (wByte !== hByte) { fail(`entry ${i} is not square (${wByte}x${hByte})`); continue; }
    if (offset + bytes > buf.length) {
        fail(`entry ${i} (${size}px) runs past the end of the file — offset ${offset} + ${bytes} > ${buf.length}`);
        continue;
    }
    const blob = buf.subarray(offset, offset + bytes);
    if (!blob.subarray(0, 8).equals(PNG_MAGIC)) {
        fail(`entry ${i} (${size}px) does not point at a PNG`);
        continue;
    }
    // The PNG's own IHDR carries the true dimensions. If they disagree with
    // the directory, Windows picks the wrong image for the context and the
    // taskbar quietly shows a blurry upscale.
    const realW = blob.readUInt32BE(16);
    const realH = blob.readUInt32BE(20);
    if (realW !== size || realH !== size) {
        fail(`entry ${i} declares ${size}px but the PNG is ${realW}x${realH}`);
        continue;
    }
    ok(`entry ${i}: ${size}x${size}, ${bytes} bytes, PNG verified against its own IHDR`);
}

eq(seen.join(','), EXPECTED_SIZES.join(','), 'the sizes present are the ones Windows asks for');

console.log('\n-- the icon is WIRED, not just present --');
const builder = fs.readFileSync(path.join(__dirname, '../electron-builder.yml'), 'utf8');
// buildResources defaults to `build/`, and electron-builder finds icon.ico
// there by convention — but naming it is what makes the dependency legible
// and what stops a buildResources move from silently dropping the icon.
eq(/icon:\s*build\/icon\.ico/.test(builder), true, 'electron-builder.yml names the icon explicitly');
eq(/installerIcon:\s*build\/icon\.ico/.test(builder), true, 'the NSIS installer uses it too');

const main = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
// Packaged builds take the icon from the executable's own resources, but a
// dev run does not — without this the taskbar shows the Electron logo every
// time anybody runs `npm start`, which is most of the time anybody sees it.
eq(/icon:\s*WINDOW_ICON/.test(main), true, 'the BrowserWindow sets an icon for dev runs');

console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
