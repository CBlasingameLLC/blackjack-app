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

// The four designated scroll wells, duplicated from desktop.css §11 — and the
// two lists MUST match. Content in these is genuinely unbounded (a mistake log
// has no maximum length), so each is a bounded card, fully on screen, that
// scrolls inside itself with no visible scrollbar. Anything ELSE that
// overflows is a layout that did not fit, which is what the walk below is for.
const WELLS = [
    '.stats-mistake-list',
    '.heatmap-wrap',
    '[data-section="accuracy"] .bar-chart',
    '#reference-modal-body'
];

// Runs inside the page. Reports every rendered element whose content is bigger
// than its box — whether it scrolls, clips, or spills — because all three mean
// the same thing to a player: something is not on screen.
// POSITIONING ANCHORS, not containers. #table-bet-area exists to give the bet
// ring, the chip stack and the bet bubble a common origin; the bubble sits
// beside the ring by design, so the anchor "overflows" every time a bet is
// placed. Matched on the element ITSELF, never via closest(), so everything
// inside it is still checked individually — an anchor is allowed to be spilled
// out of, its children are not allowed to leave the screen.
const ANCHORS = ['#table-bet-area'];

const OVERFLOW_PROBE = `(function (wells, anchors) {
    const isWell = (el) => wells.some((w) => el.matches(w) || el.closest(w));
    const isAnchor = (el) => anchors.some((a) => el.matches(a));
    const bad = [];
    // 4px of slack: sub-pixel layout rounding on a fractional-DPI display
    // reports a pixel of phantom overflow on perfectly fine boxes, and a test
    // that cries wolf gets muted.
    const SLACK = 4;
    document.querySelectorAll('#main-menu *, #blackjack-container *, #count-drill-container *').forEach((el) => {
        if (!el.clientHeight && !el.clientWidth) return;   // not rendered
        if (isWell(el) || isAnchor(el)) return;
        const dy = el.scrollHeight - el.clientHeight;
        const dx = el.scrollWidth - el.clientWidth;
        if (dy > SLACK || dx > SLACK) {
            const cls = (typeof el.className === 'string' && el.className.trim())
                ? '.' + el.className.trim().split(/\\s+/).join('.')
                : '';
            bad.push({
                sel: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + cls,
                dy: dy > SLACK ? dy : 0,
                dx: dx > SLACK ? dx : 0
            });
        }
    });
    const doc = document.scrollingElement;
    return {
        bad: bad.slice(0, 12),
        count: bad.length,
        pageScrolls: doc.scrollHeight - doc.clientHeight > SLACK || doc.scrollWidth - doc.clientWidth > SLACK
    };
})`;

const probeCall = `(${OVERFLOW_PROBE})(${JSON.stringify(WELLS)}, ${JSON.stringify(ANCHORS)})`;

// A SECOND, DIFFERENT QUESTION: is every rendered thing actually INSIDE the
// screen it belongs to. The overflow probe above compares scrollHeight to
// clientHeight, and that has a real blind spot — a <table> whose rows exceed
// its box does not report it, so a strategy chart could lose its bottom four
// rows and the run would stay green. This measures boxes instead: every
// descendant's rect must sit inside the panel's rect. It cannot be fooled by
// an element that declines to report its own overflow.
const CONTAINMENT_PROBE = `(function (wells) {
    const panel = document.querySelector('.hub-panel.active');
    if (!panel) return { ok: false, reason: 'no active panel', out: [] };
    const box = panel.getBoundingClientRect();
    const SLACK = 4;
    const out = [];
    panel.querySelectorAll('*').forEach((el) => {
        // Inside a well, sitting outside the visible box is the POINT — that
        // content is reachable by scrolling the well.
        if (wells.some((w) => el.closest(w))) return;
        const cs = getComputedStyle(el);
        if (cs.position === 'fixed' || cs.display === 'none' || cs.visibility === 'hidden') return;
        const r = el.getBoundingClientRect();
        if (!r.width && !r.height) return;
        const over = [];
        if (r.bottom > box.bottom + SLACK) over.push('below by ' + Math.round(r.bottom - box.bottom));
        if (r.right  > box.right  + SLACK) over.push('right by ' + Math.round(r.right - box.right));
        if (r.top    < box.top    - SLACK) over.push('above by ' + Math.round(box.top - r.top));
        if (r.left   < box.left   - SLACK) over.push('left by ' + Math.round(box.left - r.left));
        if (over.length) {
            const cls = (typeof el.className === 'string' && el.className.trim())
                ? '.' + el.className.trim().split(/\s+/)[0] : '';
            out.push({ sel: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + cls, why: over.join(', ') });
        }
    });
    return { ok: out.length === 0, count: out.length, out: out.slice(0, 8) };
})`;

const containCall = `(${CONTAINMENT_PROBE})(${JSON.stringify(WELLS)})`;

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

    // ----------------------------------------------------------- the reskin
    console.log('\n-- the desktop skin is actually in force --');
    // A class name that styles nothing is a bug the markup cannot show you, so
    // this reads the COMPUTED token rather than looking for the class. If
    // desktop.css failed to load, .is-desktop-app would still be on <html> and
    // every assertion about it would pass against the phone layout.
    const skin = await win.webContents.executeJavaScript(`(function () {
        const cs = getComputedStyle(document.documentElement);
        const norm = (v) => (v || '').trim().toLowerCase();
        return {
            flagged: document.documentElement.classList.contains('is-desktop-app'),
            sheetLoaded: Array.from(document.styleSheets).some((s) => (s.href || '').endsWith('/css/desktop.css')),
            accent: norm(cs.getPropertyValue('--gold')),
            money: norm(cs.getPropertyValue('--money')),
            railW: norm(cs.getPropertyValue('--rail-w'))
        };
    })()`);
    eq(skin.flagged, true, 'the desktop class reached <html> before first paint');
    eq(skin.sheetLoaded, true, 'desktop.css actually loaded');
    // The identity swap: the accent is ice, and gold survives as money only.
    eq(skin.accent, '#6fd8ee', 'the accent token was remapped to the desktop ice');
    eq(skin.money, '#e3c16f', 'gold survives under its own name, for money');
    eq(skin.railW, '216px', 'the rail-width token is defined');

    console.log('\n-- the bottom bar became a LEFT RAIL --');
    // Measured, not counted. Five nav buttons exist in both layouts; what makes
    // this a rail is that they stack at the window's left edge, and only
    // geometry can tell those two apart.
    await win.webContents.executeJavaScript(`window.BJ.Hub.showHub('path')`);
    await wait(250);
    const rail = await win.webContents.executeJavaScript(`(function () {
        const nav = document.querySelector('.hub__nav');
        const body = document.querySelector('.hub__body');
        const tabs = Array.from(document.querySelectorAll('.hub-tab'));
        const r = nav.getBoundingClientRect();
        const b = body.getBoundingClientRect();
        const boxes = tabs.map((t) => t.getBoundingClientRect());
        return {
            left: Math.round(r.left),
            width: Math.round(r.width),
            tallerThanWide: r.height > r.width * 2,
            stacked: boxes.every((x, i) => i === 0 || x.top >= boxes[i - 1].bottom - 1),
            sameColumn: boxes.every((x) => Math.round(x.left) === Math.round(boxes[0].left)),
            everyTabHasLabel: tabs.every((t) => {
                const span = t.querySelector('span');
                if (!span || !span.textContent.trim()) return false;
                const sr = span.getBoundingClientRect();
                return sr.width > 0 && sr.height > 0;
            }),
            contentStartsAfterRail: b.left >= r.right - 1
        };
    })()`);
    eq(rail.left, 0, 'the rail is pinned to the left edge');
    eq(rail.width, 216, 'it is exactly the rail-width token wide');
    eq(rail.tallerThanWide, true, 'it runs the full height rather than across the foot');
    eq(rail.stacked, true, 'the destinations stack vertically');
    eq(rail.sameColumn, true, 'and share one column');
    // Icon + label, with real measured size. A zero-width label is present in
    // the DOM and invisible on screen, which is how .expand shipped 0px wide
    // for two releases in the sibling project.
    eq(rail.everyTabHasLabel, true, 'every destination renders a label with real size beside its icon');
    eq(rail.contentStartsAfterRail, true, 'content begins where the rail ends — nothing is underneath it');

    console.log('\n-- 1280x800 of CONTENT is a real floor, not an aspiration --');
    // minWidth/minHeight are WINDOW sizes. main.js measures the frame and
    // raises them, and this is the check that the arithmetic actually landed.
    const [minW, minH] = win.getMinimumSize();
    const [winW, winH] = win.getSize();
    const [cw, ch] = win.getContentSize();
    const contentMinW = minW - (winW - cw);
    const contentMinH = minH - (winH - ch);
    eq(contentMinW >= 1280, true, `the window cannot be narrowed below 1280 of page (${contentMinW})`);
    eq(contentMinH >= 800, true, `nor shortened below 800 of page (${contentMinH})`);

    console.log('\n-- NOTHING SCROLLS at the floor --');
    win.setContentSize(1280, 800);
    await wait(350);

    // THE DETECTOR PROVES ITSELF FIRST. Every assertion below is a green line
    // when nothing is wrong, and a probe that silently stopped working looks
    // exactly the same — which is how a strategy chart could lose four rows to
    // a table's refusal to report its own overflow and the run stayed green.
    // So: plant something that unmistakably does not fit, confirm BOTH probes
    // see it, and only then trust the walk.
    await win.webContents.executeJavaScript(`window.BJ.Hub.selectTab('path')`);
    await wait(250);
    const canary = await win.webContents.executeJavaScript(`(function () {
        const panel = document.querySelector('.hub-panel.active');
        const d = document.createElement('div');
        d.id = '__canary';
        d.style.cssText = 'height:2000px;width:2000px;position:relative';
        panel.appendChild(d);
        return true;
    })()`);
    eq(canary, true, 'planted an element that cannot possibly fit');
    const caughtOverflow = await win.webContents.executeJavaScript(probeCall);
    const caughtContain = await win.webContents.executeJavaScript(containCall);
    eq(caughtOverflow.count > 0, true, 'the overflow probe reports it');
    eq(caughtContain.ok, false, 'the containment probe reports it too');
    await win.webContents.executeJavaScript(`document.getElementById('__canary').remove()`);
    await wait(200);

    for (const tab of ['path', 'practice', 'charts', 'stats', 'profile']) {
        await win.webContents.executeJavaScript(`window.BJ.Hub.selectTab('${tab}')`);
        await wait(250);
        const r = await win.webContents.executeJavaScript(probeCall);
        if (r.count) r.bad.forEach((b) => console.log(`       overflows on ${tab}: ${b.sel}  (+${b.dy}px down, +${b.dx}px across)`));
        eq(r.count, 0, `nothing on the ${tab} screen overflows its box`);
        eq(r.pageScrolls, false, `the ${tab} screen itself does not scroll`);

        const c = await win.webContents.executeJavaScript(containCall);
        if (!c.ok) c.out.forEach((b) => console.log(`       escapes the ${tab} panel: ${b.sel}  (${b.why})`));
        eq(c.ok, true, `and everything on ${tab} is drawn inside the panel`);
    }

    // The table is its own screen and gets the same treatment, with a real hand
    // on it — an empty felt has nothing to collide with and would pass whatever
    // the layout did.
    await win.webContents.executeJavaScript(`(function () {
        const gm = window.BJ.instance.gameManager;
        gm.setGameMode('testout');
        gm.setBet(25, { replace: true });
        gm.startRound();
    })()`);
    await wait(700);
    const table = await win.webContents.executeJavaScript(probeCall);
    if (table.count) table.bad.forEach((b) => console.log(`       overflows at the table: ${b.sel}  (+${b.dy}px down, +${b.dx}px across)`));
    eq(table.count, 0, 'nothing at the table overflows its box');
    eq(table.pageScrolls, false, 'the table screen does not scroll');

    // THE TABLE'S OWN GEOMETRY. Neither probe above can see this: the zones and
    // the dashboard are siblings that do not report each other's overflow, so
    // a hand dealt half-under the action bar is invisible to scrollHeight and
    // to a containment walk of the hub. It has to be asked directly, because
    // a card you cannot fully see is the single worst thing this screen can do
    // — it is the card you are being graded on.
    const felt = await win.webContents.executeJavaScript(`(function () {
        const r = (sel) => { const e = document.querySelector(sel); return e && e.getBoundingClientRect(); };
        // The CARD ELEMENTS, not the row that holds them: the row can be
        // shrunk below the cards and still report a box that clears the bar.
        const cardEls = Array.from(document.querySelectorAll('#player-cards .playing-card'));
        const cards = cardEls.length
            ? { bottom: Math.max.apply(null, cardEls.map((c) => c.getBoundingClientRect().bottom)) }
            : r('#player-cards');
        const dash = r('#action-dashboard');
        const dealer = r('#dealer-cards');
        const bar = r('#blackjack-container .topbar');
        const anyCard = document.querySelector('#player-cards .card, #player-cards > *');
        return {
            dealt: cardEls.length > 0,
            playerBottom: Math.round(cards.bottom),
            dashTop: Math.round(dash.top),
            dealerTop: Math.round(dealer.top),
            barBottom: Math.round(bar.bottom),
            viewportH: window.innerHeight
        };
    })()`);
    eq(felt.dealt, true, 'a hand is actually on the table for this measurement');
    eq(felt.playerBottom <= felt.dashTop, true,
        `the player's cards finish above the action bar (cards end ${felt.playerBottom}, bar starts ${felt.dashTop})`);
    eq(felt.dealerTop >= felt.barBottom, true,
        `the dealer's cards start below the top bar (cards start ${felt.dealerTop}, bar ends ${felt.barBottom})`);

    // The 340px companion rail held two "coming soon" cards for features that
    // have since shipped elsewhere; the table takes that width back.
    const reclaimed = await win.webContents.executeJavaScript(`(function () {
        const railEl = document.getElementById('desktop-rail');
        const box = document.getElementById('blackjack-container').getBoundingClientRect();
        return {
            railHidden: getComputedStyle(railEl).display === 'none',
            tableRight: Math.round(box.right),
            viewport: window.innerWidth
        };
    })()`);
    eq(reclaimed.railHidden, true, 'the stale "coming soon" companion rail is not rendered');
    eq(reclaimed.tableRight, reclaimed.viewport, 'and the table reaches the right edge it used to give up');

    await win.webContents.executeJavaScript(`window.BJ.Hub.showHub('path')`);
    await wait(200);

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

    // Nothing in this app should reach the network at all any more. Font
    // Awesome was the last remote dependency and it is now served from the
    // bundle, so a remote request here is a regression, not an inconvenience.
    const iconFont = await win.webContents.executeJavaScript(`(function () {
        const probe = document.querySelector('.hub-tab .icon');
        const before = getComputedStyle(probe, ':before');
        return {
            // The family lives on the PSEUDO-element (base.css sets it on
            // .icon:before); the <i> itself inherits the UI font, so reading
            // the element reports Inter and says nothing about the icon.
            family: before.fontFamily,
            glyph: before.content,
            // A missing webfont still reports the family it was asked for, so
            // the only honest check is whether the glyph actually has width.
            drawn: probe.getBoundingClientRect().width > 4,
            loaded: document.fonts.check('900 1em "Font Awesome 5 Free"')
        };
    })()`);
    eq(/Font Awesome/.test(iconFont.family), true, 'rail icons ask for the Font Awesome family');
    eq(iconFont.loaded, true, 'the solid webfont is loaded from the bundle');
    eq(iconFont.drawn, true, 'and the glyph actually renders with width');

    const offline = failedRequests.filter((r) => /^https?:/i.test(r.url));
    const known = failedRequests.filter((r) => !/^https?:/i.test(r.url) && isKnownGap(r.url));
    const local = failedRequests.filter((r) => !/^https?:/i.test(r.url) && !isKnownGap(r.url));
    if (known.length) console.log(`       (${known.length} request(s) for the never-shipped sound files — known gap, see audio.js)`);
    if (local.length) local.forEach((r) => console.log('       missing: ' + r.url + '  (' + r.error + ')'));
    eq(local.length, 0, 'no app:// request failed');
    if (offline.length) offline.forEach((r) => console.log('       remote: ' + r.url + '  (' + r.error + ')'));
    eq(offline.length, 0, 'the app made no remote request at all — it is fully offline');

    // Chromium keeps files inside userData open for as long as the process
    // lives, so this cannot fully succeed before app.exit and must not be
    // allowed to fail the run over it. Whatever is left is in %TEMP%.
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* the OS will get it */ }

    console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll checks passed.');
    app.exit(failures ? 1 : 0);
});
