// ==========================================
// stats-render.js — the Stats tab: accuracy charts, mistake heatmap, and
// the mistake log.
//
// All visuals are hand-rolled DOM/SVG — no chart library. That's deliberate:
// the game code has no bundler, the app must work offline (PWA/Capacitor),
// and a CDN chart lib would break both.
//
// Reads through BJ.Storage's typed accessors (getLifetimeStats /
// getMistakeLog / getAccuracyHistory) rather than raw .get() calls, since
// those are the schema-aware entry points persistence.js exposes.
//
// `render(container)` takes an explicit container so the hub's Stats tab and
// (historically) a modal can share one renderer.
// ==========================================

(function (root) {
    'use strict';

    var BJ = (typeof window !== 'undefined')
        ? (window.BJ = window.BJ || {})
        : (root.BJ = root.BJ || {});

    var Storage = BJ.Storage || (typeof module !== 'undefined' ? require('./persistence.js') : undefined);

    var MODE_LABELS = {
        testout: 'Play (Full Game)',
        hard: 'Hard Totals',
        pairs: 'Pairs',
        soft: 'Soft Totals',
        deviations: 'Illustrious 18',
        surrender: 'Surrender',
        targeted: 'Targeted Practice',
        'count-running': 'Running Count Checks',
        'count-true': 'True Count Checks',
        'count-speed': 'Speed Count',
        estimation: 'Deck Estimation'
    };

    var DEALER_COLS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
    var TREND_WINDOW = 10;   // decisions per rolling-average point
    var HEATMAP_ROW_CAP = 12; // keep the "weak spots" view focused + on-screen

    function el(tag, className, text) {
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined && text !== null) node.textContent = text;
        return node;
    }

    function svgEl(tag, attrs) {
        var node = document.createElementNS('http://www.w3.org/2000/svg', tag);
        Object.keys(attrs || {}).forEach(function (k) { node.setAttribute(k, attrs[k]); });
        return node;
    }

    function pct(correct, total) {
        if (!total) return null;
        return Math.round((correct / total) * 100);
    }

    function section(title) {
        var s = el('div', 'stats-section');
        s.appendChild(el('h3', 'stats-section-title', title));
        return s;
    }

    // ------------------------------------------------------------------
    // 1. Headline + accuracy-by-category bars
    // ------------------------------------------------------------------

    function buildAccuracySection(lifetime) {
        var s = section('Lifetime Accuracy');

        var overall = pct(lifetime.decisionsCorrect, lifetime.decisionsTotal);
        var head = el('div', 'stats-headline');
        head.appendChild(el('span', 'stats-headline__value', overall === null ? '—' : overall + '%'));
        head.appendChild(el('span', 'stats-headline__note',
            lifetime.decisionsTotal ? lifetime.decisionsCorrect + ' / ' + lifetime.decisionsTotal + ' decisions' : 'No decisions yet'));
        s.appendChild(head);

        var byMode = lifetime.byMode || {};
        // Only modes actually played — an all-zero list of every mode is
        // noise, not information.
        var rows = Object.keys(MODE_LABELS)
            .map(function (mode) {
                var b = byMode[mode] || { total: 0, correct: 0 };
                return { mode: mode, total: b.total, correct: b.correct, accuracy: pct(b.correct, b.total) };
            })
            .filter(function (r) { return r.total > 0; })
            .sort(function (a, b) { return a.accuracy - b.accuracy; }); // worst first — that's the actionable end

        if (!rows.length) {
            s.appendChild(el('div', 'stats-empty', 'Play a hand or run a drill and your accuracy shows up here.'));
            return s;
        }

        var chart = el('div', 'bar-chart');
        rows.forEach(function (r) {
            var row = el('div', 'bar-row');
            row.appendChild(el('span', 'bar-row__label', MODE_LABELS[r.mode] || r.mode));

            var track = el('div', 'bar-row__track');
            var fill = el('div', 'bar-row__fill');
            fill.style.width = r.accuracy + '%';
            // Colour by competence, not by category — the eye should jump to
            // what's weak.
            fill.classList.add(r.accuracy >= 90 ? 'bar--good' : (r.accuracy >= 70 ? 'bar--mid' : 'bar--bad'));
            track.appendChild(fill);
            row.appendChild(track);

            row.appendChild(el('span', 'bar-row__value', r.accuracy + '%'));
            row.title = r.correct + ' / ' + r.total + ' correct';
            chart.appendChild(row);
        });
        s.appendChild(chart);
        return s;
    }

    // ------------------------------------------------------------------
    // 2. Accuracy over time (rolling average)
    // ------------------------------------------------------------------

    function buildTrendSection(history) {
        var s = section('Accuracy Over Time');

        if (history.length < TREND_WINDOW) {
            s.appendChild(el('div', 'stats-empty',
                'Needs at least ' + TREND_WINDOW + ' decisions to plot a trend (' + history.length + ' so far).'));
            return s;
        }

        // Rolling average over the last TREND_WINDOW decisions at each point.
        var points = [];
        for (var i = TREND_WINDOW - 1; i < history.length; i++) {
            var hits = 0;
            for (var j = i - TREND_WINDOW + 1; j <= i; j++) if (history[j].correct) hits++;
            points.push(hits / TREND_WINDOW);
        }

        var W = 100, H = 40;
        // preserveAspectRatio="none" lets the chart stretch to any container
        // width; non-scaling-stroke stops that stretch from smearing the
        // line thickness.
        var svg = svgEl('svg', {
            class: 'trend-chart',
            viewBox: '0 0 ' + W + ' ' + H,
            preserveAspectRatio: 'none',
            role: 'img',
            'aria-label': 'Rolling accuracy over your last ' + history.length + ' decisions'
        });

        [0, 0.5, 1].forEach(function (frac) {
            svg.appendChild(svgEl('line', {
                x1: 0, x2: W, y1: H - frac * H, y2: H - frac * H,
                class: 'trend-grid', 'vector-effect': 'non-scaling-stroke'
            }));
        });

        var coords = points.map(function (p, idx) {
            var x = points.length === 1 ? W : (idx / (points.length - 1)) * W;
            return x.toFixed(2) + ',' + (H - p * H).toFixed(2);
        });

        // Filled area under the line, then the line itself.
        svg.appendChild(svgEl('polygon', {
            class: 'trend-area',
            points: '0,' + H + ' ' + coords.join(' ') + ' ' + W + ',' + H
        }));
        svg.appendChild(svgEl('polyline', {
            class: 'trend-line',
            points: coords.join(' '),
            'vector-effect': 'non-scaling-stroke'
        }));

        var wrap = el('div', 'trend-wrap');
        wrap.appendChild(svg);
        s.appendChild(wrap);

        var latest = Math.round(points[points.length - 1] * 100);
        var first = Math.round(points[0] * 100);
        var delta = latest - first;
        var caption = el('div', 'trend-caption');
        caption.appendChild(el('span', null, 'Now ' + latest + '%'));
        caption.appendChild(el('span', 'trend-delta ' + (delta >= 0 ? 'trend-delta--up' : 'trend-delta--down'),
            (delta >= 0 ? '▲ +' : '▼ ') + delta + '% since ' + points.length + ' decisions ago'));
        s.appendChild(caption);

        return s;
    }

    // ------------------------------------------------------------------
    // 3. Mistake heatmap (hand x dealer upcard)
    // ------------------------------------------------------------------

    function handLabel(type, total) {
        if (type === 'pair') return total === 11 ? 'A,A' : total + ',' + total;
        if (type === 'soft') return 'Soft ' + total;
        return 'Hard ' + total;
    }

    function buildHeatmapSection(mistakeLog) {
        var s = section('Weak Spots');

        // Only hand mistakes can be placed on a hand x dealer grid — count
        // checks and estimation misses have no hand/upcard.
        var hands = mistakeLog.filter(function (e) {
            return e && e.handType && e.handTotal != null && e.dealerUpcard != null;
        });

        if (!hands.length) {
            s.appendChild(el('div', 'stats-empty', 'No hand mistakes logged — nothing to target yet.'));
            return s;
        }

        // rowKey -> { type, total, byDealer: {dealer: count}, total misses }
        var rows = new Map();
        var max = 0;
        hands.forEach(function (e) {
            var key = e.handType + '_' + e.handTotal;
            var row = rows.get(key);
            if (!row) { row = { type: e.handType, total: e.handTotal, byDealer: {}, misses: 0 }; rows.set(key, row); }
            row.byDealer[e.dealerUpcard] = (row.byDealer[e.dealerUpcard] || 0) + 1;
            row.misses++;
            if (row.byDealer[e.dealerUpcard] > max) max = row.byDealer[e.dealerUpcard];
        });

        // Worst first, and capped — this is a "where am I leaking" view, not
        // an exhaustive matrix of every hand in blackjack.
        var ordered = Array.from(rows.values()).sort(function (a, b) { return b.misses - a.misses; });
        var shown = ordered.slice(0, HEATMAP_ROW_CAP);

        var table = el('table', 'heatmap');
        var thead = el('thead');
        var hr = el('tr');
        hr.appendChild(el('th', 'heatmap__corner', ''));
        DEALER_COLS.forEach(function (d) { hr.appendChild(el('th', null, d === 11 ? 'A' : String(d))); });
        thead.appendChild(hr);
        table.appendChild(thead);

        var tbody = el('tbody');
        shown.forEach(function (row) {
            var tr = el('tr');
            tr.appendChild(el('th', 'heatmap__row-label', handLabel(row.type, row.total)));
            DEALER_COLS.forEach(function (d) {
                var count = row.byDealer[d] || 0;
                var td = el('td', 'heatmap__cell', count ? String(count) : '');
                if (count) {
                    // 0.18 floor so a single miss is still visible; scaled to
                    // the worst cell so the hottest spot always reads as hot.
                    var intensity = 0.18 + 0.82 * (count / max);
                    td.style.background = 'rgba(229, 84, 90, ' + intensity.toFixed(2) + ')';
                    td.classList.add('heatmap__cell--hit');
                    td.title = handLabel(row.type, row.total) + ' vs ' + (d === 11 ? 'A' : d) + ' — missed ' + count + 'x';
                }
                tr.appendChild(td);
            });
            tbody.appendChild(tr);
        });
        table.appendChild(tbody);

        var wrap = el('div', 'heatmap-wrap');
        wrap.appendChild(table);
        s.appendChild(wrap);

        if (ordered.length > HEATMAP_ROW_CAP) {
            s.appendChild(el('div', 'stats-note',
                'Showing your ' + HEATMAP_ROW_CAP + ' worst hands of ' + ordered.length + '.'));
        }
        s.appendChild(el('div', 'stats-note', 'Darker = missed more often. Run Targeted Practice to drill these.'));

        return s;
    }

    // ------------------------------------------------------------------
    // 4. Mistake log
    // ------------------------------------------------------------------

    function formatTimestamp(ts) {
        try { return new Date(ts).toLocaleString(); } catch (err) { return ''; }
    }

    function buildMistakeLogSection(mistakeLog) {
        var s = section('Mistake Log');
        var list = el('div', 'stats-mistake-list');

        if (!mistakeLog.length) {
            list.appendChild(el('div', 'stats-mistake-empty', 'No mistakes logged yet — keep it that way.'));
        } else {
            mistakeLog.slice().reverse().forEach(function (entry) {
                var row = el('div', 'stats-mistake-row');
                row.appendChild(el('span', 'stats-mistake-time', formatTimestamp(entry.timestamp)));
                row.appendChild(el('span', 'stats-mistake-mode', MODE_LABELS[entry.mode] || entry.mode));
                row.appendChild(el('span', 'stats-mistake-hand',
                    entry.dealerUpcard != null
                        ? entry.handDescription + ' vs ' + (entry.dealerUpcard === 11 ? 'A' : entry.dealerUpcard)
                        : entry.handDescription));
                if (entry.trueCount !== null && entry.trueCount !== undefined) {
                    row.appendChild(el('span', 'stats-mistake-tc', 'TC ' + (entry.trueCount >= 0 ? '+' : '') + entry.trueCount));
                }
                row.appendChild(el('span', 'stats-mistake-you', 'You: ' + entry.playerAction));
                row.appendChild(el('span', 'stats-mistake-correct', 'Correct: ' + entry.correctAction));
                list.appendChild(row);
            });
        }

        s.appendChild(list);
        return s;
    }

    function buildClearHistoryButton(onCleared) {
        var btn = el('button', 'stats-clear-history-btn', 'Clear History');
        btn.type = 'button';
        btn.addEventListener('click', function () {
            var confirmed = (typeof window !== 'undefined' && typeof window.confirm === 'function')
                ? window.confirm('This permanently deletes your lifetime accuracy, mistake log, and hand history from this device. Continue?')
                : false;
            if (!confirmed) return;

            // Reset via persistence.js's own default shape rather than a
            // second hand-maintained copy — that copy had already drifted
            // once (it predated the counting modes).
            Storage.set('stats_lifetime', Storage.defaultStatsBucket());
            Storage.set('mistake_log', []);
            Storage.set('hand_history', []);
            Storage.set('accuracy_history', []);

            if (typeof onCleared === 'function') onCleared();
        });
        return btn;
    }

    var StatsRender = {
        render(container) {
            if (typeof document === 'undefined') return false;
            var host = container
                || document.getElementById('hub-stats-body')
                || document.getElementById('stats-modal-body');
            if (!host || !Storage) return false;

            host.innerHTML = '';

            var lifetime = Storage.getLifetimeStats();
            var mistakeLog = Storage.getMistakeLog();
            var history = Storage.getAccuracyHistory();

            host.appendChild(buildAccuracySection(lifetime));
            host.appendChild(buildTrendSection(history));
            host.appendChild(buildHeatmapSection(mistakeLog));
            host.appendChild(buildMistakeLogSection(mistakeLog));
            host.appendChild(buildClearHistoryButton(function () { StatsRender.render(host); }));

            return true;
        }
    };

    BJ.StatsRender = StatsRender;

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = StatsRender;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this);
