// ==========================================
// desktop-sync.js — mirrors the player's data out to ~/.blackjack-pro/ so
// outside programs can read it.
//
// SHARED FILE, DOUBLE-GATED. This ships in the web and mobile builds too and
// does nothing at all in them: every path below is behind `window.bjDesktop`,
// which only the Electron preload defines. Keeping it in the shared app is
// what lets the desktop build stay a shell with no engine copy of its own.
//
// DIRECTION OF TRAVEL. localStorage stays the live store — the engine reads
// and writes it exactly as it always has, on every platform. This file only
// ever copies OUT of it. The restore direction (a fresh machine reading
// store.json back IN) happens in the preload, before any engine code runs,
// because an async restore racing boot.js would hand the game an empty store
// and then silently overwrite the real one with it.
//
// WRITES ARE DRIVEN BY CHANGE, NOT BY THE CLOCK. The snapshot is fingerprinted
// and only sent when the fingerprint moves. A timer that rewrites two files
// every few seconds regardless would turn an idle app into a disk-churning
// one, and would tell any watcher that something happened when nothing did.
// ==========================================

(function (root) {
    'use strict';

    var BJ = (typeof window !== 'undefined')
        ? (window.BJ = window.BJ || {})
        : (root.BJ = root.BJ || {});

    var SYNC_INTERVAL_MS = 4000;
    var PREFIX = 'junto_blackjack_';

    function bridge() {
        return (typeof window !== 'undefined' && window.bjDesktop) ? window.bjDesktop : null;
    }

    /** Every junto_blackjack_* key, verbatim — values stay serialized strings. */
    function collectKV() {
        var kv = {};
        if (typeof localStorage === 'undefined') return kv;
        try {
            for (var i = 0; i < localStorage.length; i++) {
                var key = localStorage.key(i);
                if (key && key.indexOf(PREFIX) === 0) kv[key] = localStorage.getItem(key);
            }
        } catch (err) { /* private mode / blocked storage — nothing to mirror */ }
        return kv;
    }

    function accuracyOf(bucket) {
        if (!bucket || !bucket.decisionsTotal) return null;
        return Math.round((bucket.decisionsCorrect / bucket.decisionsTotal) * 100);
    }

    /**
     * Built here in the renderer, from the same BJ.Storage and BJ.Gamification
     * the screens render from — never recomputed in the main process. That is
     * the whole reason a number a script reads cannot disagree with the number
     * the player is looking at.
     */
    function buildSnapshot() {
        var Storage = BJ.Storage, Gam = BJ.Gamification;
        if (!Storage || !Gam) return null;

        var progression = Storage.getProgression();
        var lifetime = Storage.getLifetimeStats();
        var session = Storage.getSessionStats();
        var ladder = Gam.getLadderStatus();
        var challenge = null;
        try { challenge = Gam.describeChallenge(Gam.getTodayChallenge()); } catch (err) { challenge = null; }

        return {
            player: {
                level: Gam.getLevel(progression.xp),
                xp: progression.xp,
                xpIntoLevel: Gam.getXPIntoLevel(progression.xp),
                xpForThisLevel: Gam.getXPPerLevel(progression.xp),
                rank: ladder.rankTitle,
                currentStreak: progression.currentStreak,
                bestStreak: progression.bestStreak,
                stagesMastered: ladder.masteredCount,
                currentStageId: ladder.currentStageId
            },
            ladder: ladder.stages,
            stats: {
                lifetime: {
                    decisions: lifetime.decisionsTotal || 0,
                    correct: lifetime.decisionsCorrect || 0,
                    accuracy: accuracyOf(lifetime),
                    byMode: lifetime.byMode || {}
                },
                session: {
                    decisions: session.decisionsTotal || 0,
                    correct: session.decisionsCorrect || 0,
                    accuracy: accuracyOf(session),
                    byMode: session.byMode || {}
                }
            },
            // Raw per-decision points, not a pre-aggregated rollup: an outside
            // program can then pick its own window without needing this file
            // to have guessed the right one.
            trends: { decisions: Storage.getAccuracyHistory() },
            achievements: Storage.getAchievements(),
            challenge: challenge,
            mistakes: Storage.getMistakeLog(),
            bankroll: Storage.getBankroll(),
            settings: Storage.getSettings()
        };
    }

    var lastPrint = null;
    var timer = null;

    function flush(force) {
        var api = bridge();
        if (!api) return false;
        var snapshot = buildSnapshot();
        if (!snapshot) return false;

        var kv = collectKV();
        var print;
        try { print = JSON.stringify(snapshot) + '|' + JSON.stringify(kv); } catch (err) { return false; }
        if (!force && print === lastPrint) return false;
        lastPrint = print;

        try {
            api.save({ kv: kv, snapshot: snapshot });
        } catch (err) { /* a failed mirror must never interrupt a hand */ }
        return true;
    }

    var DesktopSync = {
        isActive: function () { return !!bridge(); },
        buildSnapshot: buildSnapshot,
        flush: flush,

        start: function () {
            if (!bridge() || timer) return false;
            timer = setInterval(function () { flush(false); }, SYNC_INTERVAL_MS);
            // 'pagehide' rather than 'beforeunload': it is the one that
            // reliably fires on a window close, and losing the last few
            // seconds of a session is exactly what the interval cannot catch.
            if (typeof window !== 'undefined') {
                window.addEventListener('pagehide', function () { flush(false); });
                document.addEventListener('visibilitychange', function () {
                    if (document.visibilityState === 'hidden') flush(false);
                });
            }
            flush(true);
            return true;
        }
    };

    BJ.DesktopSync = DesktopSync;

    if (typeof window !== 'undefined') {
        window.addEventListener('load', function () { DesktopSync.start(); });
    }

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = DesktopSync;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this);
