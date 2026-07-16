// ==========================================
// stats-render.js — lifetime stats / mistake-log modal (Phase C, net-new,
// plan §3.4)
//
// Renders into an assumed `#stats-modal` container (guarded — no-ops if it
// doesn't exist yet, since the HTML phase hasn't added it). Reads through
// `BJ.Storage`'s typed accessors (`getLifetimeStats()` / `getMistakeLog()`)
// rather than raw `.get('stats_lifetime', ...)` calls directly, since those
// accessors are the documented, schema-aware entry points persistence.js
// already exposes for this exact shape — going around them would just be
// re-deriving the same fallback defaults in a second place.
// ==========================================

(function (root) {
    'use strict';

    var BJ = (typeof window !== 'undefined')
        ? (window.BJ = window.BJ || {})
        : (root.BJ = root.BJ || {});

    var Storage = BJ.Storage || (typeof module !== 'undefined' ? require('./persistence.js') : undefined);

    var MODE_LABELS = {
        testout: 'Test Out (Full Play)',
        hard: 'Hard Totals',
        pairs: 'Pairs',
        soft: 'Soft Totals',
        deviations: 'Illustrious 18',
        surrender: 'Surrender'
    };

    function el(tag, className, text) {
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined && text !== null) node.textContent = text;
        return node;
    }

    function pct(correct, total) {
        if (!total) return null;
        return Math.round((correct / total) * 100);
    }

    function buildAccuracySection(lifetime) {
        var section = el('div', 'stats-section stats-accuracy');
        section.appendChild(el('h3', 'stats-section-title', 'Lifetime Accuracy'));

        var overall = pct(lifetime.decisionsCorrect, lifetime.decisionsTotal);
        var overallRow = el('div', 'stats-row stats-row-overall');
        overallRow.appendChild(el('span', 'stats-row-label', 'Overall'));
        overallRow.appendChild(el('span', 'stats-row-value', overall === null ? '—' : (overall + '% (' + lifetime.decisionsCorrect + '/' + lifetime.decisionsTotal + ')')));
        section.appendChild(overallRow);

        var byMode = lifetime.byMode || {};
        Object.keys(MODE_LABELS).forEach(function (mode) {
            var bucket = byMode[mode] || { total: 0, correct: 0 };
            var accuracy = pct(bucket.correct, bucket.total);
            var row = el('div', 'stats-row');
            row.appendChild(el('span', 'stats-row-label', MODE_LABELS[mode]));
            row.appendChild(el('span', 'stats-row-value', accuracy === null ? '—' : (accuracy + '% (' + bucket.correct + '/' + bucket.total + ')')));
            section.appendChild(row);
        });

        return section;
    }

    function formatTimestamp(ts) {
        try {
            return new Date(ts).toLocaleString();
        } catch (err) {
            return '';
        }
    }

    function buildMistakeLogSection(mistakeLog) {
        var section = el('div', 'stats-section stats-mistake-log');
        section.appendChild(el('h3', 'stats-section-title', 'Mistake Log'));

        var list = el('div', 'stats-mistake-list'); // scrollable via CSS phase

        if (!mistakeLog.length) {
            list.appendChild(el('div', 'stats-mistake-empty', 'No mistakes logged yet — keep it that way.'));
        } else {
            // Most recent first.
            mistakeLog.slice().reverse().forEach(function (entry) {
                var row = el('div', 'stats-mistake-row');
                row.appendChild(el('span', 'stats-mistake-time', formatTimestamp(entry.timestamp)));
                row.appendChild(el('span', 'stats-mistake-mode', MODE_LABELS[entry.mode] || entry.mode));
                row.appendChild(el('span', 'stats-mistake-hand', entry.handDescription + ' vs ' + entry.dealerUpcard));
                if (entry.trueCount !== null && entry.trueCount !== undefined) {
                    row.appendChild(el('span', 'stats-mistake-tc', 'TC ' + (entry.trueCount >= 0 ? '+' : '') + entry.trueCount));
                }
                row.appendChild(el('span', 'stats-mistake-you', 'You: ' + entry.playerAction));
                row.appendChild(el('span', 'stats-mistake-correct', 'Correct: ' + entry.correctAction));
                list.appendChild(row);
            });
        }

        section.appendChild(list);
        return section;
    }

    function buildClearHistoryButton(onCleared) {
        var btn = el('button', 'stats-clear-history-btn', 'Clear History');
        btn.type = 'button';
        btn.addEventListener('click', function () {
            var confirmed = (typeof window !== 'undefined' && typeof window.confirm === 'function')
                ? window.confirm('This permanently deletes your lifetime accuracy, mistake log, and hand history from this device. Continue?')
                : false;
            if (!confirmed) return;

            // Reset to fresh, empty shapes — matches persistence.js's own
            // default bucket shape so nothing downstream sees an
            // unexpected undefined field.
            Storage.set('stats_lifetime', {
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
            });
            Storage.set('mistake_log', []);
            Storage.set('hand_history', []);

            if (typeof onCleared === 'function') onCleared();
        });
        return btn;
    }

    var StatsRender = {
        /**
         * Clears and rebuilds `#stats-modal`'s content container
         * (`#stats-modal-body` if present, else the modal root itself)
         * from the current persisted lifetime stats + mistake log.
         */
        render() {
            var host = (typeof document !== 'undefined')
                ? (document.getElementById('stats-modal-body') || document.getElementById('stats-modal'))
                : null;
            if (!host || !Storage) return false;

            host.innerHTML = '';

            var lifetime = Storage.getLifetimeStats();
            var mistakeLog = Storage.getMistakeLog();

            host.appendChild(buildAccuracySection(lifetime));
            host.appendChild(buildMistakeLogSection(mistakeLog));
            host.appendChild(buildClearHistoryButton(function () { StatsRender.render(); }));

            return true;
        }
    };

    BJ.StatsRender = StatsRender;

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = StatsRender;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this);

// ==========================================
// NEW element ids required:
//   #stats-modal              (modal root — show/hide wired in ui-bindings.js)
//   #stats-modal-body         (preferred render target; falls back to
//                              #stats-modal itself if absent)
//   #btn-open-stats / #btn-close-stats (wired in ui-bindings.js, not here)
//
// NEW classes assumed by the CSS phase:
//   .stats-section, .stats-section-title, .stats-accuracy, .stats-row,
//   .stats-row-overall, .stats-row-label, .stats-row-value,
//   .stats-mistake-log, .stats-mistake-list (scrollable), .stats-mistake-empty,
//   .stats-mistake-row, .stats-mistake-time, .stats-mistake-mode,
//   .stats-mistake-hand, .stats-mistake-tc, .stats-mistake-you,
//   .stats-mistake-correct, .stats-clear-history-btn
// ==========================================
