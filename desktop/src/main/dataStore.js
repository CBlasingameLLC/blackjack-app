// ============================================================================
// dataStore.js - the ~/.blackjack-pro/ folder: where the data lives, who may
// write it, and what shape it is in.
//
// THE SINGLE-WRITER RULE. The app writes these files. The MCP server and every
// outside program only ever READ them. Nothing else in this project may open
// one of these paths for writing - that is what makes it safe to have no
// locking and no merge logic at all.
//
// WHY NOT app.getPath('userData'). Two reasons, one of them learned the hard
// way in the sibling project. (1) Outside programs need a stable, discoverable
// path that does not move when the packaging format changes, and %APPDATA%\
// <productName> is neither obvious nor stable. (2) Anything reading under
// AppData from inside an MSIX container - which is where Claude's own desktop
// app runs - is served a copy-on-write SNAPSHOT rather than the real file, so
// an MCP server reading it would silently report stale or empty data while the
// app's own window showed the truth. ~/.blackjack-pro is outside that scope.
//
// BJ_DATA_DIR overrides the location, and tests MUST set it. Pointing a test
// at the real folder is how you end up debugging a stale snapshot of your own
// training history.
//
// TWO FILES, ON PURPOSE:
//   store.json     the raw key/value store, verbatim as the renderer holds it.
//                  This is the DURABLE copy and the restore source - Electron's
//                  localStorage lives in the app profile and does not survive a
//                  reinstall, so without this a reinstall would cost the player
//                  every stat they have.
//   snapshot.json  everything derived - level, rank, ladder, accuracy by mode,
//                  trends, achievements, mistakes. This is the file outside
//                  programs are meant to read. It is computed in the RENDERER
//                  by the same gamification.js the UI renders from, never
//                  recomputed here, so the numbers a script reads can never
//                  drift from the numbers on screen.
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeAtomic, recoverFrom } from './atomicWrite.js';

export const SCHEMA_VERSION = 1;

export function resolveDataDir() {
    const override = process.env.BJ_DATA_DIR;
    if (override && override.trim()) return path.resolve(override.trim());
    return path.join(os.homedir(), '.blackjack-pro');
}

export const files = () => {
    const dir = resolveDataDir();
    return {
        dir,
        store: path.join(dir, 'store.json'),
        snapshot: path.join(dir, 'snapshot.json')
    };
};

function readJSON(file, fallback) {
    try {
        const raw = fs.readFileSync(file, 'utf8');
        const parsed = JSON.parse(raw);
        return (parsed === null || parsed === undefined) ? fallback : parsed;
    } catch {
        return fallback;
    }
}

/** Promotes any orphaned temp files left by a write that could not rename. */
export function recoverPending() {
    const f = files();
    return {
        store: recoverFrom(f.store),
        snapshot: recoverFrom(f.snapshot)
    };
}

/**
 * The raw kv store, or null when nothing has ever been written. Null and {}
 * are deliberately different answers: null means "no mirror exists, this is a
 * fresh machine", {} means "the mirror exists and the player genuinely has no
 * data yet". Restoring on the second would be a no-op; confusing them would
 * make a first launch look like a wiped profile.
 */
export function readStore() {
    const doc = readJSON(files().store, null);
    if (!doc || typeof doc !== 'object') return null;
    const kv = doc.kv;
    return (kv && typeof kv === 'object') ? kv : null;
}

export function readSnapshot() {
    return readJSON(files().snapshot, null);
}

/**
 * @param {Object} kv  every junto_blackjack_* key, values already serialized
 *                     exactly as localStorage holds them (strings).
 */
export function writeStore(kv, appVersion) {
    return writeAtomic(files().store, JSON.stringify({
        version: SCHEMA_VERSION,
        app: appVersion || null,
        writtenAt: new Date().toISOString(),
        kv: kv || {}
    }, null, 2));
}

export function writeSnapshot(snapshot, appVersion) {
    return writeAtomic(files().snapshot, JSON.stringify({
        version: SCHEMA_VERSION,
        app: appVersion || null,
        writtenAt: new Date().toISOString(),
        ...snapshot
    }, null, 2));
}
