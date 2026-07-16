// ==========================================
// reference-render.js — Strategy Library modal, rendered FROM BJ.StrategyData
// (Phase C, plan §2 bug #11 / §6's "reference modal must be data-driven, not
// stale HTML" verification item)
//
// The old blackjack.html hand-authored the entire reference modal
// (blackjack.html:34-118) as static markup that could silently drift from
// the actual `Strategy` object the engine used to grade decisions. This
// file builds every cell of every table via real DOM APIs, reading
// directly from `BJ.StrategyData` (the single source of truth strategy-
// engine.js also reads from) — so the modal is provably in sync with what
// the game actually grades, not a second hand-copied source of truth.
//
// Renders into `#reference-modal-body`, an assumed-empty container inside
// the existing `#reference-modal` (guarded — no-ops entirely if that
// container doesn't exist yet, since the HTML phase hasn't added it).
// ==========================================

(function (root) {
    'use strict';

    var BJ = (typeof window !== 'undefined')
        ? (window.BJ = window.BJ || {})
        : (root.BJ = root.BJ || {});

    var StrategyData = BJ.StrategyData || (typeof module !== 'undefined' ? require('./strategy-data.js') : undefined);

    var DEALER_HEADERS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'A'];

    // Play code -> full label, used for a legend and for cell title attrs.
    var PLAY_LABELS = {
        H: 'Hit', S: 'Stand', D: 'Double (else Hit)', Ds: 'Double (else Stand)',
        P: 'Split', R: 'Surrender (else Hit)'
    };

    function el(tag, className, text) {
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined && text !== null) node.textContent = text;
        return node;
    }

    function actionClass(code) {
        return 'action-' + (code || '').replace(/[^A-Za-z]/g, '');
    }

    /**
     * Builds one strategy table: `rows` is an array of { key, label } where
     * `key` indexes into `dataTable` (StrategyData.hard/soft/pair), each
     * value a 10-length array aligned to DEALER_HEADERS.
     */
    function buildGridTable(title, dataTable, rows) {
        var wrapper = el('div', 'reference-table-wrapper');
        wrapper.appendChild(el('h3', 'reference-table-title', title));

        var table = el('table', 'reference-table');
        var thead = el('thead');
        var headRow = el('tr');
        headRow.appendChild(el('th', 'reference-row-label', ''));
        DEALER_HEADERS.forEach(function (h) { headRow.appendChild(el('th', null, h)); });
        thead.appendChild(headRow);
        table.appendChild(thead);

        var tbody = el('tbody');
        rows.forEach(function (row) {
            var tr = el('tr');
            tr.appendChild(el('th', 'reference-row-label', row.label));
            var plays = dataTable[row.key];
            DEALER_HEADERS.forEach(function (_, idx) {
                var code = plays ? plays[idx] : '';
                var td = el('td', actionClass(code), code);
                if (PLAY_LABELS[code]) td.title = PLAY_LABELS[code];
                tr.appendChild(td);
            });
            tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        wrapper.appendChild(table);
        return wrapper;
    }

    function buildHardTable() {
        var rows = Object.keys(StrategyData.hard)
            .map(Number)
            .sort(function (a, b) { return a - b; })
            .map(function (total) { return { key: total, label: String(total) }; });
        return buildGridTable('Hard Totals', StrategyData.hard, rows);
    }

    function buildSoftTable() {
        var rows = Object.keys(StrategyData.soft)
            .map(Number)
            .sort(function (a, b) { return a - b; })
            .map(function (total) { return { key: total, label: 'A,' + (total - 11) }; });
        return buildGridTable('Soft Totals', StrategyData.soft, rows);
    }

    function buildPairTable() {
        var rows = Object.keys(StrategyData.pair)
            .map(Number)
            .sort(function (a, b) { return a - b; })
            .map(function (pairVal) {
                var label = pairVal === 11 ? 'A,A' : (pairVal + ',' + pairVal);
                return { key: pairVal, label: label };
            });
        return buildGridTable('Pairs', StrategyData.pair, rows);
    }

    /**
     * Surrender is a sparse { total: { dealerValue: true } } shape, not a
     * 10-wide array — rendered as a simple two-column list instead of the
     * grid layout the other three tables use.
     */
    function buildSurrenderTable() {
        var wrapper = el('div', 'reference-table-wrapper');
        wrapper.appendChild(el('h3', 'reference-table-title', 'Late Surrender (hard totals only)'));

        var table = el('table', 'reference-table reference-table-surrender');
        var thead = el('thead');
        var headRow = el('tr');
        headRow.appendChild(el('th', null, 'Hand'));
        headRow.appendChild(el('th', null, 'Surrender vs.'));
        thead.appendChild(headRow);
        table.appendChild(thead);

        var tbody = el('tbody');
        Object.keys(StrategyData.surrender)
            .map(Number)
            .sort(function (a, b) { return a - b; })
            .forEach(function (total) {
                var dealerVals = Object.keys(StrategyData.surrender[total])
                    .map(Number)
                    .sort(function (a, b) { return a - b; })
                    .map(function (v) { return v === 11 ? 'A' : String(v); });
                var tr = el('tr');
                tr.appendChild(el('th', 'reference-row-label', 'Hard ' + total));
                var td = el('td', actionClass('R'), dealerVals.join(', '));
                tr.appendChild(td);
                tbody.appendChild(tr);
            });
        table.appendChild(tbody);
        wrapper.appendChild(table);
        return wrapper;
    }

    /**
     * Illustrious 18 (+ Fab 4 surrender indices + insurance) deviation
     * list. Each StrategyData.deviations entry is { tc, dev, base } keyed
     * by `<type>_<total>_<dealerValue>` (or the special `insurance` key) —
     * parsed back into a human row: hand, dealer card, TC threshold,
     * deviated play.
     */
    function describeDeviationKey(key) {
        if (key === 'insurance') {
            return { hand: 'Insurance (dealer shows Ace)', dealer: '—' };
        }
        var parts = key.split('_'); // [type, total, dealerValue]
        var type = parts[0], total = parts[1], dealerValue = Number(parts[2]);
        var dealerLabel = dealerValue === 11 ? 'A' : String(dealerValue);
        var handLabel;
        if (type === 'hard') handLabel = 'Hard ' + total;
        else if (type === 'soft') handLabel = 'Soft ' + total;
        else if (type === 'pair') handLabel = (Number(total) === 11 ? 'A,A' : total + ',' + total);
        else if (type === 'surrender') handLabel = 'Hard ' + total + ' (surrender index)';
        else handLabel = key;
        return { hand: handLabel, dealer: dealerLabel };
    }

    function buildDeviationsTable() {
        var wrapper = el('div', 'reference-table-wrapper');
        wrapper.appendChild(el('h3', 'reference-table-title', 'Illustrious 18 & Fab 4 Deviations'));

        var table = el('table', 'reference-table reference-table-deviations');
        var thead = el('thead');
        var headRow = el('tr');
        ['Hand', 'Dealer Shows', 'True Count', 'Play'].forEach(function (h) {
            headRow.appendChild(el('th', null, h));
        });
        thead.appendChild(headRow);
        table.appendChild(thead);

        var tbody = el('tbody');
        Object.keys(StrategyData.deviations).forEach(function (key) {
            var entry = StrategyData.deviations[key];
            var described = describeDeviationKey(key);
            var tr = el('tr');
            tr.appendChild(el('td', null, described.hand));
            tr.appendChild(el('td', null, described.dealer));
            tr.appendChild(el('td', null, (entry.tc >= 0 ? '+' : '') + entry.tc + ' or higher'));
            var playCode = entry.dev === 'buy' ? 'Buy Insurance' : (PLAY_LABELS[entry.dev] || entry.dev);
            var playTd = el('td', actionClass(entry.dev), playCode);
            tr.appendChild(playTd);
            tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        wrapper.appendChild(table);
        return wrapper;
    }

    var ReferenceRender = {
        /**
         * Clears and rebuilds `#reference-modal-body` from the live
         * StrategyData object. Safe to call repeatedly (e.g. re-render on
         * modal open) — always a full, idempotent rebuild since this is a
         * rarely-opened reference view, not a hot render path (unlike the
         * card table, which must never rebuild).
         */
        render() {
            var container = (typeof document !== 'undefined') ? document.getElementById('reference-modal-body') : null;
            if (!container) return false;
            container.innerHTML = '';
            container.appendChild(buildHardTable());
            container.appendChild(buildSoftTable());
            container.appendChild(buildPairTable());
            container.appendChild(buildSurrenderTable());
            container.appendChild(buildDeviationsTable());
            return true;
        }
    };

    BJ.ReferenceRender = ReferenceRender;

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = ReferenceRender;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this);

// ==========================================
// NEW element id required: #reference-modal-body (empty container inside
// the existing #reference-modal for this file to render into — the HTML
// phase should delete the old hand-authored table markup at
// blackjack.html:34-118 and replace it with this one empty div).
//
// NEW classes this file assumes will be styled by the CSS phase:
//   .reference-table-wrapper, .reference-table-title, .reference-table,
//   .reference-row-label, .reference-table-surrender,
//   .reference-table-deviations, .action-H, .action-S, .action-D,
//   .action-Ds, .action-P, .action-R, .action-buy
// ==========================================
