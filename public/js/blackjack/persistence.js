// ==========================================
// persistence.js — localStorage wrapper (plan §3.2)
//
// Replaces the ad hoc `localStorage.getItem('junto_blackjack_bankroll')` /
// `setItem` calls scattered in the old monolith (blackjack.js:280-281,
// 488) with a single schema-versioned, JSON-encoded, try/catch-guarded
// accessor. All future persistence (settings, stats, mistake log, hand
// history) goes through this file — never touch `localStorage` directly
// from game-manager.js/render.js/ui-bindings.js.
// ==========================================

(function (root) {
    'use strict';

    var BJ = (typeof window !== 'undefined')
        ? (window.BJ = window.BJ || {})
        : (root.BJ = root.BJ || {});

    const KEY_PREFIX = 'junto_blackjack_';
    const SCHEMA_VERSION = 1;

    // Ring-buffer caps (plan §3.2 / §3.4).
    const MISTAKE_LOG_CAP = 200;
    const HAND_HISTORY_CAP = 200;

    function hasLocalStorage() {
        return typeof localStorage !== 'undefined' && localStorage !== null;
    }

    function defaultSettings() {
        return {
            casualMode: false,
            freeplay: false,
            hideTotals: false,
            disableBanner: false,
            soundEnabled: false,
            gameSpeed: 600
        };
    }

    function defaultStatsBucket() {
        return {
            startedAt: null,
            decisionsTotal: 0,
            decisionsCorrect: 0,
            byMode: {
                testout: { total: 0, correct: 0 },
                hard: { total: 0, correct: 0 },
                pairs: { total: 0, correct: 0 },
                soft: { total: 0, correct: 0 },
                deviations: { total: 0, correct: 0 },
                surrender: { total: 0, correct: 0 }
            }
        };
    }

    const Storage = {
        KEY_PREFIX,
        SCHEMA_VERSION,
        MISTAKE_LOG_CAP,
        HAND_HISTORY_CAP,

        /**
         * Reads `KEY_PREFIX + key` from localStorage, JSON-parsed. Returns
         * `fallback` on any error (missing key, malformed JSON, storage
         * unavailable — e.g. private browsing, SSR/Node, quota errors).
         */
        get(key, fallback) {
            if (!hasLocalStorage()) return fallback;
            try {
                const raw = localStorage.getItem(KEY_PREFIX + key);
                if (raw === null || raw === undefined) return fallback;
                const parsed = JSON.parse(raw);
                return parsed === null || parsed === undefined ? fallback : parsed;
            } catch (err) {
                return fallback;
            }
        },

        /**
         * Writes `value` (JSON-encoded) to `KEY_PREFIX + key`. Swallows
         * errors (e.g. quota exceeded, storage unavailable) rather than
         * throwing — persistence is a nice-to-have, never a hard dependency.
         */
        set(key, value) {
            if (!hasLocalStorage()) return false;
            try {
                localStorage.setItem(KEY_PREFIX + key, JSON.stringify(value));
                return true;
            } catch (err) {
                return false;
            }
        },

        // --- Convenience typed accessors for the documented key shapes ---

        getBankroll(fallback = 10000) {
            return this.get('bankroll', fallback);
        },
        setBankroll(amount) {
            return this.set('bankroll', amount);
        },

        getSettings() {
            return Object.assign(defaultSettings(), this.get('settings', {}));
        },
        setSettings(settings) {
            return this.set('settings', Object.assign(defaultSettings(), settings));
        },

        getSessionStats() {
            return this.get('stats_session', defaultStatsBucket());
        },
        setSessionStats(stats) {
            return this.set('stats_session', stats);
        },

        getLifetimeStats() {
            return this.get('stats_lifetime', defaultStatsBucket());
        },
        setLifetimeStats(stats) {
            return this.set('stats_lifetime', stats);
        },

        getMistakeLog() {
            return this.get('mistake_log', []);
        },
        /**
         * Pushes one entry onto the mistake log ring buffer, trimming to
         * MISTAKE_LOG_CAP from the front (oldest entries drop first).
         */
        pushMistake(entry) {
            const log = this.getMistakeLog();
            log.push(entry);
            while (log.length > MISTAKE_LOG_CAP) log.shift();
            this.set('mistake_log', log);
            return log;
        },

        getHandHistory() {
            return this.get('hand_history', []);
        },
        /**
         * Pushes one entry onto the hand history ring buffer, trimming to
         * HAND_HISTORY_CAP from the front (oldest entries drop first).
         */
        pushHandHistory(entry) {
            const history = this.getHandHistory();
            history.push(entry);
            while (history.length > HAND_HISTORY_CAP) history.shift();
            this.set('hand_history', history);
            return history;
        },

        /**
         * No-op upgrade path stub. Reads `schema_version`; if absent or
         * lower than SCHEMA_VERSION, future migration steps go in the
         * `if (version < N)` ladder below, then the version is bumped and
         * saved. At SCHEMA_VERSION = 1 there is nothing to migrate yet —
         * this just seeds the key so future versions have something to
         * compare against.
         */
        migrate() {
            const version = this.get('schema_version', 0);

            if (version < 1) {
                // Placeholder for the 0 -> 1 migration (none needed yet;
                // v1 is the first shape). Future migrations append here,
                // e.g.:
                // if (version < 2) { ... transform old shape ... }
            }

            if (version !== SCHEMA_VERSION) {
                this.set('schema_version', SCHEMA_VERSION);
            }

            return SCHEMA_VERSION;
        }
    };

    BJ.Storage = Storage;

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = Storage;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this);
