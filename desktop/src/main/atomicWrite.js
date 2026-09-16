// ============================================================================
// atomicWrite.js - temp file + rename, with a retry ladder, because on Windows
// the rename fails for reasons that have nothing to do with us.
//
// MoveFileExW needs DELETE access on the destination, and Defender's on-access
// scanner, the Search indexer and every sync client open files for a few
// milliseconds without FILE_SHARE_DELETE. The result is
//   EPERM: operation not permitted, rename store.json.<pid>.tmp -> store.json
// on a perfectly healthy volume. A single unretried attempt turns a transient
// hold into "your session was not saved". The backoff starts at 0 so a healthy
// write pays nothing, and the rest outlast a scanner.
//
// This is deliberately SIMPLER than the equivalent in Dial, and the difference
// is a property of the data rather than of the code: every file written here
// is a MIRROR of live state the renderer still holds. A failed write loses
// nothing - the next flush rewrites it from the same source - so there is no
// need for the degraded in-place fallback that exists where the temp file is
// the only copy. Failures are reported honestly instead of being papered over.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';

const BACKOFF_MS = [0, 15, 40, 90, 180, 350];

function sleep(ms) {
    if (ms <= 0) return;
    // Synchronous on purpose: this runs on the 'before-quit' flush path too,
    // where there is no event loop left to await a timer on.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Writes `text` to `file` atomically. Returns { ok, attempts, error }.
 * Never throws - a persistence failure must not take the app down with it.
 */
export function writeAtomic(file, text) {
    const dir = path.dirname(file);
    const tmp = `${file}.${process.pid}.tmp`;
    try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(tmp, text, 'utf8');
    } catch (err) {
        return { ok: false, attempts: 0, error: err };
    }

    let lastErr = null;
    for (let i = 0; i < BACKOFF_MS.length; i++) {
        sleep(BACKOFF_MS[i]);
        try {
            fs.renameSync(tmp, file);
            return { ok: true, attempts: i + 1, error: null };
        } catch (err) {
            lastErr = err;
        }
    }

    // Leave the temp file on disk rather than deleting it: it is a complete,
    // valid copy of what we were trying to persist, and recoverFrom() below
    // picks it up next launch if the destination never became writable.
    return { ok: false, attempts: BACKOFF_MS.length, error: lastErr };
}

/**
 * Promotes a leftover temp file (a write that completed but could never be
 * renamed) into place. Called at launch, before anything reads the file.
 */
export function recoverFrom(file) {
    let dir, base;
    try {
        dir = path.dirname(file);
        base = path.basename(file);
        if (!fs.existsSync(dir)) return false;
    } catch { return false; }

    let candidates = [];
    try {
        candidates = fs.readdirSync(dir)
            .filter((n) => n.startsWith(base + '.') && n.endsWith('.tmp'))
            .map((n) => path.join(dir, n));
    } catch { return false; }
    if (!candidates.length) return false;

    // Newest wins - an older orphan is a strictly staler copy of the same file.
    candidates.sort((a, b) => {
        try { return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs; } catch { return 0; }
    });

    try {
        fs.renameSync(candidates[0], file);
        candidates.slice(1).forEach((c) => { try { fs.unlinkSync(c); } catch { /* ignore */ } });
        return true;
    } catch {
        return false;
    }
}
