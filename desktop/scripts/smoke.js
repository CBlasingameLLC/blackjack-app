// ============================================================================
// smoke.js - boots the REAL Electron shell against a scratch data dir and
// asserts against the live renderer over IPC. Run BY electron, not node:
//   npx electron scripts/smoke.js
//
// It imports main.js rather than reimplementing the boot, so what it proves is
// the shipping path: the protocol registration, the preload, the window, the
// mirror write. A smoke test that stands up its own window proves only that
// the test can make a window.
// ============================================================================

import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// MUST be set before main.js resolves the data dir. Pointing this at the real
// folder would have the test overwrite actual training history.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bjsmoke-'));
process.env.BJ_DATA_DIR = scratch;

// BJ_DATA_DIR alone is NOT enough isolation, and assuming it was is how three
// runs of this file quietly accumulated into each other (5 decisions, then 10,
// then 15). The engine's live store is localStorage, which lives in Electron's
// userData profile — a completely separate location this variable does not
// reach. Left alone, every smoke run would deposit fabricated hands into the
// same profile the real app uses, i.e. into actual training history. Both
// locations have to be scratch, and this must happen before main.js is
// imported, because app paths are fixed by the time the app is ready.
// The directory has to exist first — setPath refuses a path that is not there.
const profileDir = path.join(scratch, 'profile');
fs.mkdirSync(profileDir, { recursive: true });
app.setPath('userData', profileDir);
console.log('smoke: data=' + scratch);

await import('../src/main/main.js');

let failures = 0;
const ok = (m) => console.log('  OK   ' + m);
const fail = (m) => { console.log('  FAIL ' + m); failures++; };
const eq = (a, b, m) => (a === b ? ok(`${m} (${JSON.stringify(a)})`) : fail(`${m} — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const failedRequests = [];

app.whenReady().then(async () => {
    const { session } = await import('electron');
    session.defaultSession.webRequest.onErrorOccurred((details) => {
        failedRequests.push({ url: details.url, error: details.error });
    });
    await wait(500);
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) { console.log('  FAIL no window was created'); app.exit(1); return; }

    if (win.webContents.isLoading()) {
        await new Promise((r) => win.webContents.once('did-finish-load', r));
    }
    await wait(1500); // let the deferred engine scripts run and the first mirror flush land

    console.log('-- the shell boots the shared engine --');
    const page = await win.webContents.executeJavaScript(`(function () {
        return {
            title: document.title,
            protocol: location.protocol,
            hasEngine: !!(window.BJ && window.BJ.GameManager && window.BJ.StrategyEngine),
            hasInstance: !!(window.BJ && window.BJ.instance && window.BJ.instance.gameManager),
            hasBridge: !!(window.bjDesktop && window.bjDesktop.isDesktop),
            syncActive: !!(window.BJ && window.BJ.DesktopSync && window.BJ.DesktopSync.isActive()),
            localStorageWorks: (function () { try { localStorage.setItem('__probe','1'); const v = localStorage.getItem('__probe'); localStorage.removeItem('__probe'); return v === '1'; } catch (e) { return false; } })(),
            errors: (window.__smokeErrors || []).length
        };
    })()`);

    eq(page.protocol, 'app:', 'renderer is served over the app:// protocol, not file://');
    eq(page.hasEngine, true, 'the SHARED engine modules loaded (absolute /js/ paths resolved)');
    eq(page.hasInstance, true, 'boot.js constructed a live GameManager');
    eq(page.hasBridge, true, 'the preload bridge reached the page');
    eq(page.syncActive, true, 'desktop-sync woke up (it is inert without the bridge)');
    // The whole engine stores every stat here; an unprivileged scheme would
    // give an app that runs perfectly and forgets everything.
    eq(page.localStorageWorks, true, 'localStorage is available on the custom scheme');

    console.log('\n-- it writes the data folder outside programs read --');
    // Drive real graded decisions, then confirm they reach disk.
    await win.webContents.executeJavaScript(`(function () {
        const gm = window.BJ.instance.gameManager;
        gm.setGameMode('hard');
        for (let i = 0; i < 5; i++) { gm.startRound(); gm.playerStand(); }
        return window.BJ.DesktopSync.flush(true);
    })()`);
    await wait(600);

    const storePath = path.join(scratch, 'store.json');
    const snapPath = path.join(scratch, 'snapshot.json');
    eq(fs.existsSync(storePath), true, 'store.json was written');
    eq(fs.existsSync(snapPath), true, 'snapshot.json was written');

    const snap = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
    eq(typeof snap.player.level, 'number', 'snapshot carries a player level');
    // EXACTLY five. A >= here would pass just as happily on a leaked profile,
    // which is precisely the bug that isolation exists to prevent.
    eq(snap.stats.lifetime.decisions, 5, 'exactly the 5 graded decisions reached disk (proves a clean profile)');
    eq(Array.isArray(snap.ladder) && snap.ladder.length === 5, true, 'snapshot carries all 5 ladder stages');

    const store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    eq(Object.keys(store.kv).some((k) => k.startsWith('junto_blackjack_')), true, 'store.json mirrors the real kv keys');
    eq(fs.readdirSync(scratch).filter((n) => n.endsWith('.tmp')).length, 0, 'no orphaned temp files after a healthy write');

    console.log('\n-- every asset the page asks for actually resolves --');
    // A missing asset under app:// is invisible in a passing boot: the page
    // still loads, the engine still runs, and an icon or a font is quietly
    // gone. Listing them is the only way this fails for the real reason.
    // audio.js has always pointed at five .wav files that do not exist in this
    // repo — public/assets/ is not there and never was, so the sound setting
    // is a switch wired to nothing. That is a real PRE-EXISTING bug rather
    // than anything the desktop shell introduced; it is named here instead of
    // ignored so this check still fails the moment a NEW asset goes missing.
    const KNOWN_MISSING = ['card', 'chip', 'shuffle', 'win', 'loss']
        .map((n) => `/assets/sounds/${n}.wav`);
    const isKnownGap = (u) => KNOWN_MISSING.some((k) => u.endsWith(k));

    const offline = failedRequests.filter((r) => /^https?:/i.test(r.url));
    const known = failedRequests.filter((r) => !/^https?:/i.test(r.url) && isKnownGap(r.url));
    const local = failedRequests.filter((r) => !/^https?:/i.test(r.url) && !isKnownGap(r.url));
    if (known.length) console.log(`       (${known.length} request(s) for the never-shipped sound files — known gap, see audio.js)`);
    if (local.length) local.forEach((r) => console.log('       missing: ' + r.url + '  (' + r.error + ')'));
    eq(local.length, 0, 'no app:// request failed');
    if (offline.length) console.log(`       (${offline.length} remote request(s) failed — expected when offline: ${offline.map((r) => r.url).join(', ')})`);

    // Chromium keeps files inside userData open for as long as the process
    // lives, so this cannot fully succeed before app.exit and must not be
    // allowed to fail the run over it. Whatever is left is in %TEMP%.
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* the OS will get it */ }

    console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll checks passed.');
    app.exit(failures ? 1 : 0);
});
